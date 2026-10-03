'use strict';
/**
 * Commandes slash du bot : /daily /points /classement /defis /parrainage /badges
 * et jeux : /pileouface /roulette /blackjack (boutons Tirer / Rester / Doubler).
 * Enregistrées sur le serveur DISCORD_GUILD_ID au démarrage du bot.
 */
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { dbGet } = require('../models/db');

const RANK_LABEL = { bronze: '🥉 Bronze', silver: '🥈 Silver', gold: '🥇 Gold' };
const fmt = n => Number(n || 0).toLocaleString('fr-FR');
const site = () => require('./notify').siteUrl();

const COMMANDS = [
  new SlashCommandBuilder().setName('daily').setDescription('Récupère ton bonus quotidien et fais grimper ta série 🔥'),
  new SlashCommandBuilder().setName('points').setDescription('Affiche tes points (ou ceux d\'un membre)')
    .addUserOption(o => o.setName('membre').setDescription('Membre à consulter')),
  new SlashCommandBuilder().setName('classement').setDescription('Top 10 des membres')
    .addStringOption(o => o.setName('periode').setDescription('Période').addChoices({ name: 'Ce mois', value: 'month' }, { name: 'Depuis toujours', value: 'all' })),
  new SlashCommandBuilder().setName('defis').setDescription('Tes défis du jour restants'),
  new SlashCommandBuilder().setName('parrainage').setDescription('Ton lien de parrainage'),
  new SlashCommandBuilder().setName('badges').setDescription('Tes badges débloqués'),
  new SlashCommandBuilder().setName('pileouface').setDescription('Parie tes points à pile ou face (gain ×1,9)')
    .addIntegerOption(o => o.setName('mise').setDescription('Points misés').setRequired(true).setMinValue(10).setMaxValue(500))
    .addStringOption(o => o.setName('choix').setDescription('Pile ou face').setRequired(true).addChoices({ name: 'Pile', value: 'pile' }, { name: 'Face', value: 'face' })),
  new SlashCommandBuilder().setName('roulette').setDescription('Roulette européenne')
    .addIntegerOption(o => o.setName('mise').setDescription('Points misés').setRequired(true).setMinValue(10).setMaxValue(500))
    .addStringOption(o => o.setName('pari').setDescription('Sur quoi parier').setRequired(true).addChoices(
      { name: 'Rouge (×2)', value: 'rouge' }, { name: 'Noir (×2)', value: 'noir' }, { name: 'Pair (×2)', value: 'pair' },
      { name: 'Impair (×2)', value: 'impair' }, { name: '1-18 (×2)', value: 'manque' }, { name: '19-36 (×2)', value: 'passe' },
      { name: 'Douzaine (×3)', value: 'douzaine' }, { name: 'Numéro (×36)', value: 'numero' }))
    .addIntegerOption(o => o.setName('valeur').setDescription('Numéro (0-36) ou douzaine (1-3)').setMinValue(0).setMaxValue(36)),
  new SlashCommandBuilder().setName('blackjack').setDescription('Blackjack contre le croupier')
    .addIntegerOption(o => o.setName('mise').setDescription('Points misés').setRequired(true).setMinValue(10).setMaxValue(500)),
].map(c => c.toJSON());

async function register(client) {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return console.warn('[Bot Discord] DISCORD_GUILD_ID manquant : commandes slash non enregistrées');
  try {
    const guild = await client.guilds.fetch(guildId);
    await guild.commands.set(COMMANDS);
    console.log(`[Bot Discord] ${COMMANDS.length} commandes slash enregistrées`);
  } catch (e) {
    console.warn('[Bot Discord] Enregistrement des commandes impossible :', e.message,
      '→ réinvite le bot avec le scope "applications.commands"');
  }
}

const userOf = discordId => dbGet('SELECT * FROM users WHERE discord_id=?', [discordId]);
const notLinked = i => i.reply({ content: `Tu n'as pas encore de compte K13 Loyalty 👉 connecte-toi avec Discord sur ${site() || 'le site'} !`, flags: MessageFlags.Ephemeral });
const color = (r) => r.ok === false ? 0xDC2626 : r.win === false ? 0xDC2626 : r.win ? 0x059669 : 0x2563EB;

// ── Blackjack : rendu et boutons ───────────────────────────────────────────────
function bjMessage(r, discordId) {
  const embed = new EmbedBuilder().setColor(r.done ? (r.win ? 0x059669 : r.outcome === 'push' ? 0x6B7280 : 0xDC2626) : 0x2563EB)
    .setTitle(`🃏 Blackjack — mise ${fmt(r.bet)} pts`)
    .addFields(
      { name: `Toi (${r.playerValue})`, value: r.player.join('  '), inline: true },
      { name: `Croupier (${r.done ? r.dealerValue : '?'})`, value: r.dealer.join('  '), inline: true })
    .setDescription(r.message + (r.balance !== undefined && r.done ? `\nSolde : **${fmt(r.balance)} pts**` : ''));
  const components = r.done ? [] : [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`bj:hit:${discordId}`).setLabel('Tirer').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`bj:stand:${discordId}`).setLabel('Rester').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`bj:double:${discordId}`).setLabel('Doubler').setStyle(ButtonStyle.Success).setDisabled(!r.canDouble))];
  return { embeds: [embed], components };
}

async function handleButton(i) {
  const m = i.customId.match(/^bj:(hit|stand|double):(\d+)$/);
  if (!m) return false;
  if (i.user.id !== m[2]) { await i.reply({ content: 'Ce n\'est pas ta partie 😉 Lance la tienne avec /blackjack.', flags: MessageFlags.Ephemeral }); return true; }
  const u = userOf(i.user.id);
  if (!u) { await notLinked(i); return true; }
  const r = require('./games').blackjackAction(u.id, m[1]);
  if (!r.ok) { await i.reply({ content: r.message, flags: MessageFlags.Ephemeral }); return true; }
  await i.update(bjMessage(r, i.user.id));
  return true;
}

// ── Commandes ──────────────────────────────────────────────────────────────────
async function handleCommand(i) {
  const loyalty = require('./loyalty'), games = require('./games');
  const u = userOf(i.user.id);
  const name = i.commandName;
  if (name !== 'classement' && name !== 'points' && !u) return notLinked(i);

  if (name === 'daily') {
    const r = loyalty.claimDaily(u.id);
    const embed = new EmbedBuilder().setColor(r.ok ? 0xF59E0B : 0x6B7280)
      .setTitle(r.ok ? `🔥 Série de ${r.streak} jour${r.streak > 1 ? 's' : ''} !` : '⏳ Déjà récupéré aujourd\'hui')
      .setDescription(r.message + (r.badges?.length ? `\n🏅 Nouveau badge : ${r.badges.map(b => `${b.icon} ${b.name}`).join(', ')}` : ''));
    return i.reply({ embeds: [embed] });
  }

  if (name === 'points') {
    const target = i.options.getUser('membre') || i.user;
    const t = userOf(target.id);
    if (!t) return i.reply({ content: target.id === i.user.id ? `Tu n'as pas encore de compte 👉 ${site()}` : 'Ce membre n\'a pas de compte K13 Loyalty.', flags: MessageFlags.Ephemeral });
    const pos = loyalty.positionOf(t.id, 'month');
    const d = loyalty.dailyStatus(t);
    return i.reply({ embeds: [new EmbedBuilder().setColor(0x2563EB).setTitle(`⭐ ${t.discord_username || t.username}`)
      .addFields(
        { name: 'Points', value: fmt(t.points), inline: true },
        { name: 'Rang', value: RANK_LABEL[t.rank] || t.rank, inline: true },
        { name: 'Série', value: `${d.streak} 🔥`, inline: true },
        { name: 'Ce mois', value: pos ? `#${pos.position} (${fmt(pos.points)} pts)` : '–', inline: true },
        { name: 'Total gagné', value: fmt(t.lifetime_points), inline: true })] });
  }

  if (name === 'classement') {
    const period = i.options.getString('periode') || 'month';
    const list = loyalty.leaderboard(period, 10);
    const medals = ['🥇', '🥈', '🥉'];
    const lines = list.map((r, n) => `${medals[n] || `**${n + 1}.**`} ${r.discord_id ? `<@${r.discord_id}>` : (r.discord_username || r.username)} — ${fmt(r.points)} pts`);
    const me = u && loyalty.positionOf(u.id, period);
    return i.reply({ embeds: [new EmbedBuilder().setColor(0xF59E0B)
      .setTitle(period === 'month' ? '🏆 Classement du mois' : '🏆 Classement général')
      .setDescription((lines.join('\n') || 'Personne pour l\'instant, fonce !') + (me ? `\n\nToi : **#${me.position}** (${fmt(me.points)} pts)` : ''))
      .setFooter({ text: period === 'month' ? 'Points gagnés ce mois (hors jeux) · remis à zéro le 1er' : 'Points gagnés depuis l\'inscription' })],
      allowedMentions: { parse: [] } });
  }

  if (name === 'defis') {
    const stats = require('./challenges').getUserStats(u.id);
    const todo = stats.challenges.filter(c => !c.completed && c.repeat_seconds === 86400);
    const other = stats.challenges.filter(c => !c.completed && !c.pending && c.repeat_seconds !== 86400).length;
    const lines = todo.map(c => `• **${c.name}** (+${c.points})${c.progress ? ` — ${c.progress.current}/${c.progress.required}` : ''}`);
    return i.reply({ embeds: [new EmbedBuilder().setColor(0x2563EB).setTitle('🎯 Tes défis du jour')
      .setDescription((lines.join('\n') || 'Tous les défis du jour sont faits 🎉') + `\n\n${other} autre(s) défi(s) disponible(s) sur ${site()}/#challenges`)],
      flags: MessageFlags.Ephemeral });
  }

  if (name === 'parrainage') {
    const r = loyalty.referralInfo(u.id);
    return i.reply({ embeds: [new EmbedBuilder().setColor(0x059669).setTitle('🤝 Ton lien de parrainage')
      .setDescription(`${r.link}\n\nQuand un ami s'inscrit avec ce lien et valide son premier défi : **+${r.referrerReward} pts** pour toi, **+${r.refereeReward} pts** pour lui.\nFilleuls : ${r.count} (dont ${r.rewarded} actifs)`)],
      flags: MessageFlags.Ephemeral });
  }

  if (name === 'badges') {
    const list = loyalty.badgesOf(u.id);
    const have = list.filter(b => b.unlocked);
    return i.reply({ embeds: [new EmbedBuilder().setColor(0xA855F7).setTitle(`🏅 Badges de ${u.discord_username || u.username} (${have.length}/${list.length})`)
      .setDescription(list.map(b => `${b.unlocked ? b.icon : '🔒'} **${b.name}** — ${b.desc}`).join('\n'))] });
  }

  if (name === 'pileouface') {
    const r = games.coinflip(u.id, i.options.getInteger('mise'), i.options.getString('choix'));
    if (!r.ok) return i.reply({ content: r.message, flags: MessageFlags.Ephemeral });
    return i.reply({ embeds: [new EmbedBuilder().setColor(color(r)).setTitle('🪙 Pile ou face').setDescription(`${r.message}\nSolde : **${fmt(r.balance)} pts**`)] });
  }

  if (name === 'roulette') {
    const type = i.options.getString('pari');
    const value = i.options.getInteger('valeur');
    if ((type === 'numero' || type === 'douzaine') && value === null)
      return i.reply({ content: type === 'numero' ? 'Indique le numéro (0-36) dans « valeur ».' : 'Indique la douzaine (1, 2 ou 3) dans « valeur ».', flags: MessageFlags.Ephemeral });
    const r = games.roulette(u.id, i.options.getInteger('mise'), type, value);
    if (!r.ok) return i.reply({ content: r.message, flags: MessageFlags.Ephemeral });
    const dot = { rouge: '🔴', noir: '⚫', vert: '🟢' }[r.color];
    return i.reply({ embeds: [new EmbedBuilder().setColor(color(r)).setTitle(`🎡 Roulette : ${dot} ${r.number}`)
      .setDescription(`${r.message}\nSolde : **${fmt(r.balance)} pts**${r.badge ? '\n🏅 Badge débloqué : 🎰 Jackpot !' : ''}`)] });
  }

  if (name === 'blackjack') {
    const r = games.blackjackStart(u.id, i.options.getInteger('mise'));
    if (!r.ok) return i.reply({ content: r.message, flags: MessageFlags.Ephemeral });
    return i.reply(bjMessage(r, i.user.id));
  }
}

async function handle(i) {
  try {
    if (i.isButton()) return await handleButton(i);
    if (i.isChatInputCommand()) { await handleCommand(i); return true; }
  } catch (e) {
    console.error('[Commande Discord]', i.commandName || i.customId, e);
    const msg = { content: 'Oups, une erreur est survenue.', flags: MessageFlags.Ephemeral };
    if (i.replied || i.deferred) i.followUp(msg).catch(() => {}); else i.reply(msg).catch(() => {});
    return true;
  }
  return false;
}

module.exports = { register, handle, COMMANDS };
