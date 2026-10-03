'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const path    = require('path');
const fs      = require('fs');
const fetch   = require('node-fetch');
const { dbGet, dbAll, dbRun } = require('../models/db');
const discord = require('../services/discord');
const twitch  = require('../services/twitch');
const se      = require('../services/streamelements');
const stripe  = require('../services/stripe');
const T       = require('../services/time');
const { requireAdmin } = require('../middleware/auth');
const { removePoints, updateRank, completeChallenge, getPeriodKey, getEntry, approvePending, rejectPending } = require('../services/challenges');
const notify  = require('../services/notify');
const twitterSvc = require('../services/twitter');
const router = express.Router();
router.use(requireAdmin);

const PUBLIC = path.join(__dirname, '../../frontend/public');
const removeFile = p => { if (p) fs.unlink(path.join(PUBLIC, 'uploads', path.basename(p)), () => {}); };
const int = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

// Colonnes utilisateur exposées à l'admin (jamais les tokens OAuth)
const USER_COLS = 'u.id,u.username,u.points,u.lifetime_points,u.rank,u.discord_id,u.discord_username,u.discord_avatar,u.twitch_id,u.twitch_login,u.twitter_id,u.twitter_username,u.epic_username,u.epic_creator_code,u.notify_dm,u.created_at,u.last_seen';

// ── Stats ──────────────────────────────────────────────────────────────────────
router.get('/stats', (req, res) => res.json({ ok: true,
  totalUsers:    dbGet('SELECT COUNT(*) AS c FROM users').c,
  totalCodes:    dbGet('SELECT COUNT(*) AS c FROM promo_codes').c,
  usedCodes:     dbGet('SELECT COUNT(*) AS c FROM promo_codes WHERE used=1').c,
  pendingVerifs: dbGet('SELECT COUNT(*) AS c FROM user_challenges WHERE verified=0').c,
  pendingOrders: dbGet("SELECT COUNT(*) AS c FROM shop_orders WHERE status='pending'").c,
}));

router.get('/stats/detailed', (req, res) => {
  const totalUsers = dbGet('SELECT COUNT(*) AS c FROM users').c;
  const buyers     = dbGet('SELECT COUNT(DISTINCT user_id) AS c FROM shop_orders').c;
  res.json({ ok: true,
    totalPoints:    dbGet('SELECT COALESCE(SUM(lifetime_points),0) AS s FROM users').s,
    activeUsers7d:  dbGet("SELECT COUNT(*) AS c FROM users WHERE last_seen>datetime('now','-7 days')").c,
    totalCompleted: dbGet('SELECT COUNT(*) AS c FROM user_challenges WHERE verified=1').c,
    convRate:       totalUsers ? Math.round(buyers / totalUsers * 100) : 0,
    rankDist: dbAll("SELECT rank, COUNT(*) AS c FROM users GROUP BY rank ORDER BY CASE rank WHEN 'gold' THEN 1 WHEN 'silver' THEN 2 ELSE 3 END"),
    topChallenges: dbAll(`
      SELECT c.name, c.platform, COUNT(uc.id) AS completions
      FROM user_challenges uc JOIN challenges c ON uc.challenge_id=c.id
      WHERE uc.verified=1 GROUP BY c.id ORDER BY completions DESC LIMIT 10`),
    discordActivity: dbAll(`
      SELECT u.discord_username, u.username,
        SUM(CASE WHEN da.date>=? THEN da.messages ELSE 0 END) AS msgs7d,
        SUM(CASE WHEN da.date>=? THEN da.vocal_seconds ELSE 0 END) AS vocal7d,
        MAX(da.date) AS last_activity
      FROM discord_activity da JOIN users u ON da.user_id=u.id
      GROUP BY u.id HAVING msgs7d>0 OR vocal7d>0
      ORDER BY msgs7d DESC LIMIT 20`, Array(2).fill(T.parisDate(new Date(Date.now() - 6 * 86400000)))),
    newUsers: dbAll("SELECT username,discord_username,twitch_login,lifetime_points AS points,created_at FROM users WHERE created_at>datetime('now','-30 days') ORDER BY created_at DESC LIMIT 30"),
    seConfigured: se.isConfigured(),
    stripeConfigured: stripe.isStripeConfigured(),
    botConfigured: notify.ready(),
    adminChannelConfigured: !!process.env.DISCORD_ADMIN_CHANNEL_ID,
    twitterConfigured: twitterSvc.isConfigured(),
    games: require('../services/games').houseStats(),
    dailyToday: dbGet("SELECT COUNT(*) AS c FROM points_log WHERE reason='daily' AND label LIKE 'Bonus quotidien%' AND created_at>=?", [T.toSql(T.periodStart(T.DAY))]).c,
  });
});

// ── Membres ────────────────────────────────────────────────────────────────────
router.get('/users', (req, res) => res.json({ ok: true, users: dbAll(`
  SELECT ${USER_COLS},
    (SELECT COUNT(*) FROM user_challenges uc WHERE uc.user_id=u.id AND uc.verified=1) AS challenges_done,
    (SELECT COALESCE(SUM(messages),0) FROM discord_activity da WHERE da.user_id=u.id) AS discord_messages,
    (SELECT COALESCE(SUM(vocal_seconds),0) FROM discord_activity da WHERE da.user_id=u.id) AS discord_vocal,
    (SELECT COALESCE(SUM(seconds),0) FROM twitch_watch_sessions tw WHERE tw.user_id=u.id) AS twitch_watch_seconds,
    (SELECT COUNT(*) FROM discord_invites di WHERE di.inviter_id=u.id) AS invites
  FROM users u ORDER BY u.lifetime_points DESC, u.points DESC`) }));

router.get('/live-ranking', (req, res) => res.json({ ok: true, ranking: dbAll(`
  SELECT u.id, u.discord_username, u.username, u.twitch_login,
         SUM(tw.seconds) AS total_seconds,
         SUM(CASE WHEN tw.started_at>=datetime('now','-7 days') THEN tw.seconds ELSE 0 END) AS week_seconds,
         MAX(CASE WHEN tw.started_at>'2000-01-02' THEN tw.started_at END) AS last_session
  FROM users u JOIN twitch_watch_sessions tw ON tw.user_id=u.id
  GROUP BY u.id HAVING total_seconds > 0
  ORDER BY total_seconds DESC LIMIT 50`) }));

router.get('/users/:id', (req, res) => {
  const user = dbGet(`SELECT ${USER_COLS} FROM users u WHERE u.id=?`, [int(req.params.id)]);
  if (!user) return res.status(404).json({ ok: false, message: 'Membre introuvable.' });
  const challenges = dbAll('SELECT * FROM challenges WHERE active=1 ORDER BY category,platform,points').map(c => {
    const pk = getPeriodKey(c);
    const status = getEntry(user.id, c.id, pk) || null;
    const times = dbGet('SELECT COUNT(*) AS n FROM user_challenges WHERE user_id=? AND challenge_id=? AND verified=1', [user.id, c.id]).n;
    return { id: c.id, name: c.name, platform: c.platform, points: c.points, category: c.category, repeat_seconds: c.repeat_seconds, status, times };
  });
  res.json({ ok: true, user, challenges,
    codes:    dbAll('SELECT * FROM promo_codes WHERE user_id=? ORDER BY created_at DESC', [user.id]),
    orders:   dbAll('SELECT o.*,i.name AS item_name FROM shop_orders o JOIN shop_items i ON o.item_id=i.id WHERE o.user_id=? ORDER BY o.created_at DESC', [user.id]),
    activity: dbAll('SELECT date,messages,vocal_seconds FROM discord_activity WHERE user_id=? ORDER BY date DESC LIMIT 30', [user.id]),
  });
});

// Ajuster les points (le delta s'applique aussi aux points cumulés → rang)
router.post('/users/:id/points', (req, res) => {
  const delta = int(req.body?.delta);
  if (!delta) return res.status(400).json({ ok: false, message: 'Delta requis (nombre non nul).' });
  const id = int(req.params.id);
  const user = dbGet('SELECT points FROM users WHERE id=?', [id]);
  if (!user) return res.status(404).json({ ok: false, message: 'Membre introuvable.' });
  dbRun('UPDATE users SET points=MAX(0,points+?), lifetime_points=MAX(0,lifetime_points+?) WHERE id=?', [delta, delta, id]);
  require('../services/challenges').logPoints(id, delta, 'admin', req.body?.reason || 'Ajustement admin');
  updateRank(id);
  const newPts = dbGet('SELECT points FROM users WHERE id=?', [id]).points;
  res.json({ ok: true, message: `${delta > 0 ? '+' + delta : delta} pts. Nouveau total : ${newPts}`, newPoints: newPts });
});

// ── Challenge d'un membre (période courante) ───────────────────────────────────
router.post('/users/:userId/challenge/:challengeId/validate', (req, res) => {
  const userId = int(req.params.userId);
  const ch = dbGet('SELECT * FROM challenges WHERE id=?', [int(req.params.challengeId)]);
  if (!ch || !dbGet('SELECT id FROM users WHERE id=?', [userId])) return res.status(404).json({ ok: false, message: 'Introuvable.' });
  const entry = getEntry(userId, ch.id, getPeriodKey(ch));
  if (!completeChallenge(userId, ch, getPeriodKey(ch), req.body?.note || null))
    return res.json({ ok: false, message: 'Déjà validé pour cette période.' });
  removeFile(entry?.screenshot_path);
  dbRun('UPDATE user_challenges SET screenshot_path=NULL WHERE user_id=? AND challenge_id=? AND screenshot_path IS NOT NULL', [userId, ch.id]);
  if (entry?.discord_msg_id) notify.resolvePendingMessage(entry.discord_msg_id, true, 'admin (site)').catch(() => {});
  notify.notifyResult(userId, ch, true, req.body?.note || null);
  res.json({ ok: true, message: `"${ch.name}" validé (+${ch.points} pts).` });
});

// Retire la validation de la période courante (et les points associés)
router.delete('/users/:userId/challenge/:challengeId', (req, res) => {
  const userId = int(req.params.userId);
  const ch = dbGet('SELECT * FROM challenges WHERE id=?', [int(req.params.challengeId)]);
  if (!ch) return res.status(404).json({ ok: false, message: 'Challenge introuvable.' });
  const entry = getEntry(userId, ch.id, getPeriodKey(ch));
  if (!entry) return res.json({ ok: false, message: 'Rien à retirer pour cette période.' });
  if (entry.verified === 1) removePoints(userId, ch.points);
  removeFile(entry.screenshot_path);
  dbRun('DELETE FROM user_challenges WHERE id=?', [entry.id]);
  res.json({ ok: true, message: `Validation retirée${entry.verified === 1 ? ` (-${ch.points} pts)` : ''}.` });
});

// ── Validations en attente ─────────────────────────────────────────────────────
router.get('/pending', (req, res) => res.json({ ok: true, pending: dbAll(`
  SELECT uc.id, uc.screenshot_path, uc.completed_at, uc.admin_note, uc.period_key,
         u.id AS user_id, u.username, u.discord_username,
         c.name AS challenge_name, c.platform, c.points, c.slug, c.id AS challenge_id
  FROM user_challenges uc
  JOIN users u ON uc.user_id=u.id
  JOIN challenges c ON uc.challenge_id=c.id
  WHERE uc.verified=0
  ORDER BY (uc.screenshot_path IS NULL), uc.completed_at ASC`) }));

router.post('/pending/:id/approve', (req, res) => {
  const r = approvePending(int(req.params.id), { note: req.body?.note || null, by: 'admin (site)' });
  res.status(r.ok ? 200 : 400).json({ ok: r.ok, message: r.message });
});

router.post('/pending/:id/reject', (req, res) => {
  const r = rejectPending(int(req.params.id), { note: req.body?.note || null, by: 'admin (site)' });
  res.status(r.ok ? 200 : 404).json(r);
});

// ── Codes promo ────────────────────────────────────────────────────────────────
const CODE_SELECT = "SELECT p.*, u.username, u.discord_username, (p.expires_at < datetime('now')) AS expired FROM promo_codes p JOIN users u ON p.user_id=u.id";
router.get('/codes', (req, res) => res.json({ ok: true, codes: dbAll(`${CODE_SELECT} ORDER BY p.created_at DESC`) }));
router.get('/codes/verify/:code', (req, res) => {
  const code = dbGet(`${CODE_SELECT} WHERE p.code=?`, [req.params.code.trim().toUpperCase()]);
  if (!code) return res.json({ ok: false, valid: false, message: 'Code introuvable.' });
  if (code.used) return res.json({ ok: false, valid: false, message: 'Déjà utilisé.', code });
  if (code.expired) return res.json({ ok: false, valid: false, message: 'Expiré.', code });
  res.json({ ok: true, valid: true, code });
});
router.post('/codes/:code/use', (req, res) => {
  const r = dbRun("UPDATE promo_codes SET used=1,used_at=datetime('now') WHERE code=? AND used=0 AND expires_at>=datetime('now')", [req.params.code.trim().toUpperCase()]);
  res.json(r.changes ? { ok: true, message: 'Code marqué utilisé.' } : { ok: false, message: 'Déjà utilisé, expiré ou introuvable.' });
});

// ── Challenges ─────────────────────────────────────────────────────────────────
const CH_TYPES = ['redirect', 'screen', 'watchtime', 'messages', 'vocal', 'join', 'invite', 'follow', 'tw_like', 'tw_retweet', 'tw_reply', 'tw_follow'];
const CATEGORY_REPEAT = { daily: T.DAY, weekly: T.WEEK, monthly: T.MONTH };

// Nettoie/valide les champs d'un challenge. La catégorie quotidien/hebdo/mensuel
// impose la répétition correspondante (sinon les deux pouvaient se contredire).
function challengeFields(f, base = {}) {
  const v = { ...base };
  for (const k of ['platform', 'name', 'description', 'type', 'category']) if (f[k] !== undefined) v[k] = String(f[k]).trim();
  for (const k of ['points', 'required_value', 'repeat_seconds', 'redirect_delay', 'active']) if (f[k] !== undefined) v[k] = Math.max(0, int(f[k]) || 0);
  if (f.redirect_url !== undefined) v.redirect_url = f.redirect_url ? String(f.redirect_url).trim() : null;
  if (CATEGORY_REPEAT[v.category]) v.repeat_seconds = CATEGORY_REPEAT[v.category];
  if (v.type && !CH_TYPES.includes(v.type)) return { error: 'Type inconnu.' };
  if (v.type === 'redirect' && !v.redirect_url) return { error: 'URL requise pour un challenge à timer.' };
  if (v.redirect_url && !/^https?:\/\//i.test(v.redirect_url)) return { error: 'URL invalide (http/https).' };
  if (['tw_like', 'tw_retweet', 'tw_reply'].includes(v.type) && !twitterSvc.parseTweetId(v.redirect_url))
    return { error: 'Lien de tweet requis (https://x.com/compte/status/123…).' };
  if (v.type === 'tw_follow' && !twitterSvc.parseUsername(v.redirect_url) && !process.env.TWITTER_ACCOUNT_TO_FOLLOW)
    return { error: 'Lien du profil X à suivre requis (https://x.com/compte).' };
  if (v.type?.startsWith('tw_')) v.platform = 'twitter';
  return { v };
}

router.get('/challenges', (req, res) => res.json({ ok: true, challenges: dbAll(`
  SELECT c.*, (SELECT COUNT(*) FROM user_challenges uc WHERE uc.challenge_id=c.id AND uc.verified=1) AS completions
  FROM challenges c ORDER BY c.active DESC, c.category, c.platform, c.points`) }));

router.post('/challenges', (req, res) => {
  const f = req.body || {};
  const slug = String(f.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  const { v, error } = challengeFields(f, { type: 'screen', category: 'permanent', description: '', required_value: 0, repeat_seconds: 0, redirect_delay: 20, redirect_url: null });
  if (error) return res.status(400).json({ ok: false, message: error });
  if (!v.platform || !slug || !v.name || !v.points) return res.status(400).json({ ok: false, message: 'Plateforme, slug, nom et points requis.' });
  if (dbGet('SELECT id FROM challenges WHERE slug=?', [slug])) return res.status(409).json({ ok: false, message: 'Slug déjà existant.' });
  dbRun('INSERT INTO challenges (platform,slug,name,description,points,type,required_value,repeat_seconds,redirect_url,redirect_delay,category,extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [v.platform, slug, v.name, v.description, v.points, v.type, v.required_value, v.repeat_seconds, v.redirect_url, v.redirect_delay || 20, v.category, JSON.stringify(f.extra || {})]);
  let message = 'Challenge créé.';
  if (f.notify) {
    const n = notify.announceChallenge(v);
    message += notify.ready() ? ` MP envoyé à ${n} membre(s).` : ' (bot Discord hors ligne : aucun MP envoyé)';
  }
  res.json({ ok: true, message });
});

router.patch('/challenges/:id', (req, res) => {
  const c = dbGet('SELECT * FROM challenges WHERE id=?', [int(req.params.id)]);
  if (!c) return res.status(404).json({ ok: false, message: 'Challenge introuvable.' });
  const { v, error } = challengeFields(req.body || {}, c);
  if (error) return res.status(400).json({ ok: false, message: error });
  dbRun('UPDATE challenges SET active=?,points=?,name=?,description=?,type=?,required_value=?,repeat_seconds=?,redirect_url=?,redirect_delay=?,category=?,platform=? WHERE id=?',
    [v.active ? 1 : 0, v.points, v.name, v.description, v.type, v.required_value, v.repeat_seconds, v.redirect_url, v.redirect_delay, v.category, v.platform, c.id]);
  res.json({ ok: true, message: 'Challenge mis à jour.' });
});

router.delete('/challenges/:id', (req, res) => {
  const id = int(req.params.id);
  if (req.query.hard === '1') {
    dbAll('SELECT screenshot_path FROM user_challenges WHERE challenge_id=? AND screenshot_path IS NOT NULL', [id]).forEach(r => removeFile(r.screenshot_path));
    dbRun('DELETE FROM user_challenges WHERE challenge_id=?', [id]);
    dbRun('DELETE FROM pending_redirects WHERE challenge_id=?', [id]);
    dbRun('DELETE FROM challenges WHERE id=?', [id]);
  } else {
    dbRun('UPDATE challenges SET active=0 WHERE id=?', [id]);
  }
  res.json({ ok: true, message: 'Challenge supprimé.' });
});

// ── Boutique ───────────────────────────────────────────────────────────────────
const SHOP_TYPES = ['promo_code', 'discord_role', 'product'];
router.get('/shop', (req, res) => res.json({ ok: true, items: dbAll(`
  SELECT i.*, (SELECT COUNT(*) FROM shop_orders o WHERE o.item_id=i.id) AS sold
  FROM shop_items i ORDER BY i.active DESC, i.cost_points`) }));
router.post('/shop', (req, res) => {
  const { name, description, type, extra } = req.body || {};
  const cost = int(req.body?.cost_points), stock = int(req.body?.stock);
  if (!name || !SHOP_TYPES.includes(type) || !(cost > 0)) return res.status(400).json({ ok: false, message: 'Nom, type et coût (>0) requis.' });
  dbRun('INSERT INTO shop_items (name,description,type,cost_points,stock,extra) VALUES (?,?,?,?,?,?)',
    [String(name).trim(), String(description || '').trim(), type, cost, stock == null || stock < 0 ? -1 : stock, JSON.stringify(extra || {})]);
  res.json({ ok: true, message: 'Article ajouté.' });
});
router.patch('/shop/:id', (req, res) => {
  const i = dbGet('SELECT * FROM shop_items WHERE id=?', [int(req.params.id)]);
  if (!i) return res.status(404).json({ ok: false, message: 'Article introuvable.' });
  const f = req.body || {};
  const extra = f.extra !== undefined ? JSON.stringify(f.extra || {}) : i.extra;
  dbRun('UPDATE shop_items SET active=?,cost_points=?,stock=?,name=?,description=?,extra=? WHERE id=?', [
    f.active !== undefined ? (int(f.active) ? 1 : 0) : i.active,
    f.cost_points !== undefined ? Math.max(1, int(f.cost_points) || 1) : i.cost_points,
    f.stock !== undefined ? (int(f.stock) < 0 ? -1 : int(f.stock) || 0) : i.stock,
    f.name ?? i.name, f.description ?? i.description, extra, i.id]);
  res.json({ ok: true, message: 'Article mis à jour.' });
});
router.delete('/shop/:id', (req, res) => {
  const id = int(req.params.id);
  if (req.query.hard === '1') {
    if (dbGet('SELECT id FROM shop_orders WHERE item_id=?', [id]))
      return res.status(409).json({ ok: false, message: 'Des commandes existent pour cet article : désactive-le plutôt.' });
    dbRun('DELETE FROM shop_items WHERE id=?', [id]);
  } else {
    dbRun('UPDATE shop_items SET active=0 WHERE id=?', [id]);
  }
  res.json({ ok: true, message: 'Article supprimé.' });
});
router.get('/orders', (req, res) => res.json({ ok: true, orders: dbAll(`
  SELECT o.*, u.username, u.discord_username, i.name AS item_name, i.type AS item_type
  FROM shop_orders o JOIN users u ON o.user_id=u.id JOIN shop_items i ON o.item_id=i.id
  ORDER BY (o.status='pending') DESC, o.created_at DESC LIMIT 200`) }));
router.post('/orders/:id/complete', (req, res) => {
  const r = dbRun("UPDATE shop_orders SET status='completed' WHERE id=? AND status='pending'", [int(req.params.id)]);
  res.json(r.changes ? { ok: true, message: 'Commande marquée traitée.' } : { ok: false, message: 'Commande introuvable ou déjà traitée.' });
});

// ── Resets ─────────────────────────────────────────────────────────────────────
// Remet à zéro les compteurs d'activité (les compteurs SE repartent du cumul actuel)
function resetActivity(userId = null) {
  const w = userId ? ' WHERE user_id=?' : '', p = userId ? [userId] : [];
  dbRun('UPDATE discord_activity SET messages=0, vocal_seconds=0' + w, p);
  dbRun('DELETE FROM twitch_watch_sessions' + w, p);
  dbRun('DELETE FROM discord_invites' + (userId ? ' WHERE inviter_id=?' : ''), p);
}
function resetEntries(where, params) {
  dbAll(`SELECT screenshot_path FROM user_challenges WHERE screenshot_path IS NOT NULL${where ? ' AND ' + where : ''}`, params).forEach(r => removeFile(r.screenshot_path));
  dbRun(`DELETE FROM user_challenges${where ? ' WHERE ' + where : ''}`, params);
}

// Reset d'un membre : défis + compteurs ; points remis à 0 si resetPoints
router.post('/users/:id/reset', (req, res) => {
  const user = dbGet('SELECT id, username FROM users WHERE id=?', [int(req.params.id)]);
  if (!user) return res.status(404).json({ ok: false, message: 'Membre introuvable.' });
  resetEntries('user_id=?', [user.id]);
  resetActivity(user.id);
  if (req.body?.resetPoints) {
    dbRun('UPDATE users SET points=0, lifetime_points=0 WHERE id=?', [user.id]);
    updateRank(user.id);
  }
  res.json({ ok: true, message: `Défis de ${user.username} réinitialisés${req.body?.resetPoints ? ' (points remis à 0)' : ''}.` });
});

// Reset d'un challenge pour tous les membres (retire les points de la période courante)
router.post('/challenges/:id/reset', (req, res) => {
  const ch = dbGet('SELECT * FROM challenges WHERE id=?', [int(req.params.id)]);
  if (!ch) return res.status(404).json({ ok: false, message: 'Challenge introuvable.' });
  const pk = getPeriodKey(ch);
  const validated = dbAll("SELECT user_id FROM user_challenges WHERE challenge_id=? AND verified=1 AND IFNULL(period_key,'')=IFNULL(?,'')", [ch.id, pk]);
  for (const v of validated) removePoints(v.user_id, ch.points);
  resetEntries('challenge_id=?', [ch.id]);
  res.json({ ok: true, message: `"${ch.name}" réinitialisé pour tous (${validated.length} validation(s) retirée(s)).` });
});

// Reset global
router.post('/reset-all', (req, res) => {
  if (req.body?.confirmText !== 'CONFIRMER') return res.status(400).json({ ok: false, message: 'Confirmation incorrecte.' });
  resetEntries('', []);
  resetActivity();
  if (req.body.resetPoints) dbRun("UPDATE users SET points=0, lifetime_points=0, rank='bronze'");
  res.json({ ok: true, message: `Défis de tous les membres réinitialisés${req.body.resetPoints ? ' (points remis à 0)' : ''}.` });
});

// ── Mot de passe admin ─────────────────────────────────────────────────────────
router.post('/change-password', async (req, res) => {
  const pwd = String(req.body?.newPassword || '');
  if (pwd.length < 10) return res.status(400).json({ ok: false, message: '10 caractères minimum.' });
  dbRun('UPDATE admin SET password_hash=? WHERE id=1', [await bcrypt.hash(pwd, 12)]);
  res.json({ ok: true, message: 'Mot de passe modifié.' });
});

// ── Diagnostics ────────────────────────────────────────────────────────────────
router.get('/diag/streamelements', async (req, res) => {
  const jwt = process.env.STREAMELEMENTS_JWT, channelId = process.env.STREAMELEMENTS_CHANNEL_ID;
  if (!se.isConfigured()) return res.json({ ok: false, message: 'SE non configuré (STREAMELEMENTS_JWT / STREAMELEMENTS_CHANNEL_ID).' });
  try {
    const meRes = await fetch('https://api.streamelements.com/kappa/v2/channels/me', { headers: { Authorization: `Bearer ${jwt}` } });
    if (!meRes.ok) return res.json({ ok: false, message: `JWT refusé par StreamElements (HTTP ${meRes.status}).` });
    const me = await meRes.json();
    const match = me._id === channelId;
    res.json({ ok: match, channel: me.username,
      message: match ? `✅ StreamElements OK (chaîne ${me.username})` : `❌ Channel ID incorrect. Valeur attendue : ${me._id}` });
  } catch (e) {
    res.json({ ok: false, message: 'Erreur réseau : ' + e.message });
  }
});

router.get('/diag/discord', async (req, res) => {
  const id = /^\d{15,21}$/.test(req.query.dm || '') ? req.query.dm : null;
  const d = await notify.diagnose(id);
  const sent = d.botReady ? await notify.postMissingPending().catch(() => 0) : 0;
  if (sent) d.checks.push({ ok: true, label: `${sent} demande(s) en attente envoyée(s) dans le salon` });
  res.json({ ok: d.checks.every(c => c.ok), checks: d.checks,
    message: d.checks.map(c => `${c.ok ? '✅' : '❌'} ${c.label}`).join('\n') });
});

router.get('/diag/twitch', async (req, res) => {
  const live = await twitch.isChannelLive().catch(() => false);
  res.json({ ok: true, live, channel: process.env.TWITCH_CHANNEL_LOGIN,
    message: `Twitch ${process.env.TWITCH_CHANNEL_LOGIN || '?'} : ${live ? '🔴 en live' : 'hors ligne'}` });
});

module.exports = router;
