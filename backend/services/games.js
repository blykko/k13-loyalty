'use strict';
/**
 * Mini-jeux à points (site + Discord) : pile ou face, roulette, blackjack.
 *
 * Garde-fous :
 *  - les points ne s'achètent jamais avec de l'argent réel ;
 *  - les gains ne comptent ni pour le rang ni pour le classement (raison 'game') ;
 *  - mise min/max et nombre de parties par jour réglables (illimités par défaut) ;
 *  - chaque membre peut désactiver les jeux pour lui-même.
 * Probabilités identiques au casino : pile ou face équitable (×2), roulette européenne à un zéro
 * (avantage maison 2,7 %), blackjack aux règles classiques (avantage maison ≈ 0,5 % en jouant bien).
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
const COIN_PAYOUT = 2; // pile ou face équitable : mise doublée, 50 % de chances
const rnd = n => crypto.randomInt(n);

function limits(userId) {
  const c = config();
  const from = T.toSql(T.periodStart(T.DAY));
  // Une partie = une mise initiale (doubler / séparer au blackjack ne comptent pas)
  const played = dbGet("SELECT COUNT(*) AS c FROM points_log WHERE user_id=? AND reason='game' AND delta<0 AND label NOT LIKE '%(double)' AND label NOT LIKE '%(split)' AND created_at>=?", [userId, from]).c;
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
// Règles casino classiques : sabot de 6 jeux mélangé à chaque main, le croupier tire jusqu'à 16
// et reste sur tous les 17, blackjack payé 3:2, le croupier vérifie son blackjack d'entrée
// (on ne perd alors que la mise de départ). Doubler sur 2 cartes (aussi après un split),
// séparer deux cartes de même valeur jusqu'à 4 mains, As séparés : une seule carte chacun.
const SUITS = ['♠', '♥', '♦', '♣'], RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const DECKS = 6, MAX_HANDS = 4;
function newDeck() {
  const d = [];
  for (let k = 0; k < DECKS; k++) for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  for (let i = d.length - 1; i > 0; i--) { const j = rnd(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
const rankOf = c => c.slice(0, -1);
const cardValue = c => { const r = rankOf(c); return r === 'A' ? 11 : ['J', 'Q', 'K'].includes(r) ? 10 : +r; };
function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) { const v = cardValue(c); if (v === 11) aces++; total += v; }
  while (total > 21 && aces) { total -= 10; aces--; }
  return total;
}
const isBlackjack = cards => cards.length === 2 && handValue(cards) === 21;

const totalBet = g => g.hands.reduce((s, h) => s + h.bet, 0);
const hand = g => g.hands[g.active];
function canSplit(g) {
  const h = hand(g);
  return !!h && h.cards.length === 2 && g.hands.length < MAX_HANDS && cardValue(h.cards[0]) === cardValue(h.cards[1]) && !h.splitAces;
}
const canDouble = g => !!hand(g) && hand(g).cards.length === 2 && !hand(g).splitAces;

function bjView(g, done = false) {
  const h = hand(g) || g.hands[g.hands.length - 1];
  return { game: 'blackjack', bet: totalBet(g), baseBet: g.base, active: done ? -1 : g.active,
    hands: g.hands.map(x => ({ cards: x.cards, value: handValue(x.cards), bet: x.bet, doubled: !!x.doubled, outcome: x.outcome || null })),
    player: h.cards, playerValue: handValue(h.cards),
    dealer: done ? g.dealer : [g.dealer[0], '🂠'], dealerValue: done ? handValue(g.dealer) : handValue([g.dealer[0]]),
    canDouble: !done && canDouble(g), canSplit: !done && canSplit(g), done };
}

function bjFinish(userId, g) {
  const single = g.hands.length === 1;
  const live = g.hands.some(h => handValue(h.cards) <= 21);
  const pBJ = single && isBlackjack(g.hands[0].cards);
  // Le croupier ne tire que s'il reste une main en jeu (et pas sur un blackjack du joueur)
  if (live && !pBJ) while (handValue(g.dealer) < 17) g.dealer.push(g.deck.pop());
  const d = handValue(g.dealer), dBJ = isBlackjack(g.dealer);
  let payout = 0;
  for (const h of g.hands) {
    const p = handValue(h.cards);
    if (p > 21) h.outcome = 'bust';
    else if (single && isBlackjack(h.cards) && !dBJ) { h.outcome = 'blackjack'; h.payout = Math.floor(h.bet * 2.5); }
    else if (dBJ && !(single && isBlackjack(h.cards))) h.outcome = 'lose';
    else if (d > 21 || p > d) { h.outcome = 'win'; h.payout = h.bet * 2; }
    else if (p === d) { h.outcome = 'push'; h.payout = h.bet; }
    else h.outcome = 'lose';
    payout += h.payout || 0;
  }
  const bet = totalBet(g);
  dbRun('DELETE FROM blackjack_games WHERE user_id=?', [userId]);
  const outcome = single ? g.hands[0].outcome : payout > bet ? 'win' : payout === bet ? 'push' : 'lose';
  pay(userId, payout, outcome === 'push' ? 'Blackjack (égalité, mise rendue)' : 'Blackjack (gain)');
  let badge = null;
  if (outcome === 'blackjack' && require('./loyalty').unlock(userId, 'blackjack')) badge = 'blackjack';
  const dTxt = d > 21 ? 'croupier sauté' : `${d}${dBJ ? ' (blackjack)' : ''}`;
  let message;
  if (single) {
    const p = handValue(g.hands[0].cards);
    message = { bust: `💥 Tu dépasses 21 (${p}) : perdu (-${bet} pts).`, blackjack: `🃏 BLACKJACK ! +${payout - bet} pts`,
      win: `✅ ${p} contre ${dTxt} : gagné ! +${payout - bet} pts`, push: `🤝 Égalité (${p}) : mise rendue.`,
      lose: `❌ ${p} contre ${dTxt} : perdu (-${bet} pts).` }[outcome];
  } else {
    const word = { bust: '💥 sautée', win: '✅ gagnée', push: '🤝 égalité', lose: '❌ perdue' };
    message = `${d > 21 ? `Croupier sauté (${d})` : `Croupier : ${dTxt}`}. ` + g.hands.map((h, i) => `Main ${i + 1} (${handValue(h.cards)}) ${word[h.outcome]}`).join(' · ')
      + ` → ${payout - bet >= 0 ? '+' : ''}${payout - bet} pts`;
  }
  return { ok: true, ...bjView(g, true), outcome, win: payout > bet, payout, net: payout - bet, balance: balance(userId), badge, message };
}

function bjLoad(userId) {
  const row = dbGet('SELECT * FROM blackjack_games WHERE user_id=?', [userId]);
  if (!row) return null;
  const g = { ...JSON.parse(row.state), created_at: row.created_at };
  // Ancien format (une seule main) : converti
  if (!g.hands) { g.hands = [{ cards: g.player, bet: row.bet, doubled: !!g.doubled }]; g.active = 0; g.base = g.doubled ? row.bet / 2 : row.bet; delete g.player; delete g.doubled; }
  return g;
}
function bjSave(userId, g) {
  const { created_at, ...state } = g;
  dbRun('INSERT OR REPLACE INTO blackjack_games (user_id,bet,state,created_at) VALUES (?,?,?,COALESCE(?,datetime(\'now\')))',
    [userId, totalBet(g), JSON.stringify(state), created_at || null]);
}
// Passe à la main suivante, ou termine la partie
function bjNext(userId, g, msg) {
  while (g.active < g.hands.length && g.hands[g.active].done) g.active++;
  if (g.active >= g.hands.length) return bjFinish(userId, g);
  bjSave(userId, g);
  const h = hand(g);
  return { ok: true, ...bjView(g), message: msg || (g.hands.length > 1 ? `Main ${g.active + 1} : tu as ${handValue(h.cards)}.` : `Tu as ${handValue(h.cards)}.`) };
}

function blackjackStart(userId, bet) {
  const existing = bjLoad(userId);
  if (existing) return { ok: true, resumed: true, ...bjView(existing), message: 'Partie en cours reprise.' };
  const t = takeBet(userId, bet, 'Blackjack');
  if (t.error) return { ok: false, message: t.error };
  const deck = newDeck();
  const p1 = deck.pop(), d1 = deck.pop(), p2 = deck.pop(), d2 = deck.pop();
  const g = { base: t.bet, deck, hands: [{ cards: [p1, p2], bet: t.bet }], active: 0, dealer: [d1, d2] };
  if (isBlackjack(g.hands[0].cards) || isBlackjack(g.dealer)) return bjFinish(userId, g);
  bjSave(userId, g);
  return { ok: true, ...bjView(g), balance: balance(userId), message: `Tu as ${handValue(g.hands[0].cards)}. Tirer ou rester ?` };
}

function blackjackAction(userId, action) {
  const g = bjLoad(userId);
  if (!g) return { ok: false, message: 'Aucune partie en cours. Lance une nouvelle partie !' };
  const h = hand(g);
  if (action === 'hit') {
    h.cards.push(g.deck.pop());
    if (handValue(h.cards) >= 21) h.done = true;
    return bjNext(userId, g);
  }
  if (action === 'stand') { h.done = true; return bjNext(userId, g); }
  if (action === 'double') {
    if (!canDouble(g)) return { ok: false, message: 'Doubler n\'est possible que sur 2 cartes.' };
    const r = dbRun('UPDATE users SET points=points-? WHERE id=? AND points>=?', [h.bet, userId, h.bet]);
    if (!r.changes) return { ok: false, message: 'Pas assez de points pour doubler.' };
    logPoints(userId, -h.bet, 'game', 'Blackjack (double)');
    h.bet *= 2; h.doubled = true; h.done = true;
    h.cards.push(g.deck.pop());
    return bjNext(userId, g);
  }
  if (action === 'split') {
    if (!canSplit(g)) return { ok: false, message: 'Séparer : 2 cartes de même valeur, 4 mains maximum.' };
    const r = dbRun('UPDATE users SET points=points-? WHERE id=? AND points>=?', [h.bet, userId, h.bet]);
    if (!r.changes) return { ok: false, message: 'Pas assez de points pour séparer.' };
    logPoints(userId, -h.bet, 'game', 'Blackjack (split)');
    const aces = rankOf(h.cards[0]) === 'A';
    const second = { cards: [h.cards.pop(), g.deck.pop()], bet: h.bet };
    h.cards.push(g.deck.pop());
    g.hands.splice(g.active + 1, 0, second);
    // As séparés : une seule carte chacun ; une main à 21 est terminée d'office
    for (const x of [h, second]) {
      if (aces) { x.splitAces = true; x.done = true; }
      else if (handValue(x.cards) === 21) x.done = true;
    }
    return bjNext(userId, g, `Mains séparées ! Main ${g.active + 1} : tu as ${handValue(h.cards)}.`);
  }
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
