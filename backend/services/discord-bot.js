'use strict';
/**
 * Bot Discord K13 Loyalty
 * Écoute les events du serveur et crédite les points automatiquement.
 *
 * Permissions requises pour le bot (lors de l'invitation) :
 *   - Read Messages/View Channels
 *   - Read Message History
 *   - Connect (vocal)
 *
 * Intents à activer sur discord.com/developers → ton app → Bot :
 *   ✅ SERVER MEMBERS INTENT
 *   ✅ MESSAGE CONTENT INTENT
 *   ✅ PRESENCE INTENT (optionnel, pour le vocal)
 */

const { Client, GatewayIntentBits, Events, PermissionFlagsBits } = require('discord.js');
const discord = require('./discord');
const { recordInvite } = require('./discord');

let client = null;

// Map pour tracker les sessions vocales en cours : discordId → { channelId, joinedAt }
const vocalSessions = new Map();

// Intervalle de sauvegarde du temps vocal (toutes les 60s)
let vocalInterval = null;

function startBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || token.includes('TON_BOT_TOKEN')) {
    console.log('[Bot Discord] Token non configuré — bot désactivé.');
    return;
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildInvites,
    ],
  });

  // Cache des invitations (inviteCode → { uses, inviterId })
  const inviteCache = new Map();

  client.once(Events.ClientReady, async c => {
    console.log(`[Bot Discord] Connecté en tant que ${c.user.tag}`);
    vocalInterval = setInterval(() => saveAllVocalSessions(), 60_000);
    // Charge les invitations existantes au démarrage
    try {
      const guild = await c.guilds.fetch(guildId);
      const invites = await guild.invites.fetch();
      invites.forEach(inv => inviteCache.set(inv.code, { uses: inv.uses, inviterId: inv.inviter?.id }));
      console.log(`[Bot Discord] ${invites.size} invitations en cache`);
    } catch(e) { console.warn('[Bot Discord] Impossible de charger les invitations:', e.message); }
  });

  // Met à jour le cache quand une nouvelle invitation est créée
  client.on('inviteCreate', invite => {
    inviteCache.set(invite.code, { uses: invite.uses || 0, inviterId: invite.inviter?.id });
  });

  // ── Messages ────────────────────────────────────────────────────────────────
  client.on(Events.MessageCreate, message => {
    // Ignore les bots et les DM
    if (message.author.bot) return;
    if (!message.guild || message.guild.id !== guildId) return;
    // Ignore les messages trop courts (anti-spam)
    if (message.content.trim().length < 2) return;

    discord.recordMessage(message.author.id);
  });

  // ── Vocal ───────────────────────────────────────────────────────────────────
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if (!newState.guild || newState.guild.id !== guildId) return;
    const userId = newState.member?.user?.id;
    if (!userId || newState.member?.user?.bot) return;

    const wasInVoice = !!oldState.channelId;
    const isInVoice  = !!newState.channelId;

    if (!wasInVoice && isInVoice) {
      // Rejoint un salon vocal
      vocalSessions.set(userId, { channelId: newState.channelId, joinedAt: Date.now() });
      console.log(`[Bot Discord] ${userId} rejoint le vocal #${newState.channel?.name}`);
    } else if (wasInVoice && !isInVoice) {
      // Quitte le salon vocal
      const session = vocalSessions.get(userId);
      if (session) {
        const seconds = Math.floor((Date.now() - session.joinedAt) / 1000);
        if (seconds > 30) { // Ignore les passages < 30s
          discord.recordVocalSeconds(userId, seconds);
          console.log(`[Bot Discord] ${userId} vocal ${seconds}s enregistrés`);
        }
        vocalSessions.delete(userId);
      }
    } else if (wasInVoice && isInVoice && oldState.channelId !== newState.channelId) {
      // Change de salon — sauvegarde l'ancien et démarre un nouveau
      const session = vocalSessions.get(userId);
      if (session) {
        const seconds = Math.floor((Date.now() - session.joinedAt) / 1000);
        if (seconds > 30) discord.recordVocalSeconds(userId, seconds);
      }
      vocalSessions.set(userId, { channelId: newState.channelId, joinedAt: Date.now() });
    }
  });

  // ── Nouveau membre + tracking invitation ────────────────────────────────────
  client.on(Events.GuildMemberAdd, async member => {
    if (member.guild.id !== guildId) return;
    console.log(`[Bot Discord] Nouveau membre : ${member.user.id}`);
    discord.checkDiscordChallenges_byDiscordId(member.user.id);

    // Identifie qui a invité ce nouveau membre
    try {
      const newInvites = await member.guild.invites.fetch();
      // Trouve l'invitation dont le compteur a augmenté
      let inviterDiscordId = null;
      newInvites.forEach(inv => {
        const cached = inviteCache.get(inv.code);
        if (cached && inv.uses > cached.uses && inv.inviter?.id) {
          inviterDiscordId = inv.inviter.id;
        }
        // Met à jour le cache
        inviteCache.set(inv.code, { uses: inv.uses, inviterId: inv.inviter?.id });
      });

      if (inviterDiscordId) {
        console.log(`[Bot Discord] Invitation par Discord ID: ${inviterDiscordId}`);
        discord.recordInvite(inviterDiscordId, member.user.id);
      }
    } catch(e) { console.warn('[Bot Discord] Invite tracking error:', e.message); }
  });

  client.login(token).catch(err => {
    console.error('[Bot Discord] Erreur de connexion :', err.message);
    console.error('→ Vérifie que DISCORD_BOT_TOKEN est correct dans .env');
  });
}

// Sauvegarde périodique des sessions vocales actives (au cas où le bot redémarre)
function saveAllVocalSessions() {
  for (const [userId, session] of vocalSessions.entries()) {
    const seconds = Math.floor((Date.now() - session.joinedAt) / 1000);
    if (seconds > 30) {
      discord.recordVocalSeconds(userId, seconds);
      // Remet le timer à zéro pour éviter de double-compter
      vocalSessions.set(userId, { ...session, joinedAt: Date.now() });
    }
  }
}

function stopBot() {
  if (vocalInterval) clearInterval(vocalInterval);
  saveAllVocalSessions();
  client?.destroy();
}

module.exports = { startBot, stopBot };
