'use strict';
/**
 * Notifications Discord via le bot :
 *  - demandes de validation postées dans le salon admin avec boutons Accepter / Refuser
 *  - MP aux membres (nouveau défi, défi validé / refusé)
 *
 * .env :
 *   DISCORD_ADMIN_CHANNEL_ID  salon où arrivent les demandes de validation
 *   DISCORD_ADMIN_ROLE_ID     (optionnel) rôle autorisé à valider ; sinon permission "Gérer le serveur"
 */
const path = require('path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { dbGet, dbAll, dbRun } = require('../models/db');

const UPLOADS = path.join(__dirname, '../../frontend/public/uploads');
const COLORS = { info: 0x2563EB, ok: 0x059669, ko: 0xDC2626, pending: 0xD97706 };
const PLATFORMS = { discord: 'Discord', twitch: 'Twitch', twitter: 'X (Twitter)', tiktok: 'TikTok', instagram: 'Instagram', epic: 'Epic Games' };

function siteUrl() {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  try { return new URL(process.env.DISCORD_REDIRECT_URI).origin; } catch { return ''; }
}
const client = () => require('./discord-bot').getClient();
const ready  = () => !!client()?.isReady();

// ── File d'attente des MP (≈1 / 1,5 s pour rester sous les limites anti-spam de Discord) ──
const queue = [];
let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const { discordId, payload } = queue.shift();
    try {
      const user = await client().users.fetch(discordId);
      await user.send(payload);
    } catch (e) {
      // 50007 = MP fermés par le membre : normal, on ignore
      if (e.code !== 50007) console.warn('[Notify] MP échoué', discordId, e.message);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  draining = false;
}
function queueDm(discordId, payload) {
  if (!ready() || !discordId) return false;
  queue.push({ discordId, payload });
  drain();
  return true;
}

// MP à un membre (respecte sa préférence notify_dm)
function dmUser(userId, embed) {
  const u = dbGet('SELECT discord_id, notify_dm FROM users WHERE id=?', [userId]);
  if (!u?.discord_id || !u.notify_dm) return false;
  return queueDm(u.discord_id, { embeds: [embed] });
}

// ── Nouveau défi → MP aux membres concernés ────────────────────────────────────
// Concernés : membres ayant lié le compte de la plateforme du défi (Twitch, X),
// tous les membres sinon ; uniquement ceux qui acceptent les MP.
function announceChallenge(ch) {
  if (!ready()) return 0;
  const where = { twitch: 'AND twitch_id IS NOT NULL', twitter: 'AND twitter_id IS NOT NULL' }[ch.platform] || '';
  const users = dbAll(`SELECT discord_id FROM users WHERE notify_dm=1 AND discord_id IS NOT NULL ${where}`);
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`🎯 Nouveau défi : ${ch.name}`)
    .setDescription(`${ch.description || ''}\n\n**+${ch.points} pts** · ${PLATFORMS[ch.platform] || ch.platform}`.trim())
    .setFooter({ text: 'K13 Loyalty · désactive ces messages depuis ton profil sur le site' });
  if (siteUrl()) embed.setURL(`${siteUrl()}/#challenges`);
  for (const u of users) queueDm(u.discord_id, { embeds: [embed] });
  return users.length;
}

// ── Résultat d'une validation → MP au membre ───────────────────────────────────
function notifyResult(userId, ch, approved, note) {
  return dmUser(userId, new EmbedBuilder()
    .setColor(approved ? COLORS.ok : COLORS.ko)
    .setTitle(approved ? `✅ Défi validé : ${ch.name}` : `❌ Défi refusé : ${ch.name}`)
    .setDescription(approved
      ? `**+${ch.points} pts** ajoutés à ton compte K13 Loyalty.${note ? `\n> ${note}` : ''}`
      : `Ta preuve n'a pas été acceptée.${note ? `\n> ${note}` : ''}\nTu peux en renvoyer une depuis le site.`));
}

// ── Demande de validation → salon admin avec boutons ───────────────────────────
async function sendPendingToAdmins(entryId) {
  const channelId = process.env.DISCORD_ADMIN_CHANNEL_ID;
  if (!channelId) return console.warn('[Notify] DISCORD_ADMIN_CHANNEL_ID non défini : demande', entryId, 'non envoyée sur Discord');
  // Bot pas (encore) connecté : la demande sera envoyée à sa connexion (postMissingPending)
  if (!ready()) return console.warn('[Notify] Bot Discord non connecté : demande', entryId, 'envoyée plus tard');
  const e = dbGet(`SELECT uc.*, u.discord_id, u.discord_username, u.username, u.twitter_username,
      c.name AS ch_name, c.points, c.platform, c.type, c.redirect_url
    FROM user_challenges uc JOIN users u ON u.id=uc.user_id JOIN challenges c ON c.id=uc.challenge_id WHERE uc.id=?`, [entryId]);
  if (!e || e.verified !== 0) return;
  try {
    const channel = await client().channels.fetch(channelId);
    const embed = new EmbedBuilder()
      .setColor(COLORS.pending)
      .setTitle(`⏳ Validation : ${e.ch_name}`)
      .addFields(
        { name: 'Membre', value: e.discord_id ? `<@${e.discord_id}>` : (e.discord_username || e.username), inline: true },
        { name: 'Points', value: `+${e.points}`, inline: true },
        { name: 'Plateforme', value: PLATFORMS[e.platform] || e.platform, inline: true },
      )
      .setTimestamp();
    if (e.twitter_username && e.platform === 'twitter') embed.addFields({ name: 'Compte X', value: `[@${e.twitter_username}](https://x.com/${e.twitter_username})`, inline: true });
    if (e.redirect_url) embed.addFields({ name: 'Lien du défi', value: e.redirect_url });
    if (!e.screenshot_path) embed.setDescription('Vérification automatique impossible (API X limitée) : contrôle manuellement.');

    const files = [];
    if (e.screenshot_path) {
      const name = path.basename(e.screenshot_path);
      files.push(new AttachmentBuilder(path.join(UPLOADS, name), { name }));
      embed.setImage(`attachment://${name}`);
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`k13:approve:${e.id}`).setLabel('Accepter').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`k13:reject:${e.id}`).setLabel('Refuser').setEmoji('✖️').setStyle(ButtonStyle.Danger),
    );
    const msg = await channel.send({ embeds: [embed], components: [row], files });
    dbRun('UPDATE user_challenges SET discord_msg_id=? WHERE id=?', [msg.id, e.id]);
  } catch (err) {
    console.warn('[Notify] envoi salon admin échoué:', err.message);
  }
}

// Met à jour le message du salon admin quand la demande est traitée (site ou Discord)
async function resolvePendingMessage(msgId, approved, byLabel) {
  const channelId = process.env.DISCORD_ADMIN_CHANNEL_ID;
  if (!ready() || !channelId || !msgId) return;
  try {
    const channel = await client().channels.fetch(channelId);
    const msg = await channel.messages.fetch(msgId);
    const embed = EmbedBuilder.from(msg.embeds[0])
      .setColor(approved ? COLORS.ok : COLORS.ko)
      .setTitle(msg.embeds[0].title.replace('⏳ Validation', approved ? '✅ Accepté' : '❌ Refusé'))
      .setFooter({ text: `${approved ? 'Accepté' : 'Refusé'} par ${byLabel}` });
    // Le screenshot est supprimé du serveur après traitement : on retire l'aperçu
    embed.setImage(null);
    await msg.edit({ embeds: [embed], components: [], attachments: [] });
  } catch (err) {
    console.warn('[Notify] maj message admin échouée:', err.message);
  }
}

async function deletePendingMessage(msgId) {
  const channelId = process.env.DISCORD_ADMIN_CHANNEL_ID;
  if (!ready() || !channelId || !msgId) return;
  try { await (await (await client().channels.fetch(channelId)).messages.fetch(msgId)).delete(); } catch {}
}

// Envoie les demandes en attente qui n'ont jamais été postées (bot hors ligne au moment de la demande)
async function postMissingPending() {
  if (!ready() || !process.env.DISCORD_ADMIN_CHANNEL_ID) return 0;
  const rows = dbAll('SELECT id FROM user_challenges WHERE verified=0 AND discord_msg_id IS NULL ORDER BY id LIMIT 50');
  for (const r of rows) await sendPendingToAdmins(r.id);
  if (rows.length) console.log(`[Notify] ${rows.length} demande(s) en attente postée(s) dans le salon admin`);
  return rows.length;
}

// Diagnostic complet (bouton "Tester Discord" de l'admin)
async function diagnose(testDiscordId) {
  const { PermissionFlagsBits } = require('discord.js');
  const out = { botReady: ready(), checks: [] };
  const add = (ok, label) => out.checks.push({ ok, label });
  if (!process.env.DISCORD_BOT_TOKEN) { add(false, 'DISCORD_BOT_TOKEN absent du .env'); return out; }
  if (!ready()) { add(false, 'Bot Discord non connecté : token invalide ou intents désactivés (voir les logs au démarrage)'); return out; }
  add(true, `Bot connecté : ${client().user.tag}`);
  const channelId = process.env.DISCORD_ADMIN_CHANNEL_ID;
  if (!channelId) add(false, 'DISCORD_ADMIN_CHANNEL_ID absent du .env');
  else {
    try {
      const channel = await client().channels.fetch(channelId);
      add(true, `Salon admin trouvé : #${channel.name}`);
      const perms = channel.permissionsFor(client().user);
      for (const [flag, label] of [['ViewChannel', 'Voir le salon'], ['SendMessages', 'Envoyer des messages'], ['EmbedLinks', 'Intégrer des liens'], ['AttachFiles', 'Joindre des fichiers'], ['ReadMessageHistory', "Voir l'historique"]])
        add(!!perms?.has(PermissionFlagsBits[flag]), `Permission « ${label} »`);
      await channel.send({ content: '🧪 Test K13 Loyalty : le bot peut poster les demandes de validation ici.' });
      add(true, 'Message de test envoyé dans le salon admin');
    } catch (e) {
      add(false, `Salon admin inaccessible (${e.message}) : vérifie l'ID et que le bot voit ce salon`);
    }
  }
  if (testDiscordId) {
    try {
      const user = await client().users.fetch(testDiscordId);
      await user.send('🧪 Test K13 Loyalty : les messages privés du bot fonctionnent.');
      add(true, `MP de test envoyé à ${user.username}`);
    } catch (e) {
      add(false, e.code === 50007 ? 'MP refusé : ce membre bloque les MP des membres du serveur (Paramètres → Confidentialité)' : `MP impossible (${e.message})`);
    }
  }
  add(true, `${dbGet('SELECT COUNT(*) AS c FROM users WHERE notify_dm=1 AND discord_id IS NOT NULL').c} membre(s) acceptent les MP`);
  return out;
}

// ── Giveaways ──────────────────────────────────────────────────────────────────
// Salon public des annonces (DISCORD_GIVEAWAY_CHANNEL_ID), sinon pas d'annonce publique
async function postToGiveawayChannel(payload) {
  const id = process.env.DISCORD_GIVEAWAY_CHANNEL_ID;
  if (!ready() || !id) return null;
  try { return await (await client().channels.fetch(id)).send(payload); }
  catch (e) { console.warn('[Notify] salon giveaway:', e.message); return null; }
}

const ts = iso => `<t:${Math.floor(new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z')).getTime() / 1000)}:R>`;

// Nouveau giveaway : annonce publique + MP optionnel aux membres
async function announceGiveaway(g, { dm = false } = {}) {
  const embed = new EmbedBuilder()
    .setColor(0xF59E0B)
    .setTitle(`🎁 GIVEAWAY : ${g.title}`)
    .setDescription(`**À gagner : ${g.prize}**\n${g.description || ''}\n\nFin du tirage ${ts(g.ends_at)} · ${g.winners_count} gagnant(s)\n👉 Participe sur le site K13 Loyalty !`)
    .setFooter({ text: 'Plus de tickets = plus de chances : rang, défis validés, tickets bonus' });
  if (siteUrl()) embed.setURL(`${siteUrl()}/#giveaways`);
  if (g.image_url) embed.setImage(g.image_url);
  await postToGiveawayChannel({ embeds: [embed] });
  let n = 0;
  if (dm) for (const u of dbAll('SELECT discord_id FROM users WHERE notify_dm=1 AND discord_id IS NOT NULL')) { queueDm(u.discord_id, { embeds: [embed] }); n++; }
  return n;
}

// Gagnants : annonce publique (mentions) + MP aux gagnants
async function announceGiveawayWinners(g, winners, { reroll = false } = {}) {
  const names = winners.map(w => w.discord_id ? `<@${w.discord_id}>` : (w.discord_username || w.username));
  const embed = new EmbedBuilder()
    .setColor(winners.length ? 0x059669 : 0x6B7280)
    .setTitle(`${reroll ? '🔁 Nouveau tirage' : '🎉 Résultat du giveaway'} : ${g.title}`)
    .setDescription(winners.length
      ? `Félicitations à ${names.join(', ')} qui remporte **${g.prize}** !`
      : 'Aucun participant éligible, pas de gagnant cette fois.');
  if (siteUrl()) embed.setURL(`${siteUrl()}/#giveaways`);
  await postToGiveawayChannel({ content: names.join(' ') || undefined, embeds: [embed],
    allowedMentions: { users: winners.map(w => w.discord_id).filter(Boolean) } });
  for (const w of winners) {
    if (!w.discord_id) continue;
    // Le MP au gagnant est envoyé même si les notifications sont coupées
    queueDm(w.discord_id, { embeds: [new EmbedBuilder().setColor(0x059669)
      .setTitle(`🏆 Tu as gagné le giveaway « ${g.title} » !`)
      .setDescription(`Tu remportes **${g.prize}**. L'équipe K13 va te contacter pour te remettre ton lot.`)] });
  }
}

module.exports = { ready, deletePendingMessage, postMissingPending, diagnose, siteUrl, dmUser, announceChallenge, notifyResult, sendPendingToAdmins, resolvePendingMessage,
  announceGiveaway, announceGiveawayWinners };
