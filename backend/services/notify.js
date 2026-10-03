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
  if (!ready() || !channelId) return;
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

module.exports = { ready, deletePendingMessage, siteUrl, dmUser, announceChallenge, notifyResult, sendPendingToAdmins, resolvePendingMessage };
