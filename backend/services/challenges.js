'use strict';
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { dbGet, dbRun, dbAll } = require('../models/db');
const discord = require('./discord');
const twitch  = require('./twitch');
const se      = require('./streamelements');
const notify  = require('./notify');
const T       = require('./time');

// ── Rangs ──────────────────────────────────────────────────────────────────────
// Le rang dépend des points CUMULÉS (lifetime_points) : dépenser ses points en
// boutique ne fait pas redescendre de palier.
const RANKS = [
  { id: 'bronze', min: 0 },
  { id: 'silver', min: 10000 },
  { id: 'gold',   min: 20000 },
];
function rankFor(lifetime) {
  let r = RANKS[0];
  for (const x of RANKS) if (lifetime >= x.min) r = x;
  return r.id;
}
function nextRank(lifetime) {
  const n = RANKS.find(x => x.min > lifetime);
  return n ? { id: n.id, min: n.min, remaining: n.min - lifetime } : null;
}

function updateRank(userId) {
  const u = dbGet('SELECT lifetime_points, rank FROM users WHERE id=?', [userId]);
  if (!u) return;
  const rank = rankFor(u.lifetime_points);
  if (rank === u.rank) return;
  dbRun('UPDATE users SET rank=? WHERE id=?', [rank, userId]);
  discord.syncRoleForUser(userId).catch(() => {});
}

// Journal de tous les mouvements de points (historique, classement du mois)
function logPoints(userId, delta, reason, label = null) {
  if (delta) dbRun('INSERT INTO points_log (user_id,delta,reason,label) VALUES (?,?,?,?)', [userId, delta, reason, label]);
}
// Points gagnés : comptent pour le rang (lifetime_points)
function addPoints(userId, pts, reason = 'challenge', label = null) {
  if (!pts || pts <= 0) return;
  dbRun("UPDATE users SET points=points+?, lifetime_points=lifetime_points+?, last_seen=datetime('now') WHERE id=?", [pts, pts, userId]);
  logPoints(userId, pts, reason, label);
  updateRank(userId);
}
function removePoints(userId, pts, reason = 'revoke', label = null) {
  if (!pts || pts <= 0) return;
  dbRun('UPDATE users SET points=MAX(0,points-?), lifetime_points=MAX(0,lifetime_points-?) WHERE id=?', [pts, pts, userId]);
  logPoints(userId, -pts, reason, label);
  updateRank(userId);
}

// Formate les secondes en texte lisible (30 min, 1h, 1h 30min…)
function fmtSecs(s) {
  if (!s) return '0 min';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

// ── Entrées user_challenges ────────────────────────────────────────────────────
function getPeriodKey(ch) { return T.periodKey(ch.repeat_seconds); }

function getEntry(userId, challengeId, periodKey) {
  return dbGet(
    "SELECT * FROM user_challenges WHERE user_id=? AND challenge_id=? AND IFNULL(period_key,'')=IFNULL(?,'')",
    [userId, challengeId, periodKey]);
}
function isAlreadyDone(userId, challengeId, periodKey) {
  return getEntry(userId, challengeId, periodKey)?.verified === 1;
}
function markDone(userId, challengeId, verified = 1, periodKey = null, screenshotPath = null) {
  dbRun('INSERT OR IGNORE INTO user_challenges (user_id,challenge_id,verified,period_key,screenshot_path) VALUES (?,?,?,?,?)',
    [userId, challengeId, verified, periodKey, screenshotPath]);
}

// Valide un challenge pour la période courante et attribue les points UNE seule fois.
// Retourne true si les points ont été attribués.
function completeChallenge(userId, ch, periodKey = getPeriodKey(ch), note = null) {
  const entry = getEntry(userId, ch.id, periodKey);
  if (entry?.verified === 1) return false;
  if (entry) {
    dbRun("UPDATE user_challenges SET verified=1, completed_at=datetime('now'), admin_note=COALESCE(?,admin_note) WHERE id=?", [note, entry.id]);
  } else {
    dbRun('INSERT INTO user_challenges (user_id,challenge_id,verified,period_key,admin_note) VALUES (?,?,1,?,?)',
      [userId, ch.id, periodKey, note]);
  }
  addPoints(userId, ch.points, 'challenge', ch.name);
  // Parrainage (1er défi du filleul) + badges
  try { require('./loyalty').afterEvent(userId, 'challenge'); } catch (e) { console.warn('[loyalty]', e.message); }
  return true;
}

// ── Progression des challenges automatiques ────────────────────────────────────
const AUTO_TYPES = ['messages', 'vocal', 'invite', 'watchtime'];

function required(ch) {
  // Un challenge d'invitation sans seuil = 1 invitation
  if (ch.type === 'invite') return Math.max(1, ch.required_value || 0);
  return ch.required_value || 0;
}

// Progression sur la période courante du challenge (ou depuis toujours s'il est permanent)
function getProgress(userId, ch) {
  const start = T.periodStart(ch.repeat_seconds);
  const req = required(ch);
  if (ch.type === 'messages' || ch.type === 'vocal') {
    const col = ch.type === 'messages' ? 'messages' : 'vocal_seconds';
    const from = start ? T.parisDate(start) : '0000-00-00';
    const cur = dbGet(`SELECT COALESCE(SUM(${col}),0) AS t FROM discord_activity WHERE user_id=? AND date>=?`, [userId, from])?.t || 0;
    return { current: cur, required: req };
  }
  if (ch.type === 'invite') {
    return { current: discord.getInviteCount(userId, start ? T.toSql(start) : null), required: req };
  }
  if (ch.type === 'watchtime') {
    const from = start ? T.toSql(start) : '0000-00-00';
    const cur = dbGet('SELECT COALESCE(SUM(seconds),0) AS t FROM twitch_watch_sessions WHERE user_id=? AND started_at>=?', [userId, from])?.t || 0;
    return { current: cur, required: req };
  }
  return null;
}

// Valide automatiquement les challenges atteints (appelé après activité Discord, sync SE…)
// opts.types  : limite aux types donnés
// opts.inGuild: l'utilisateur est confirmé membre du serveur → valide aussi "join"
function autoCheck(userId, opts = {}) {
  const types = opts.types || AUTO_TYPES;
  const list = dbAll('SELECT * FROM challenges WHERE active=1');
  let awarded = 0;
  for (const ch of list) {
    if (ch.type === 'join') {
      if (opts.inGuild && completeChallenge(userId, ch)) awarded += ch.points;
      continue;
    }
    if (!types.includes(ch.type)) continue;
    const pk = getPeriodKey(ch);
    if (isAlreadyDone(userId, ch.id, pk)) continue;
    const p = getProgress(userId, ch);
    if (p && p.required > 0 && p.current >= p.required && completeChallenge(userId, ch, pk)) {
      awarded += ch.points;
      console.log(`[Challenges] "${ch.name}" auto-validé pour user ${userId} (+${ch.points} pts)`);
    }
  }
  return awarded;
}

// Tout screenshot est vérifié par l'équipe (sur Discord ou dans l'admin du site) :
// une image validée automatiquement ne prouve rien.
function needsAdminReview(ch) {
  return ch.type === 'screen';
}

const UPLOADS = path.join(__dirname, '../../frontend/public/uploads');
const removeUpload = p => { if (p) fs.unlink(path.join(UPLOADS, path.basename(p)), () => {}); };

// Crée (ou réutilise) une demande en attente et la signale aux admins sur Discord
function createPending(userId, ch, pk, screenshotPath = null) {
  let entry = getEntry(userId, ch.id, pk);
  if (entry) {
    if (screenshotPath) dbRun("UPDATE user_challenges SET screenshot_path=?, completed_at=datetime('now') WHERE id=?", [screenshotPath, entry.id]);
  } else {
    markDone(userId, ch.id, 0, pk, screenshotPath);
    entry = getEntry(userId, ch.id, pk);
  }
  // Nouveau screen → l'ancien message Discord est remplacé par un nouveau
  if (entry.discord_msg_id && screenshotPath) notify.deletePendingMessage(entry.discord_msg_id).catch(() => {});
  if (!entry.discord_msg_id || screenshotPath) notify.sendPendingToAdmins(entry.id).catch(() => {});
  return entry;
}

// Validation / refus d'une demande en attente (depuis le site ou les boutons Discord)
function approvePending(entryId, { note = null, by = 'admin' } = {}) {
  const entry = dbGet('SELECT * FROM user_challenges WHERE id=?', [entryId]);
  if (!entry) return { ok: false, message: 'Demande introuvable.' };
  if (entry.verified === 1) return { ok: false, message: 'Déjà validé.' };
  const ch = dbGet('SELECT * FROM challenges WHERE id=?', [entry.challenge_id]);
  if (!ch) return { ok: false, message: 'Challenge supprimé.' };
  completeChallenge(entry.user_id, ch, entry.period_key, note);
  removeUpload(entry.screenshot_path);
  dbRun('UPDATE user_challenges SET screenshot_path=NULL WHERE id=?', [entry.id]);
  notify.resolvePendingMessage(entry.discord_msg_id, true, by).catch(() => {});
  notify.notifyResult(entry.user_id, ch, true, note);
  return { ok: true, message: `+${ch.points} pts attribués.`, userId: entry.user_id, challenge: ch };
}
function rejectPending(entryId, { note = null, by = 'admin' } = {}) {
  const entry = dbGet('SELECT * FROM user_challenges WHERE id=? AND verified=0', [entryId]);
  if (!entry) return { ok: false, message: 'Demande introuvable ou déjà traitée.' };
  const ch = dbGet('SELECT * FROM challenges WHERE id=?', [entry.challenge_id]);
  removeUpload(entry.screenshot_path);
  dbRun('DELETE FROM user_challenges WHERE id=?', [entry.id]);
  notify.resolvePendingMessage(entry.discord_msg_id, false, by).catch(() => {});
  if (ch) notify.notifyResult(entry.user_id, ch, false, note);
  return { ok: true, message: 'Rejeté.' };
}

// ── Redirection + timer ────────────────────────────────────────────────────────
function initiateRedirect(userId, challengeId) {
  const token = crypto.randomBytes(16).toString('hex');
  // Nettoie les anciens tokens non utilisés de ce user pour ce challenge
  dbRun('DELETE FROM pending_redirects WHERE user_id=? AND challenge_id=? AND validated_at IS NULL', [userId, challengeId]);
  dbRun('INSERT INTO pending_redirects (user_id,challenge_id,token) VALUES (?,?,?)', [userId, challengeId, token]);
  return token;
}

function validateRedirectTimer(userId, token) {
  const p = dbGet('SELECT * FROM pending_redirects WHERE token=? AND user_id=? AND validated_at IS NULL', [token, userId]);
  if (!p) return { ok: false, message: 'Token invalide ou déjà utilisé.' };
  const ch = dbGet('SELECT * FROM challenges WHERE id=? AND active=1', [p.challenge_id]);
  if (!ch) return { ok: false, message: 'Challenge introuvable.' };
  const delay = ch.redirect_delay || 20;
  const elapsed = Math.floor((Date.now() - T.fromSql(p.created_at).getTime()) / 1000);
  if (elapsed < delay - 3)
    return { ok: false, message: `Attends encore ${delay - elapsed} secondes.` };
  dbRun("UPDATE pending_redirects SET validated_at=datetime('now') WHERE id=?", [p.id]);
  if (!completeChallenge(userId, ch)) return { ok: false, message: 'Déjà complété !' };
  return { ok: true, message: `+${ch.points} pts ! Challenge "${ch.name}" validé ✅`, points: ch.points };
}

// ── Screenshot ─────────────────────────────────────────────────────────────────
// Retourne { ok, ... , keepFile } — keepFile=false si le fichier doit être supprimé
function submitScreenshot(userId, challengeId, filePath) {
  const ch = dbGet('SELECT * FROM challenges WHERE id=? AND active=1', [challengeId]);
  if (!ch || ch.type !== 'screen')
    return { ok: false, keepFile: false, message: 'Ce challenge ne se valide pas par screenshot.' };
  const pk = getPeriodKey(ch);
  const entry = getEntry(userId, ch.id, pk);
  if (entry?.verified === 1)
    return { ok: false, keepFile: false, message: pk ? 'Déjà fait pour cette période !' : 'Déjà complété !' };

  if (!needsAdminReview(ch)) {
    // Validation automatique à la réception du screen (les points ne sont donnés qu'une fois)
    completeChallenge(userId, ch, pk);
    return { ok: true, keepFile: false, message: `✅ Screenshot reçu ! +${ch.points} pts attribués.` };
  }

  // Validation admin : remplace un éventuel ancien screen en attente
  const old = entry?.screenshot_path;
  createPending(userId, ch, pk, filePath);
  return { ok: true, pending: true, keepFile: true, replaced: old,
    message: '📸 Screenshot envoyé ! L\'admin K13 validera sous 24h.' };
}

// ── Vérification manuelle (bouton "Valider") ───────────────────────────────────
async function verifyChallenge(userId, slug) {
  const user = dbGet('SELECT * FROM users WHERE id=?', [userId]);
  const ch   = dbGet('SELECT * FROM challenges WHERE slug=? AND active=1', [slug]);
  if (!user || !ch) return { ok: false, message: 'Challenge introuvable.' };
  const pk = getPeriodKey(ch);
  const entry = getEntry(userId, ch.id, pk);
  if (entry?.verified === 1)
    return { ok: false, message: pk ? 'Déjà fait pour cette période !' : 'Déjà complété !' };

  // ── Screenshot : le client ouvre la fenêtre d'upload ─────────────────────
  if (ch.type === 'screen') {
    return { ok: false, screen: true, needsScreen: true, challengeId: ch.id, challengeName: ch.name,
      requireAdmin: needsAdminReview(ch), openUrl: ch.redirect_url || null,
      message: entry?.screenshot_path ? '📸 Un screen est déjà en attente. Tu peux en renvoyer un.' : '📸 Envoie un screenshot pour valider ce défi.' };
  }

  // ── Redirection + timer ─────────────────────────────────────────────────
  if (ch.type === 'redirect') {
    if (!ch.redirect_url) return { ok: false, message: 'Lien manquant, contacte un admin.' };
    // Défis X / Instagram : le membre renseigne d'abord son @ (pas de vérification, sert à l'équipe)
    const handle = { twitter: 'twitter_username', instagram: 'instagram_username' }[ch.platform];
    if (handle && !user[handle])
      return { ok: false, needsHandle: ch.platform, message: `Ajoute d'abord ton @${ch.platform === 'twitter' ? 'X' : 'Instagram'} dans « Comptes liés ».` };
    const token = initiateRedirect(userId, ch.id);
    return { ok: false, redirect: true, url: ch.redirect_url, token,
      delay: ch.redirect_delay || 20, challengeName: ch.name, challengeId: ch.id };
  }

  // ── Twitch follow (API) ─────────────────────────────────────────────────
  if (ch.type === 'follow' || ch.slug === 'twitch-follow') {
    if (!user.twitch_id || !user.twitch_token)
      return { ok: false, message: 'Lie ton compte Twitch.', needsLink: 'twitch' };
    try {
      const follows = await twitch.checkFollow(userId);
      if (!follows) return { ok: false, message: 'Tu ne suis pas encore la chaîne Twitch K13. Suis-la puis réessaie.',
        openUrl: ch.redirect_url || `https://www.twitch.tv/${process.env.TWITCH_CHANNEL_LOGIN || 'k13esport'}` };
    } catch (e) {
      return { ok: false, message: 'Erreur Twitch : ' + e.message };
    }
    completeChallenge(userId, ch, pk);
    return { ok: true, message: `+${ch.points} pts ! Follow Twitch vérifié ✅`, points: ch.points };
  }

  // ── Discord : rejoindre le serveur ──────────────────────────────────────
  if (ch.type === 'join') {
    if (!user.discord_id) return { ok: false, message: 'Connecte ton Discord.', needsLink: 'discord' };
    const ok = await discord.checkGuildMember(user.discord_id).catch(() => false);
    if (!ok) return { ok: false, message: 'Tu n\'es pas encore dans le serveur Discord K13.' };
    completeChallenge(userId, ch, pk);
    return { ok: true, message: `+${ch.points} pts ! Bienvenue sur le Discord K13 🎉`, points: ch.points };
  }

  // ── Challenges à seuil (messages, vocal, invitations, watchtime) ────────
  if (AUTO_TYPES.includes(ch.type)) {
    if (ch.type === 'watchtime') {
      if (!user.twitch_id) return { ok: false, message: 'Lie ton compte Twitch d\'abord.', needsLink: 'twitch' };
      await se.syncWatchtimeForUser(userId, { force: true }).catch(() => {});
    } else if (!user.discord_id) {
      return { ok: false, message: 'Connecte ton Discord.', needsLink: 'discord' };
    }
    const p = getProgress(userId, ch);
    if (p.current < p.required) {
      const isTime = ch.type === 'watchtime' || ch.type === 'vocal';
      const cur = isTime ? fmtSecs(p.current) : p.current;
      const left = isTime ? fmtSecs(p.required - p.current) : p.required - p.current;
      const label = { messages: 'messages envoyés', vocal: 'en vocal', invite: 'invitation(s)', watchtime: 'regardés' }[ch.type];
      return { ok: false, message: `${cur} ${label}. Encore ${left}.`, progress: p };
    }
    completeChallenge(userId, ch, pk);
    return { ok: true, message: `+${ch.points} pts ! "${ch.name}" validé ✅`, points: ch.points };
  }

  return { ok: false, message: `Type de challenge "${ch.type}" non géré. Contacte l'admin.` };
}

// ── Données du tableau de bord ─────────────────────────────────────────────────
function getUserStats(userId) {
  const user = dbGet('SELECT * FROM users WHERE id=?', [userId]);
  if (!user) return null;
  const challenges = dbAll('SELECT * FROM challenges WHERE active=1 ORDER BY category,platform,points');
  const entries = dbAll('SELECT challenge_id, period_key, verified, screenshot_path FROM user_challenges WHERE user_id=?', [userId]);
  const byKey = new Map(entries.map(e => [`${e.challenge_id}|${e.period_key || ''}`, e]));

  const list = challenges.map(c => {
    const pk = getPeriodKey(c);
    const e = byKey.get(`${c.id}|${pk || ''}`);
    const completed = e?.verified === 1;
    return {
      id: c.id, slug: c.slug, platform: c.platform, name: c.name, description: c.description,
      points: c.points, type: c.type, category: c.category, repeat_seconds: c.repeat_seconds,
      redirect_url: c.redirect_url, redirect_delay: c.redirect_delay,
      completed,
      pending: e?.verified === 0,
      screenshotPending: e?.verified === 0 && !!e.screenshot_path,
      progress: completed ? null : getProgress(userId, c),
      resetsAt: pk ? nextPeriodIso(c.repeat_seconds) : null,
    };
  });
  const done = list.filter(c => c.completed).length;

  return {
    user: { id: user.id, username: user.username, points: user.points, lifetime_points: user.lifetime_points,
      rank: user.rank, nextRank: nextRank(user.lifetime_points),
      discord_id: user.discord_id, discord_username: user.discord_username, discord_avatar: user.discord_avatar,
      twitch_login: user.twitch_login, twitch_id: user.twitch_id, epic_username: user.epic_username,
      twitter_username: user.twitter_username, instagram_username: user.instagram_username,
      notify_dm: !!user.notify_dm },
    challenges: list,
    progression: { done, total: list.length, pct: list.length ? Math.round(done / list.length * 100) : 0 },
    activity: {
      watchSec:  dbGet('SELECT COALESCE(SUM(seconds),0) AS t FROM twitch_watch_sessions WHERE user_id=?', [userId]).t,
      discMsgs:  dbGet('SELECT COALESCE(SUM(messages),0) AS t FROM discord_activity WHERE user_id=?', [userId]).t,
      discVocal: dbGet('SELECT COALESCE(SUM(vocal_seconds),0) AS t FROM discord_activity WHERE user_id=?', [userId]).t,
    },
    codes:  dbAll("SELECT code,discount,used,expires_at, (expires_at < datetime('now')) AS expired FROM promo_codes WHERE user_id=? ORDER BY created_at DESC", [userId]),
    orders: dbAll('SELECT o.id,o.result,o.created_at,i.name AS item_name,i.type AS item_type FROM shop_orders o JOIN shop_items i ON o.item_id=i.id WHERE o.user_id=? ORDER BY o.created_at DESC', [userId]),
    seConfigured: se.isConfigured(),
  };
}

// Date de la prochaine remise à zéro d'un challenge répétable
function nextPeriodIso(repeatSeconds) {
  const start = T.periodStart(repeatSeconds);
  if (![T.DAY, T.WEEK, T.MONTH].includes(repeatSeconds))
    return new Date(start.getTime() + repeatSeconds * 1000).toISOString();
  // Périodes calendaires : on avance au-delà de la fin puis on recalcule le début
  // (gère les mois de 28-31 jours et les changements d'heure)
  const jump = repeatSeconds === T.MONTH ? 32 * 86400 : repeatSeconds + 3 * 3600;
  return T.periodStart(repeatSeconds, new Date(start.getTime() + jump * 1000)).toISOString();
}

module.exports = {
  RANKS, rankFor, nextRank, updateRank, addPoints, removePoints, logPoints,
  getPeriodKey, getEntry, markDone, completeChallenge, getProgress, autoCheck,
  verifyChallenge, validateRedirectTimer, submitScreenshot, getUserStats, needsAdminReview,
  approvePending, rejectPending,
};
