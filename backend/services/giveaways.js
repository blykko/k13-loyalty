'use strict';
/**
 * Giveaways : conditions de participation, tickets (bonus de rang, de défis, achetés
 * avec des points), tirage au sort pondéré automatique à la date de fin.
 */
const crypto = require('crypto');
const { dbGet, dbAll, dbRun } = require('../models/db');
const T = require('./time');

const RANK_ORDER = { bronze: 0, silver: 1, gold: 2 };
const RANK_BONUS = { bronze: 0, silver: 1, gold: 2 };

// ── Conditions ─────────────────────────────────────────────────────────────────
// conditions = { min_rank, min_lifetime_points, min_account_days, discord_member,
//                twitch_linked, twitter_linked, challenges: [ids] }
function parseJSON(s, def) { try { return JSON.parse(s || ''); } catch { return def; } }

const guildCache = new Map(); // discordId → { ok, at }
async function inGuild(discordId) {
  if (!discordId) return false;
  const c = guildCache.get(discordId);
  if (c && Date.now() - c.at < 5 * 60 * 1000) return c.ok;
  const ok = await require('./discord').checkGuildMember(discordId).catch(() => false);
  guildCache.set(discordId, { ok, at: Date.now() });
  return ok;
}

// Liste des conditions avec leur état pour un membre : [{ label, ok }]
async function checkConditions(g, user) {
  const c = parseJSON(g.conditions, {});
  const out = [];
  if (c.min_rank && RANK_ORDER[c.min_rank] > 0)
    out.push({ label: `Rang ${c.min_rank === 'gold' ? 'Gold' : 'Silver'} minimum`, ok: RANK_ORDER[user.rank] >= RANK_ORDER[c.min_rank] });
  if (c.min_lifetime_points > 0)
    out.push({ label: `${c.min_lifetime_points.toLocaleString('fr-FR')} points gagnés au total`, ok: user.lifetime_points >= c.min_lifetime_points });
  if (c.min_account_days > 0) {
    const days = (Date.now() - T.fromSql(user.created_at).getTime()) / 86400000;
    out.push({ label: `Membre depuis ${c.min_account_days} jour(s)`, ok: days >= c.min_account_days });
  }
  if (c.discord_member) out.push({ label: 'Être sur le serveur Discord K13', ok: await inGuild(user.discord_id) });
  if (c.twitch_linked)  out.push({ label: 'Compte Twitch lié', ok: !!user.twitch_id });
  if (c.twitter_linked) out.push({ label: 'Compte X lié', ok: !!user.twitter_id });
  for (const id of (c.challenges || [])) {
    const ch = dbGet('SELECT name FROM challenges WHERE id=?', [id]);
    if (!ch) continue;
    const done = dbGet('SELECT 1 FROM user_challenges WHERE user_id=? AND challenge_id=? AND verified=1', [user.id, id]);
    out.push({ label: `Défi « ${ch.name} »`, ok: !!done, challengeId: id });
  }
  return out;
}

// ── Tickets ────────────────────────────────────────────────────────────────────
// 1 ticket de base + bonus de rang + bonus défis validés pendant le giveaway + tickets achetés
function ticketsFor(g, user, entry) {
  if (!entry) return { base: 0, rank: 0, challenges: 0, bought: 0, total: 0 };
  const rank = g.rank_bonus ? (RANK_BONUS[user.rank] || 0) : 0;
  let challenges = 0;
  if (g.bonus_per_challenge > 0) {
    const n = dbGet(`SELECT COUNT(*) AS c FROM user_challenges WHERE user_id=? AND verified=1
      AND completed_at>=? AND completed_at<=?`, [user.id, g.starts_at, g.ends_at]).c;
    challenges = Math.min(n * g.bonus_per_challenge, g.max_challenge_bonus || Infinity);
  }
  const bought = entry.bought || 0;
  return { base: 1, rank, challenges, bought, total: 1 + rank + challenges + bought };
}

function statusOf(g) {
  if (g.status !== 'active') return g.status; // ended | cancelled
  const now = T.toSql(new Date());
  if (now < g.starts_at) return 'upcoming';
  if (now >= g.ends_at) return 'drawing';
  return 'open';
}

function totalTickets(g) {
  const entries = dbAll(`SELECT e.*, u.rank, u.id AS uid FROM giveaway_entries e JOIN users u ON u.id=e.user_id WHERE e.giveaway_id=?`, [g.id]);
  return entries.reduce((s, e) => s + ticketsFor(g, { id: e.uid, rank: e.rank }, e).total, 0);
}

function publicGiveaway(g) {
  return {
    id: g.id, title: g.title, description: g.description, prize: g.prize, image_url: g.image_url,
    starts_at: T.fromSql(g.starts_at).toISOString(), ends_at: T.fromSql(g.ends_at).toISOString(),
    winners_count: g.winners_count, status: statusOf(g),
    ticket_cost: g.ticket_cost, max_bought: g.max_bought, bonus_per_challenge: g.bonus_per_challenge,
    max_challenge_bonus: g.max_challenge_bonus, rank_bonus: !!g.rank_bonus,
    participants: dbGet('SELECT COUNT(*) AS c FROM giveaway_entries WHERE giveaway_id=?', [g.id]).c,
    total_tickets: totalTickets(g),
    winners: g.status === 'ended' ? winnersOf(g.id) : [],
  };
}

function winnersOf(giveawayId) {
  return dbAll(`SELECT w.rank, u.id AS user_id, u.username, u.discord_username, u.discord_id, u.discord_avatar
    FROM giveaway_winners w JOIN users u ON u.id=w.user_id WHERE w.giveaway_id=? ORDER BY w.rank`, [giveawayId]);
}

// Vue d'un giveaway pour un membre
async function viewFor(g, userId) {
  const user = dbGet('SELECT * FROM users WHERE id=?', [userId]);
  const entry = dbGet('SELECT * FROM giveaway_entries WHERE giveaway_id=? AND user_id=?', [g.id, userId]);
  const pub = publicGiveaway(g);
  const conditions = await checkConditions(g, user);
  const tickets = ticketsFor(g, user, entry);
  // Quelques pseudos de participants pour l'animation de tirage
  const sample = g.status === 'ended' ? dbAll(`SELECT COALESCE(u.discord_username,u.username) AS n FROM giveaway_entries e
    JOIN users u ON u.id=e.user_id WHERE e.giveaway_id=? ORDER BY RANDOM() LIMIT 24`, [g.id]).map(r => r.n) : [];
  return { ...pub, conditions, eligible: conditions.every(c => c.ok), joined: !!entry, tickets, sample,
    chance: entry && pub.total_tickets ? Math.min(100, tickets.total * Math.min(g.winners_count, pub.participants) / pub.total_tickets * 100) : 0,
    won: pub.winners.some(w => w.user_id === userId) };
}

async function listForUser(userId) {
  const list = dbAll(`SELECT * FROM giveaways WHERE status!='cancelled'
    AND (status='active' OR ends_at>=datetime('now','-30 days')) ORDER BY (status='active') DESC, ends_at ASC`);
  return Promise.all(list.map(g => viewFor(g, userId)));
}

// ── Participation ──────────────────────────────────────────────────────────────
async function join(giveawayId, userId) {
  const g = dbGet('SELECT * FROM giveaways WHERE id=?', [giveawayId]);
  if (!g || statusOf(g) !== 'open') return { ok: false, message: 'Ce giveaway n\'est pas ouvert.' };
  if (dbGet('SELECT 1 FROM giveaway_entries WHERE giveaway_id=? AND user_id=?', [g.id, userId])) return { ok: false, message: 'Tu participes déjà !' };
  const user = dbGet('SELECT * FROM users WHERE id=?', [userId]);
  const missing = (await checkConditions(g, user)).filter(c => !c.ok);
  if (missing.length) return { ok: false, message: `Conditions manquantes : ${missing.map(c => c.label).join(', ')}.` };
  dbRun('INSERT INTO giveaway_entries (giveaway_id,user_id) VALUES (?,?)', [g.id, userId]);
  return { ok: true, message: '🎟️ Tu participes ! Gagne des tickets bonus pour augmenter tes chances.' };
}

// Achat de tickets supplémentaires avec des points
function buyTickets(giveawayId, userId, qty) {
  qty = Math.max(1, Math.min(parseInt(qty, 10) || 1, 100));
  const g = dbGet('SELECT * FROM giveaways WHERE id=?', [giveawayId]);
  if (!g || statusOf(g) !== 'open') return { ok: false, message: 'Ce giveaway n\'est pas ouvert.' };
  if (!(g.ticket_cost > 0)) return { ok: false, message: 'Pas de tickets en vente pour ce giveaway.' };
  const entry = dbGet('SELECT * FROM giveaway_entries WHERE giveaway_id=? AND user_id=?', [g.id, userId]);
  if (!entry) return { ok: false, message: 'Participe d\'abord au giveaway.' };
  const left = (g.max_bought || 0) - entry.bought;
  if (left <= 0) return { ok: false, message: 'Tu as déjà acheté le maximum de tickets.' };
  qty = Math.min(qty, left);
  const cost = qty * g.ticket_cost;
  const debit = dbRun('UPDATE users SET points=points-? WHERE id=? AND points>=?', [cost, userId, cost]);
  if (!debit.changes) return { ok: false, message: `Il te faut ${cost} pts pour ${qty} ticket(s).` };
  dbRun('UPDATE giveaway_entries SET bought=bought+?, spent=spent+? WHERE id=?', [qty, cost, entry.id]);
  return { ok: true, message: `+${qty} ticket(s) pour ${cost} pts !` };
}

// ── Tirage ─────────────────────────────────────────────────────────────────────
// Tirage pondéré sans remise ; les conditions sont revérifiées (ex. membre parti du Discord)
async function draw(giveawayId, { reroll = false } = {}) {
  const g = dbGet('SELECT * FROM giveaways WHERE id=?', [giveawayId]);
  if (!g) return { ok: false, message: 'Giveaway introuvable.' };
  if (g.status === 'cancelled') return { ok: false, message: 'Giveaway annulé.' };
  if (g.status === 'ended' && !reroll) return { ok: false, message: 'Déjà tiré.' };

  const already = new Set(reroll ? winnersOf(g.id).map(w => w.user_id) : []);
  const entries = dbAll('SELECT e.*, u.* , e.id AS entry_id FROM giveaway_entries e JOIN users u ON u.id=e.user_id WHERE e.giveaway_id=?', [g.id]);
  const pool = [];
  for (const e of entries) {
    if (already.has(e.user_id)) continue;
    const user = { ...e, id: e.user_id };
    if (!(await checkConditions(g, user)).every(c => c.ok)) continue;
    pool.push({ userId: e.user_id, weight: ticketsFor(g, user, e).total });
  }
  const count = reroll ? 1 : g.winners_count;
  const winners = [];
  while (winners.length < count && pool.length) {
    const total = pool.reduce((s, p) => s + p.weight, 0);
    let r = crypto.randomInt(total);
    const idx = pool.findIndex(p => (r -= p.weight) < 0);
    winners.push(pool.splice(idx, 1)[0].userId);
  }
  let rank = reroll ? (dbGet('SELECT MAX(rank) AS m FROM giveaway_winners WHERE giveaway_id=?', [g.id]).m || 0) : 0;
  for (const uid of winners) dbRun('INSERT INTO giveaway_winners (giveaway_id,user_id,rank) VALUES (?,?,?)', [g.id, uid, ++rank]);
  dbRun("UPDATE giveaways SET status='ended', drawn_at=datetime('now') WHERE id=?", [g.id]);

  const list = winnersOf(g.id).filter(w => winners.includes(w.user_id));
  require('./notify').announceGiveawayWinners(g, list, { reroll }).catch(e => console.warn('[Giveaway]', e.message));
  console.log(`[Giveaway] "${g.title}" : ${list.length} gagnant(s) tiré(s) parmi ${pool.length + winners.length} éligible(s)`);
  return { ok: true, winners: list, message: list.length ? `🎉 ${list.map(w => w.discord_username || w.username).join(', ')}` : 'Aucun participant éligible.' };
}

// Annulation : rembourse les points dépensés en tickets
function cancel(giveawayId) {
  const g = dbGet('SELECT * FROM giveaways WHERE id=?', [giveawayId]);
  if (!g || g.status !== 'active') return { ok: false, message: 'Giveaway introuvable ou déjà terminé.' };
  for (const e of dbAll('SELECT user_id, spent FROM giveaway_entries WHERE giveaway_id=? AND spent>0', [g.id]))
    dbRun('UPDATE users SET points=points+? WHERE id=?', [e.spent, e.user_id]);
  dbRun("UPDATE giveaways SET status='cancelled' WHERE id=?", [g.id]);
  return { ok: true, message: 'Giveaway annulé, points des tickets remboursés.' };
}

// Tirage automatique des giveaways arrivés à échéance (appelé toutes les 30 s)
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const due = dbAll("SELECT id FROM giveaways WHERE status='active' AND ends_at<=datetime('now')");
    for (const g of due) await draw(g.id);
  } catch (e) { console.error('[Giveaway] tick', e); }
  ticking = false;
}

module.exports = { checkConditions, ticketsFor, statusOf, publicGiveaway, winnersOf, viewFor, listForUser, join, buyTickets, draw, cancel, tick, totalTickets };
