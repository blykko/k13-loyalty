'use strict';
/**
 * Fidélisation : série quotidienne (/daily), parrainage, badges, classements,
 * historique des points, parcours de démarrage, suppression / export du compte.
 */
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const { dbGet, dbAll, dbRun } = require('../models/db');
const T = require('./time');
const { addPoints, logPoints } = require('./challenges');

// ── Série quotidienne ──────────────────────────────────────────────────────────
// Récompense : 150 pts le 1er jour, +50 par jour consécutif (max 750 dès le 13e jour), + paliers bonus
const STREAK_MILESTONES = { 7: 750, 14: 1500, 30: 3000, 60: 6000, 100: 15000 };
const dailyReward = streak => 150 + 50 * Math.min(streak - 1, 12);

// Jours entre deux dates AAAA-MM-JJ
const dayGap = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
// Jours ratés depuis le dernier /daily (0 si la série est intacte)
function missedDays(user, today = T.parisDate()) {
  if (!user.last_daily) return 0;
  return Math.max(0, dayGap(user.last_daily, today) - 1);
}

function dailyStatus(user) {
  const today = T.parisDate();
  const claimed = user.last_daily === today;
  // Série encore valide si la dernière réclamation date d'aujourd'hui ou d'hier,
  // ou si les protections de série couvrent les jours ratés
  const missed = claimed ? 0 : missedDays(user, today);
  const shields = user.streak_shields || 0;
  const alive = claimed || (user.last_daily && missed <= shields);
  const current = alive ? user.streak : 0;
  const nextStreak = claimed ? current + 1 : current + 1;
  const nextMilestone = Object.keys(STREAK_MILESTONES).map(Number).find(n => n >= nextStreak);
  return {
    claimed, streak: current, best: user.best_streak, shields, shieldsNeeded: alive && !claimed ? missed : 0,
    nextReward: dailyReward(nextStreak) + (STREAK_MILESTONES[nextStreak] || 0),
    nextMilestone: nextMilestone ? { day: nextMilestone, bonus: STREAK_MILESTONES[nextMilestone] } : null,
    resetsAt: T.periodStart(T.DAY, new Date(Date.now() + 86400000)).toISOString(),
  };
}

function claimDaily(userId) {
  const user = dbGet('SELECT * FROM users WHERE id=?', [userId]);
  if (!user) return { ok: false, message: 'Compte introuvable.' };
  const today = T.parisDate();
  if (user.last_daily === today) {
    const st = dailyStatus(user);
    return { ok: false, already: true, ...st, message: `Déjà récupéré aujourd'hui ! Reviens demain pour ${st.nextReward} pts (série de ${st.streak} 🔥).` };
  }
  const missed = missedDays(user, today), shields = user.streak_shields || 0;
  const saved = missed > 0 && user.streak > 0 && missed <= shields ? missed : 0;
  const streak = user.last_daily && (missed === 0 || saved) ? user.streak + 1 : 1;
  const reward = dailyReward(streak);
  const bonus = STREAK_MILESTONES[streak] || 0;
  // Mise à jour conditionnelle : évite un double /daily simultané (site + Discord)
  const r = dbRun('UPDATE users SET streak=?, best_streak=MAX(best_streak,?), last_daily=?, streak_shields=streak_shields-? WHERE id=? AND IFNULL(last_daily,\'\')!=?',
    [streak, streak, today, saved, userId, today]);
  if (!r.changes) return { ok: false, already: true, message: 'Déjà récupéré aujourd\'hui !' };
  addPoints(userId, reward, 'daily', `Bonus quotidien (jour ${streak})`);
  if (bonus) addPoints(userId, bonus, 'daily', `Palier de série : ${streak} jours`);
  const lost = user.streak > 1 && streak === 1 ? user.streak : 0;
  const badges = afterEvent(userId, 'daily');
  return { ok: true, streak, reward, bonus, lost, badges,
    shieldsUsed: saved,
    message: `+${reward + bonus} pts ! Série : ${streak} jour${streak > 1 ? 's' : ''} 🔥${bonus ? ` (palier +${bonus} pts 🎉)` : ''}${saved ? ` — 🧊 ${saved} protection${saved > 1 ? 's' : ''} utilisée${saved > 1 ? 's' : ''}, ta série est sauvée !` : ''}${lost ? ` — ta série de ${lost} jours était perdue, c'est reparti !` : ''}` };
}

// ── Cadeau du jour : choisir 1 cadeau parmi 3 ──────────────────────────────────
// Tirage pondéré [points, poids] — moyenne ≈ 700 pts, 2 % de chances de jackpot
const GIFT_TABLE = [[150, 30], [300, 30], [500, 20], [1000, 12], [2500, 6], [10000, 2]];
function rollGift() {
  const total = GIFT_TABLE.reduce((s, [, w]) => s + w, 0);
  let r = crypto.randomInt(total);
  for (const [pts, w] of GIFT_TABLE) if ((r -= w) < 0) return pts;
  return GIFT_TABLE[0][0];
}
function giftStatus(user) {
  return { available: user.last_gift !== T.parisDate(), resetsAt: T.periodStart(T.DAY, new Date(Date.now() + 86400000)).toISOString(),
    max: GIFT_TABLE[GIFT_TABLE.length - 1][0] };
}
function openGift(userId, choice) {
  choice = parseInt(choice, 10);
  if (![0, 1, 2].includes(choice)) return { ok: false, message: 'Choisis un des 3 cadeaux.' };
  const today = T.parisDate();
  const r = dbRun("UPDATE users SET last_gift=? WHERE id=? AND IFNULL(last_gift,'')!=?", [today, userId, today]);
  if (!r.changes) return { ok: false, already: true, message: 'Tu as déjà ouvert ton cadeau aujourd\'hui, reviens demain 🎁' };
  const values = [rollGift(), rollGift(), rollGift()];
  const won = values[choice];
  addPoints(userId, won, 'gift', 'Cadeau du jour');
  const best = Math.max(...values);
  return { ok: true, values, choice, won, jackpot: won === GIFT_TABLE[GIFT_TABLE.length - 1][0],
    balance: dbGet('SELECT points FROM users WHERE id=?', [userId]).points,
    message: `🎁 +${won.toLocaleString('fr-FR')} pts !${won < best ? ` (le meilleur cadeau valait ${best.toLocaleString('fr-FR')} pts…)` : won >= 2500 ? ' 🎉' : ''}` };
}

// ── Parrainage ─────────────────────────────────────────────────────────────────
const REFERRER_REWARD = 5000, REFEREE_REWARD = 2500, MAX_REFERRALS = 50;
// Paliers bonus pour le parrain (nombre de filleuls actifs → bonus)
const REFERRAL_MILESTONES = { 3: 5000, 5: 10000, 10: 25000, 25: 75000 };
// Compte Discord récent = probable multicompte : pas de récompense de parrainage
const MIN_DISCORD_AGE_DAYS = 14;

function discordAgeDays(discordId) {
  try { return (Date.now() - Number((BigInt(discordId) >> 22n) + 1420070400000n)) / 86400000; } catch { return 0; }
}

function ensureRefCode(userId) {
  const u = dbGet('SELECT ref_code FROM users WHERE id=?', [userId]);
  if (u?.ref_code) return u.ref_code;
  for (;;) {
    const code = crypto.randomBytes(4).toString('base64url').replace(/[-_]/g, '').slice(0, 6).toUpperCase();
    if (code.length < 6 || dbGet('SELECT 1 FROM users WHERE ref_code=?', [code])) continue;
    dbRun('UPDATE users SET ref_code=? WHERE id=?', [code, userId]);
    return code;
  }
}

// À l'inscription : rattache le filleul à son parrain + bonus de bienvenue
const WELCOME_BONUS = 500;
function onSignup(userId, refCode) {
  addPoints(userId, WELCOME_BONUS, 'welcome', 'Bonus de bienvenue');
  if (!refCode) return;
  const sponsor = dbGet('SELECT id FROM users WHERE ref_code=?', [String(refCode).toUpperCase()]);
  if (sponsor && sponsor.id !== userId) dbRun('UPDATE users SET referred_by=? WHERE id=? AND referred_by IS NULL', [sponsor.id, userId]);
}

// Récompense versée quand le filleul valide son 1er défi
function rewardReferral(userId) {
  const u = dbGet('SELECT id, referred_by, referral_rewarded, discord_id, discord_username, username FROM users WHERE id=?', [userId]);
  if (!u?.referred_by || u.referral_rewarded) return;
  dbRun('UPDATE users SET referral_rewarded=1 WHERE id=?', [userId]);
  if (discordAgeDays(u.discord_id) < MIN_DISCORD_AGE_DAYS) return console.log(`[Parrainage] compte Discord récent, pas de récompense (user ${userId})`);
  const count = dbGet('SELECT COUNT(*) AS c FROM users WHERE referred_by=? AND referral_rewarded=1', [u.referred_by]).c;
  if (count > MAX_REFERRALS) return;
  const name = u.discord_username || u.username;
  addPoints(u.referred_by, REFERRER_REWARD, 'referral', `Parrainage : ${name}`);
  addPoints(userId, REFEREE_REWARD, 'referral', 'Bonus filleul');
  const milestone = REFERRAL_MILESTONES[count] || 0;
  if (milestone) addPoints(u.referred_by, milestone, 'referral', `Palier parrainage : ${count} filleuls actifs`);
  afterEvent(u.referred_by, 'referral');
  try {
    const { EmbedBuilder } = require('discord.js');
    require('./notify').dmUser(u.referred_by, new EmbedBuilder().setColor(0x059669)
      .setTitle('🤝 Parrainage validé !').setDescription(`**${name}** a validé son premier défi : **+${(REFERRER_REWARD + milestone).toLocaleString('fr-FR')} pts** pour toi !${milestone ? `\n🎉 Palier de ${count} filleuls atteint !` : ''}`));
  } catch {}
}

function referralInfo(userId) {
  const code = ensureRefCode(userId);
  const site = require('./notify').siteUrl();
  return {
    code, link: `${site}/?ref=${code}`,
    count: dbGet('SELECT COUNT(*) AS c FROM users WHERE referred_by=?', [userId]).c,
    rewarded: dbGet('SELECT COUNT(*) AS c FROM users WHERE referred_by=? AND referral_rewarded=1', [userId]).c,
    referrerReward: REFERRER_REWARD, refereeReward: REFEREE_REWARD,
    milestones: Object.entries(REFERRAL_MILESTONES).map(([n, bonus]) => ({ count: +n, bonus })),
  };
}

// ── Badges ─────────────────────────────────────────────────────────────────────
const BADGES = [
  { id: 'first_challenge', icon: '👣', name: 'Premier pas',   desc: 'Valider ton premier défi' },
  { id: 'challenges_10',   icon: '🎯', name: 'Assidu',        desc: 'Valider 10 défis' },
  { id: 'challenges_50',   icon: '🏹', name: 'Chasseur',      desc: 'Valider 50 défis' },
  { id: 'challenges_200',  icon: '👑', name: 'Légende K13',   desc: 'Valider 200 défis' },
  { id: 'streak_7',        icon: '🔥', name: 'En feu',        desc: '7 jours de série' },
  { id: 'streak_30',       icon: '☄️', name: 'Inarrêtable',   desc: '30 jours de série' },
  { id: 'streak_100',      icon: '💎', name: 'Diamant',       desc: '100 jours de série' },
  { id: 'rank_silver',     icon: '🥈', name: 'Silver',        desc: 'Atteindre le rang Silver' },
  { id: 'rank_gold',       icon: '🥇', name: 'Gold',          desc: 'Atteindre le rang Gold' },
  { id: 'referral_1',      icon: '🤝', name: 'Recruteur',     desc: 'Parrainer 1 membre actif' },
  { id: 'referral_5',      icon: '📣', name: 'Ambassadeur',   desc: 'Parrainer 5 membres actifs' },
  { id: 'connected',       icon: '🔗', name: 'Connecté',      desc: 'Lier Twitch et X' },
  { id: 'jackpot',         icon: '🎰', name: 'Jackpot',       desc: 'Gagner sur un numéro à la roulette' },
  { id: 'blackjack',       icon: '🃏', name: 'Blackjack !',   desc: 'Faire un blackjack naturel' },
];

function badgeChecks(userId) {
  const u = dbGet('SELECT * FROM users WHERE id=?', [userId]);
  if (!u) return {};
  const done = dbGet('SELECT COUNT(*) AS c FROM user_challenges WHERE user_id=? AND verified=1', [userId]).c;
  const refs = dbGet('SELECT COUNT(*) AS c FROM users WHERE referred_by=? AND referral_rewarded=1', [userId]).c;
  return {
    first_challenge: done >= 1, challenges_10: done >= 10, challenges_50: done >= 50, challenges_200: done >= 200,
    streak_7: u.best_streak >= 7, streak_30: u.best_streak >= 30, streak_100: u.best_streak >= 100,
    rank_silver: u.rank === 'silver' || u.rank === 'gold', rank_gold: u.rank === 'gold',
    referral_1: refs >= 1, referral_5: refs >= 5, connected: !!(u.twitch_id && u.twitter_id),
  };
}

// Débloque un badge ; retourne true s'il est nouveau
function unlock(userId, badge) {
  return dbRun('INSERT OR IGNORE INTO user_badges (user_id,badge) VALUES (?,?)', [userId, badge]).changes > 0;
}

// Après un événement (défi, daily, parrainage, jeu…) : parrainage + badges. Retourne les nouveaux badges.
function afterEvent(userId, event) {
  if (event === 'challenge') rewardReferral(userId);
  const unlocked = [];
  for (const [id, ok] of Object.entries(badgeChecks(userId))) if (ok && unlock(userId, id)) unlocked.push(id);
  return unlocked.map(id => BADGES.find(b => b.id === id));
}

function badgesOf(userId) {
  const have = new Map(dbAll('SELECT badge, unlocked_at FROM user_badges WHERE user_id=?', [userId]).map(r => [r.badge, r.unlocked_at]));
  return BADGES.map(b => ({ ...b, unlocked: have.has(b.id), unlocked_at: have.has(b.id) ? T.fromSql(have.get(b.id)).toISOString() : null }));
}

// ── Classements ────────────────────────────────────────────────────────────────
// "Solde" : points actuellement sur le compte ; "Mois" : points GAGNÉS depuis le 1er du mois (hors jeux) ;
// "total" : points cumulés
const PERIODS = ['points', 'month', 'all'];
function leaderboard(period = 'month', limit = 50) {
  if (period === 'points') {
    return dbAll(`SELECT id, username, discord_username, discord_id, discord_avatar, rank, streak, points
      FROM users WHERE points>0 ORDER BY points DESC, created_at ASC LIMIT ?`, [limit]);
  }
  if (period === 'month') {
    const from = T.toSql(T.periodStart(T.MONTH));
    return dbAll(`SELECT u.id, u.username, u.discord_username, u.discord_id, u.discord_avatar, u.rank, u.streak,
        SUM(l.delta) AS points
      FROM points_log l JOIN users u ON u.id=l.user_id
      WHERE l.created_at>=? AND l.delta>0 AND l.reason NOT IN ('game','shop')
      GROUP BY u.id HAVING points>0 ORDER BY points DESC, MIN(l.created_at) ASC LIMIT ?`, [from, limit]);
  }
  return dbAll(`SELECT id, username, discord_username, discord_id, discord_avatar, rank, streak, lifetime_points AS points
    FROM users WHERE lifetime_points>0 ORDER BY lifetime_points DESC, created_at ASC LIMIT ?`, [limit]);
}
function positionOf(userId, period = 'month') {
  const list = leaderboard(period, 100000);
  const i = list.findIndex(r => r.id === userId);
  return i < 0 ? null : { position: i + 1, points: list[i].points, total: list.length };
}

function history(userId, limit = 30) {
  return dbAll('SELECT delta, reason, label, created_at FROM points_log WHERE user_id=? ORDER BY id DESC LIMIT ?', [userId, limit])
    .map(r => ({ ...r, created_at: T.fromSql(r.created_at).toISOString() }));
}

// ── Premiers pas ───────────────────────────────────────────────────────────────
function onboarding(userId) {
  const u = dbGet('SELECT * FROM users WHERE id=?', [userId]);
  const done = dbGet('SELECT COUNT(*) AS c FROM user_challenges WHERE user_id=? AND verified=1', [userId]).c;
  const steps = [
    { id: 'daily',     label: 'Récupère ton bonus quotidien',   done: !!u.last_daily },
    { id: 'twitch',    label: 'Lie ton compte Twitch',          done: !!u.twitch_id },
    { id: 'challenge', label: 'Valide ton premier défi',        done: done > 0 },
    { id: 'referral',  label: 'Invite un ami avec ton lien',    done: !!dbGet('SELECT 1 FROM users WHERE referred_by=?', [userId]) },
  ];
  return { steps, done: steps.filter(s => s.done).length, total: steps.length };
}

// ── RGPD : export et suppression ───────────────────────────────────────────────
function exportData(userId) {
  const user = dbGet(`SELECT id, username, points, lifetime_points, rank, discord_id, discord_username, twitch_login, twitter_username,
    epic_username, epic_creator_code, streak, best_streak, notify_dm, games_disabled, created_at, last_seen FROM users WHERE id=?`, [userId]);
  return {
    exported_at: new Date().toISOString(), user,
    challenges: dbAll('SELECT c.name, uc.verified, uc.completed_at, uc.period_key FROM user_challenges uc JOIN challenges c ON c.id=uc.challenge_id WHERE uc.user_id=?', [userId]),
    points_history: dbAll('SELECT delta, reason, label, created_at FROM points_log WHERE user_id=? ORDER BY id', [userId]),
    discord_activity: dbAll('SELECT date, messages, vocal_seconds FROM discord_activity WHERE user_id=?', [userId]),
    twitch_watch: dbAll('SELECT started_at, seconds, source FROM twitch_watch_sessions WHERE user_id=?', [userId]),
    promo_codes: dbAll('SELECT code, discount, used, expires_at, created_at FROM promo_codes WHERE user_id=?', [userId]),
    orders: dbAll('SELECT i.name, o.result, o.created_at FROM shop_orders o JOIN shop_items i ON i.id=o.item_id WHERE o.user_id=?', [userId]),
    badges: dbAll('SELECT badge, unlocked_at FROM user_badges WHERE user_id=?', [userId]),
  };
}

function deleteAccount(userId) {
  const uploads = path.join(__dirname, '../../frontend/public/uploads');
  for (const r of dbAll('SELECT screenshot_path FROM user_challenges WHERE user_id=? AND screenshot_path IS NOT NULL', [userId]))
    fs.unlink(path.join(uploads, path.basename(r.screenshot_path)), () => {});
  for (const [table, col] of [['user_challenges', 'user_id'], ['pending_redirects', 'user_id'], ['twitch_watch_sessions', 'user_id'],
    ['discord_activity', 'user_id'], ['discord_invites', 'inviter_id'], ['shop_orders', 'user_id'], ['promo_codes', 'user_id'],
    ['points_log', 'user_id'], ['user_badges', 'user_id'], ['blackjack_games', 'user_id']]) {
    try { dbRun(`DELETE FROM ${table} WHERE ${col}=?`, [userId]); } catch {}
  }
  for (const t of ['giveaway_entries', 'giveaway_winners']) { try { dbRun(`DELETE FROM ${t} WHERE user_id=?`, [userId]); } catch {} }
  dbRun('UPDATE users SET referred_by=NULL WHERE referred_by=?', [userId]);
  dbRun('DELETE FROM users WHERE id=?', [userId]);
  // Sessions de ce membre
  for (const s of dbAll('SELECT sid, data FROM sessions')) {
    try { if (JSON.parse(s.data).userId === userId) dbRun('DELETE FROM sessions WHERE sid=?', [s.sid]); } catch {}
  }
}

module.exports = {
  dailyStatus, claimDaily, STREAK_MILESTONES, giftStatus, openGift, GIFT_TABLE,
  ensureRefCode, onSignup, referralInfo, discordAgeDays,
  BADGES, badgesOf, afterEvent, unlock,
  leaderboard, PERIODS, positionOf, history, onboarding, exportData, deleteAccount, logPoints,
};
