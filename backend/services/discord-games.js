'use strict';
/**
 * Jeux sur Discord : rendu "graphique" (cartes dessinées, roulette animée, pièce qui tourne)
 * et boutons de fin de partie (Rejouer, ½ mise, ×2 mise, paris rapides).
 *
 * customId des boutons (le dernier segment utile est toujours l'ID Discord du joueur) :
 *   g:coin:<uid>:<mise>:<pile|face>          rejouer pile ou face
 *   g:roul:<uid>:<mise>:<type>:<valeur>      rejouer à la roulette
 *   g:bj:<uid>:<mise>                        nouvelle main de blackjack
 *   g:adj:<jeu>:<uid>:<mise>:<a>:<b>         changer la mise (sans jouer)
 *   bj:<hit|stand|double>:<uid>              actions pendant une main
 */
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { dbGet } = require('../models/db');
const games = require('./games');

const fmt = n => Number(n || 0).toLocaleString('fr-FR');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const COLORS = { win: 0x059669, lose: 0xDC2626, push: 0x6B7280, play: 0x2563EB, spin: 0xF59E0B };

// ── Éléments visuels ───────────────────────────────────────────────────────────
// Cartes dessinées en caractères (bloc de code = police à chasse fixe)
function cardArt(cards) {
  const lines = ['', '', '', '', ''];
  for (const c of cards) {
    if (c === '🂠') { ['┌─────┐', '│░░░░░│', '│░░░░░│', '│░░░░░│', '└─────┘'].forEach((l, i) => { lines[i] += l; }); continue; }
    const s = c.slice(-1), r = c.slice(0, -1);
    [ '┌─────┐', `│${r.padEnd(5)}│`, `│  ${s}  │`, `│${r.padStart(5)}│`, '└─────┘' ].forEach((l, i) => { lines[i] += l; });
  }
  return '```\n' + lines.join('\n') + '\n```';
}

// Ordre réel des numéros sur une roulette européenne
const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const dot = n => ({ rouge: '🔴', noir: '⚫', vert: '🟢' })[games.colorOf(n)];
function wheelStrip(center) {
  const i = WHEEL.indexOf(center), out = [];
  for (let k = -3; k <= 3; k++) {
    const n = WHEEL[(i + k + WHEEL.length) % WHEEL.length];
    out.push(k === 0 ? `**【${dot(n)} ${n}】**` : `${dot(n)}${n}`);
  }
  return out.join('  ') + '\n' + ' '.repeat(9) + '▲';
}

const BET_LABEL = { rouge: '🔴 Rouge', noir: '⚫ Noir', pair: 'Pair', impair: 'Impair', manque: '1-18', passe: '19-36' };
const betLabel = (type, value) => type === 'numero' ? `N° ${value}` : type === 'douzaine' ? `${['1-12', '13-24', '25-36'][value - 1]}` : BET_LABEL[type];

function clampBet(bet) {
  const c = games.config();
  bet = Math.max(c.minBet, Math.round(bet));
  return c.maxBet ? Math.min(c.maxBet, bet) : bet;
}
const footer = userId => {
  const l = games.limits(userId);
  return { text: `${l.maxBet ? `Mise ${l.minBet}-${fmt(l.maxBet)} pts · ` : ''}${l.left === null ? '' : `${l.left} partie(s) restante(s) aujourd'hui · `}Gains hors classement` };
};
const btn = (id, label, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);

// ── Boutons de fin de partie ───────────────────────────────────────────────────
function components(game, uid, bet, a = '', b = '') {
  const half = clampBet(bet / 2), dbl = clampBet(bet * 2);
  const adj = [
    btn(`g:adj:${game}:${uid}:${half}:${a}:${b}`, `½ → ${fmt(half)}`, ButtonStyle.Secondary, half === bet),
    btn(`g:adj:${game}:${uid}:${dbl}:${a}:${b}`, `×2 → ${fmt(dbl)}`, ButtonStyle.Secondary, dbl === bet),
  ];
  if (game === 'coin') return [new ActionRowBuilder().addComponents(
    btn(`g:coin:${uid}:${bet}:pile`, `🟡 Pile · ${fmt(bet)}`, ButtonStyle.Primary),
    btn(`g:coin:${uid}:${bet}:face`, `⚪ Face · ${fmt(bet)}`, ButtonStyle.Primary), ...adj)];
  if (game === 'roul') return [
    new ActionRowBuilder().addComponents(btn(`g:roul:${uid}:${bet}:${a}:${b}`, `🔁 Rejouer ${betLabel(a, +b)} · ${fmt(bet)}`, ButtonStyle.Primary), ...adj),
    new ActionRowBuilder().addComponents(
      ...['rouge', 'noir', 'pair', 'impair', 'manque'].filter(t => t !== a).slice(0, 4)
        .map(t => btn(`g:roul:${uid}:${bet}:${t}:0`, BET_LABEL[t], t === 'rouge' ? ButtonStyle.Danger : ButtonStyle.Secondary))),
  ];
  if (game === 'bj') return [new ActionRowBuilder().addComponents(btn(`g:bj:${uid}:${bet}`, `🔁 Rejouer · ${fmt(bet)}`, ButtonStyle.Primary), ...adj)];
  return [];
}

// ── Pile ou face ───────────────────────────────────────────────────────────────
function coinFrames(choice, bet) {
  const e = t => new EmbedBuilder().setColor(COLORS.spin).setTitle('🪙 Pile ou face').setDescription(`Tu as choisi **${choice === 'pile' ? '🟡 PILE' : '⚪ FACE'}** · mise **${fmt(bet)} pts**\n\n${t}`);
  return [e('🪙 La pièce est lancée…'), e('↻ 🟡 … ⚪ … 🟡 …'), e('↻ ⚪ … 🟡 … ⚪ …')];
}
function coinResult(r, uid, choice) {
  const face = r.result === 'pile' ? '🟡 **PILE**' : '⚪ **FACE**';
  return { embeds: [new EmbedBuilder().setColor(r.win ? COLORS.win : COLORS.lose)
    .setTitle(r.win ? '🪙 Gagné !' : '🪙 Perdu…')
    .setDescription(`# ${face}\nTu avais choisi ${choice === 'pile' ? '🟡 pile' : '⚪ face'}.\n\n${r.win ? `✅ **+${fmt(r.net)} pts** (×1,9)` : `❌ **-${fmt(r.bet)} pts**`}\nSolde : **${fmt(r.balance)} pts**`)
    .setFooter(footer(r.userId))], components: components('coin', uid, r.bet) };
}

// ── Roulette ───────────────────────────────────────────────────────────────────
function rouletteFrames(type, value, bet) {
  const pick = () => WHEEL[Math.floor(Math.random() * WHEEL.length)];
  return [0, 1, 2].map(k => new EmbedBuilder().setColor(COLORS.spin).setTitle(`🎡 La roulette tourne${'.'.repeat(k + 1)}`)
    .setDescription(`${wheelStrip(pick())}\n\nPari : **${betLabel(type, value)}** · mise **${fmt(bet)} pts**`));
}
function rouletteResult(r, uid, type, value) {
  const mult = games.ROULETTE_BETS[type].mult;
  return { embeds: [new EmbedBuilder().setColor(r.win ? COLORS.win : COLORS.lose)
    .setTitle(`🎡 ${dot(r.number)} ${r.number} ${r.color} — ${r.win ? 'gagné !' : 'perdu'}`)
    .setDescription(`${wheelStrip(r.number)}\n\nPari : **${betLabel(type, value)}** (×${mult})\n${r.win ? `✅ **+${fmt(r.net)} pts**` : `❌ **-${fmt(r.bet)} pts**`} · Solde : **${fmt(r.balance)} pts**${r.badge ? '\n🏅 Badge débloqué : 🎰 **Jackpot** !' : ''}`)
    .setFooter(footer(r.userId))], components: components('roul', uid, r.bet, type, value) };
}

// ── Blackjack ──────────────────────────────────────────────────────────────────
function bjMessage(r, uid, userId) {
  const outcome = r.done ? (r.outcome === 'push' ? 'push' : r.win ? 'win' : 'lose') : 'play';
  const titles = { play: '🃏 Blackjack', win: r.outcome === 'blackjack' ? '🃏 BLACKJACK !' : '🃏 Gagné !', lose: '🃏 Perdu…', push: '🃏 Égalité' };
  const embed = new EmbedBuilder().setColor(COLORS[outcome]).setTitle(`${titles[outcome]} — mise ${fmt(r.bet)} pts`)
    .setDescription(`**Croupier — ${r.done ? r.dealerValue : '?'}**\n${cardArt(r.dealer)}**Toi — ${r.playerValue}**\n${cardArt(r.player)}\n${r.message}`
      + (r.done ? `\nSolde : **${fmt(r.balance)} pts**${r.badge ? '\n🏅 Badge débloqué : 🃏 **Blackjack !**' : ''}` : ''))
    .setFooter(footer(userId));
  const comps = r.done ? components('bj', uid, r.bet) : [new ActionRowBuilder().addComponents(
    btn(`bj:hit:${uid}`, '🃏 Tirer', ButtonStyle.Primary),
    btn(`bj:stand:${uid}`, '✋ Rester', ButtonStyle.Secondary),
    btn(`bj:double:${uid}`, '💰 Doubler', ButtonStyle.Success, !r.canDouble))];
  return { embeds: [embed], components: comps };
}

// ── Présentation (animation par modifications successives du message) ──────────
async function present(i, frames, final) {
  const first = { embeds: [frames[0]], components: [] };
  if (i.isButton()) await i.update(first); else await i.reply(first);
  for (const f of frames.slice(1)) { await sleep(650); await i.editReply({ embeds: [f], components: [] }); }
  await sleep(650);
  await i.editReply(final);
}
const fail = (i, message) => i.reply({ content: message, flags: MessageFlags.Ephemeral });

async function playCoin(i, user, bet, choice) {
  const r = games.coinflip(user.id, bet, choice);
  if (!r.ok) return fail(i, r.message);
  r.userId = user.id;
  return present(i, coinFrames(choice, r.bet), coinResult(r, i.user.id, choice));
}
async function playRoulette(i, user, bet, type, value) {
  const r = games.roulette(user.id, bet, type, value);
  if (!r.ok) return fail(i, r.message);
  r.userId = user.id;
  return present(i, rouletteFrames(type, value, r.bet), rouletteResult(r, i.user.id, type, value));
}
async function playBlackjack(i, user, bet) {
  const r = games.blackjackStart(user.id, bet);
  if (!r.ok) return fail(i, r.message);
  const msg = bjMessage(r, i.user.id, user.id);
  return i.isButton() ? i.update(msg) : i.reply(msg);
}

// ── Boutons ────────────────────────────────────────────────────────────────────
async function handleButton(i, userOf, notLinked) {
  const parts = i.customId.split(':');
  if (parts[0] !== 'g' && parts[0] !== 'bj') return false;
  const ownerId = parts[0] === 'bj' ? parts[2] : parts[1] === 'adj' ? parts[3] : parts[2];
  if (i.user.id !== ownerId) {
    await i.reply({ content: 'Ce n\'est pas ta partie 😉 Lance la tienne avec /pileouface, /roulette ou /blackjack.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const user = userOf(i.user.id);
  if (!user) { await notLinked(i); return true; }

  if (parts[0] === 'bj') {
    const r = games.blackjackAction(user.id, parts[1]);
    if (!r.ok) await fail(i, r.message); else await i.update(bjMessage(r, i.user.id, user.id));
    return true;
  }
  const [, kind] = parts;
  if (kind === 'adj') {
    const [, , game, uid, bet, a, b] = parts;
    await i.update({ components: components(game, uid, +bet, a, b) });
    return true;
  }
  if (kind === 'coin') await playCoin(i, user, +parts[3], parts[4]);
  else if (kind === 'roul') await playRoulette(i, user, +parts[3], parts[4], +parts[5]);
  else if (kind === 'bj') await playBlackjack(i, user, +parts[3]);
  return true;
}

module.exports = { playCoin, playRoulette, playBlackjack, handleButton, cardArt, wheelStrip };
