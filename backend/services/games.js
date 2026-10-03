'use strict';
/**
 * Mini-jeux à points (site + Discord) : pile ou face, roulette, blackjack.
 *
 * Garde-fous :
 *  - les points ne s'achètent jamais avec de l'argent réel ;
 *  - les gains ne comptent ni pour le rang ni pour le classement (raison 'game') ;
 *  - mise min/max et nombre de parties par jour limités ;
 *  - chaque membre peut désactiver les jeux pour lui-même.
 * L'avantage "maison" retire des points du circuit (pile ou face ×1,9 ; roulette à un zéro).
 */
const crypto = require('crypto');
const { dbGet, dbRun } = require('../models/db');
const T = require('./time');
const { logPoints } = require('./challenges');

// Réglables dans l'admin (Paramètres → Jeux) ; 0 = illimité (par défaut : aucune limite)
const DEFAULTS = { minBet: 1, maxBet: 0, daily: 0 };
function config() {
  const c = { ...DEFAULTS };
  try {
    const row = dbGet("SELECT value FROM app_settings WHERE key='games'");
    if (row) Object.assign(c, JSON.parse(row.value));
  } catch {}
  return c;
}
function setConfig(v) {
  const c = {
    minBet: Math.max(1, parseInt(v.minBet, 10) || DEFAULTS.minBet),
    maxBet: Math.max(0, parseInt(v.maxBet, 10) || 0),
    daily: Math.max(0, parseInt(v.daily, 10) || 0),
  };
  if (c.maxBet && c.maxBet < c.minBet) c.maxBet = c.minBet;
  dbRun("INSERT OR REPLACE INTO app_settings (key,value) VALUES ('games',?)", [JSON.stringify(c)]);
  return c;
}
const COIN_PAYOUT = 1.9;
const rnd = n => crypto.randomInt(n);

function limits(userId) {
  const c = config();
  const from = T.toSql(T.periodStart(T.DAY));
  // Une partie = une mise initiale (le "doubler" du blackjack ne compte pas)
  const played = dbGet("SELECT COUNT(*) AS c FROM points_log WHERE user_id=? AND reason='game' AND delta<0 AND label NOT LIKE '%(double)' AND created_at>=?", [userId, from]).c;
  return { minBet: c.minBet, maxBet: c.maxBet, daily: c.daily, played, left: c.daily ? Math.max(0, c.daily - played) : null };
}

// Vérifie la mise et débite les points ; retourne une erreur ou null
function takeBet(userId, bet, label) {
  bet = parseInt(bet, 10);
  const u = dbGet('SELECT points, games_disabled FROM users WHERE id=?', [userId]);
  if (!u) return { error: 'Compte introuvable.' };
  if (u.games_disabled) return { error: 'Tu as désactivé les jeux sur ton compte (réactivable depuis ton profil).' };
  const l = limits(userId);
  if (!Number.isInteger(bet) || bet < l.minBet || (l.maxBet && bet > l.maxBet))
    return { error: l.maxBet ? `Mise entre ${l.minBet} et ${l.maxBet} pts.` : `Mise minimum : ${l.minBet} pt(s).` };
  if (l.left !== null && l.left <= 0) return { error: `Limite de ${l.daily} parties par jour atteinte, reviens demain !` };
  const r = dbRun('UPDATE users SET points=points-? WHERE id=? AND points>=?', [bet, userId, bet]);
  if (!r.changes) return { error: `Pas assez de points (tu en as ${u.points}).` };
  logPoints(userId, -bet, 'game', label);
  return { bet };
}
// Crédite un gain (ne touche pas lifetime_points → pas d'effet sur le rang)
function pay(userId, amount, label) {
  if (amount <= 0) return;
  dbRun('UPDATE users SET points=points+? WHERE id=?', [amount, userId]);
  logPoints(userId, amount, 'game', label);
}
const balance = userId => dbGet('SELECT points FROM users WHERE id=?', [userId])?.points ?? 0;

// ── Pile ou face ───────────────────────────────────────────────────────────────
function coinflip(userId, bet, choice) {
  if (!['pile', 'face'].includes(choice)) return { ok: false, message: 'Choisis pile ou face.' };
  const t = takeBet(userId, bet, 'Pile ou face');
  if (t.error) return { ok: false, message: t.error };
  const result = rnd(2) ? 'pile' : 'face';
  const win = result === choice;
  const payout = win ? Math.floor(t.bet * COIN_PAYOUT) : 0;
  pay(userId, payout, 'Pile ou face (gain)');
  return { ok: true, game: 'coinflip', result, win, bet: t.bet, payout, net: payout - t.bet, balance: balance(userId),
    message: win ? `🪙 ${result.toUpperCase()} ! Tu gagnes ${payout} pts (+${payout - t.bet}).` : `🪙 ${result.toUpperCase()}… perdu (-${t.bet} pts).` };
}

// ── Roulette européenne (0-36) ─────────────────────────────────────────────────
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const colorOf = n => n === 0 ? 'vert' : RED.has(n) ? 'rouge' : 'noir';
// type : rouge|noir|pair|impair|manque|passe|douzaine (value 1-3)|numero (value 0-36)
const ROULETTE_BETS = {
  rouge:    { label: 'Rouge',     mult: 2,  win: n => RED.has(n) },
  noir:     { label: 'Noir',      mult: 2,  win: n => n > 0 && !RED.has(n) },
  pair:     { label: 'Pair',      mult: 2,  win: n => n > 0 && n % 2 === 0 },
  impair:   { label: 'Impair',    mult: 2,  win: n => n % 2 === 1 },
  manque:   { label: '1-18',      mult: 2,  win: n => n >= 1 && n <= 18 },
  passe:    { label: '19-36',     mult: 2,  win: n => n >= 19 },
  douzaine: { label: 'Douzaine',  mult: 3,  win: (n, v) => n > 0 && Math.ceil(n / 12) === v },
  numero:   { label: 'Numéro',    mult: 36, win: (n, v) => n === v },
};
function roulette(userId, bet, type, value) {
  const def = ROULETTE_BETS[type];
  if (!def) return { ok: false, message: 'Pari inconnu.' };
  value = parseInt(value, 10);
  if (type === 'douzaine' && !(value >= 1 && value <= 3)) return { ok: false, message: 'Douzaine : 1, 2 ou 3.' };
  if (type === 'numero' && !(value >= 0 && value <= 36)) return { ok: false, message: 'Numéro entre 0 et 36.' };
  const label = type === 'numero' ? `n°${value}` : type === 'douzaine' ? `${value}e douzaine` : def.label;
  const t = takeBet(userId, bet, `Roulette (${label})`);
  if (t.error) return { ok: false, message: t.error };
  const n = rnd(37);
  const win = def.win(n, value);
  const payout = win ? t.bet * def.mult : 0;
  pay(userId, payout, `Roulette (gain ${label})`);
  let badge = null;
  if (win && type === 'numero' && require('./loyalty').unlock(userId, 'jackpot')) badge = 'jackpot';
  return { ok: true, game: 'roulette', number: n, color: colorOf(n), win, bet: t.bet, payout, net: payout - t.bet, balance: balance(userId), badge,
    message: `🎡 ${n} ${colorOf(n)} — ${win ? `gagné ! +${payout - t.bet} pts (×${def.mult})` : `perdu (-${t.bet} pts)`}` };
}

// ── Blackjack ──────────────────────────────────────────────────────────────────
// Croupier tire jusqu'à 17, blackjack payé 3:2, doubler possible sur les 2 premières cartes
const SUITS = ['♠', '♥', '♦', '♣'], RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
function newDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  for (let i = d.length - 1; i > 0; i--) { const j = rnd(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    const r = c.slice(0, -1);
    if (r === 'A') { aces++; total += 11; } else total += ['J', 'Q', 'K'].includes(r) ? 10 : +r;
  }
  while (total > 21 && aces) { total -= 10; aces--; }
  return total;
}
const isBlackjack = cards => cards.length === 2 && handValue(cards) === 21;

function bjView(g, done = false) {
  return { game: 'blackjack', bet: g.bet, player: g.player, playerValue: handValue(g.player),
    dealer: done ? g.dealer : [g.dealer[0], '🂠'], dealerValue: done ? handValue(g.dealer) : handValue([g.dealer[0]]),
    canDouble: !done && g.player.length === 2 && !g.doubled, done };
}

function bjFinish(userId, g) {
  const p = handValue(g.player);
  if (p <= 21) while (handValue(g.dealer) < 17) g.dealer.push(g.deck.pop());
  const d = handValue(g.dealer);
  const pBJ = isBlackjack(g.player) && !g.doubled, dBJ = isBlackjack(g.dealer);
  let payout = 0, outcome;
  if (p > 21) outcome = 'bust';
  else if (pBJ && !dBJ) { outcome = 'blackjack'; payout = Math.floor(g.bet * 2.5); }
  else if (dBJ && !pBJ) outcome = 'lose';
  else if (d > 21 || p > d) { outcome = 'win'; payout = g.bet * 2; }
  else if (p === d) { outcome = 'push'; payout = g.bet; }
  else outcome = 'lose';
  dbRun('DELETE FROM blackjack_games WHERE user_id=?', [userId]);
  pay(userId, payout, outcome === 'push' ? 'Blackjack (égalité, mise rendue)' : 'Blackjack (gain)');
  let badge = null;
  if (outcome === 'blackjack' && require('./loyalty').unlock(userId, 'blackjack')) badge = 'blackjack';
  const texts = { bust: `💥 Tu dépasses 21 (${p}) : perdu (-${g.bet} pts).`, blackjack: `🃏 BLACKJACK ! +${payout - g.bet} pts`,
    win: `✅ ${p} contre ${d > 21 ? 'croupier sauté' : d} : gagné ! +${payout - g.bet} pts`, push: `🤝 Égalité (${p}) : mise rendue.`,
    lose: `❌ ${p} contre ${d}${dBJ ? ' (blackjack du croupier)' : ''} : perdu (-${g.bet} pts).` };
  return { ok: true, ...bjView(g, true), outcome, win: payout > g.bet, payout, net: payout - g.bet, balance: balance(userId), badge, message: texts[outcome] };
}

function bjLoad(userId) {
  const row = dbGet('SELECT * FROM blackjack_games WHERE user_id=?', [userId]);
  return row ? { ...JSON.parse(row.state), bet: row.bet, created_at: row.created_at } : null;
}
function bjSave(userId, g) {
  const { bet, created_at, ...state } = g;
  dbRun('INSERT OR REPLACE INTO blackjack_games (user_id,bet,state,created_at) VALUES (?,?,?,COALESCE(?,datetime(\'now\')))',
    [userId, bet, JSON.stringify(state), created_at || null]);
}

function blackjackStart(userId, bet) {
  const existing = bjLoad(userId);
  if (existing) return { ok: true, resumed: true, ...bjView(existing), message: 'Partie en cours reprise.' };
  const t = takeBet(userId, bet, 'Blackjack');
  if (t.error) return { ok: false, message: t.error };
  const deck = newDeck();
  const g = { bet: t.bet, deck, player: [deck.pop(), deck.pop()], dealer: [deck.pop(), deck.pop()], doubled: false };
  if (isBlackjack(g.player) || isBlackjack(g.dealer)) return bjFinish(userId, g);
  bjSave(userId, g);
  return { ok: true, ...bjView(g), balance: balance(userId), message: `Tu as ${handValue(g.player)}. Tirer ou rester ?` };
}

function blackjackAction(userId, action) {
  const g = bjLoad(userId);
  if (!g) return { ok: false, message: 'Aucune partie en cours. Lance une nouvelle partie !' };
  if (action === 'hit') {
    g.player.push(g.deck.pop());
    if (handValue(g.player) >= 21) return bjFinish(userId, g);
    bjSave(userId, g);
    return { ok: true, ...bjView(g), message: `Tu as ${handValue(g.player)}.` };
  }
  if (action === 'double') {
    if (g.player.length !== 2 || g.doubled) return { ok: false, message: 'Doubler n\'est possible que sur les 2 premières cartes.' };
    const r = dbRun('UPDATE users SET points=points-? WHERE id=? AND points>=?', [g.bet, userId, g.bet]);
    if (!r.changes) return { ok: false, message: 'Pas assez de points pour doubler.' };
    logPoints(userId, -g.bet, 'game', 'Blackjack (double)');
    g.bet *= 2; g.doubled = true;
    g.player.push(g.deck.pop());
    return bjFinish(userId, g);
  }
  if (action === 'stand') return bjFinish(userId, g);
  return { ok: false, message: 'Action inconnue.' };
}
function blackjackState(userId) {
  const g = bjLoad(userId);
  return g ? bjView(g) : null;
}

// Stats "maison" pour l'admin (aujourd'hui)
function houseStats() {
  const from = T.toSql(T.periodStart(T.DAY));
  const r = dbGet("SELECT COALESCE(SUM(CASE WHEN delta<0 THEN -delta END),0) AS bets, COALESCE(SUM(CASE WHEN delta>0 THEN delta END),0) AS paid, COUNT(DISTINCT user_id) AS players FROM points_log WHERE reason='game' AND created_at>=?", [from]);
  return { ...r, house: r.bets - r.paid };
}

module.exports = { config, setConfig, limits, coinflip, roulette, ROULETTE_BETS, colorOf, blackjackStart, blackjackAction, blackjackState, handValue, houseStats };
