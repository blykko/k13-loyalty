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

const { Client, GatewayIntentBits, Events, PermissionFlagsBits, MessageFlags } = require('discord.js');
const discord = require('./discord');

let client = null;

// Map pour tracker les sessions vocales en cours : discordId → { channelId, joinedAt }
const vocalSessions = new Map();

// Intervalle de sauvegarde du temps vocal (toutes les 60s)
let vocalInterval = null;

// Anti-spam : un message compte au maximum toutes les MESSAGE_COOLDOWN_MS par membre
const MESSAGE_COOLDOWN_MS = 3000;
const lastMessageAt = new Map();

// Un membre compte en vocal s'il est dans un salon qui n'est pas l'AFK et qu'il n'est pas sourd
function countsAsVocal(state) {
  if (!state?.channelId) return false;
  if (state.guild?.afkChannelId && state.channelId === state.guild.afkChannelId) return false;
  if (state.selfDeaf || state.serverDeaf) return false;
  return true;
}

// Clôture la session vocale en cours et enregistre le temps
function flushVocal(userId) {
  const session = vocalSessions.get(userId);
  if (!session) return;
  vocalSessions.delete(userId);
  const seconds = Math.floor((Date.now() - session.joinedAt) / 1000);
  // Les passages de moins de 30s (hors sessions déjà créditées périodiquement) sont ignorés
  if (seconds > 0 && (seconds >= 30 || session.credited)) discord.recordVocalSeconds(userId, seconds);
}

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
    if (!process.env.DISCORD_ADMIN_CHANNEL_ID) console.warn('[Bot Discord] DISCORD_ADMIN_CHANNEL_ID non défini : pas de validations sur Discord');
    require('./discord-commands').register(c).catch(() => {});
    // Demandes créées pendant que le bot était hors ligne
    setTimeout(() => require('./notify').postMissingPending().catch(e => console.warn('[Notify]', e.message)), 3000);
    vocalInterval = setInterval(() => {
      saveAllVocalSessions();
      const limit = Date.now() - MESSAGE_COOLDOWN_MS;
      for (const [id, t] of lastMessageAt) if (t < limit) lastMessageAt.delete(id);
    }, 60_000);
    // Charge les invitations existantes au démarrage
    try {
      const guild = await c.guilds.fetch(guildId);
      // Reprend les membres déjà en vocal au démarrage du bot
      guild.voiceStates.cache.forEach(vs => {
        if (!vs.member?.user?.bot && countsAsVocal(vs)) vocalSessions.set(vs.id, { channelId: vs.channelId, joinedAt: Date.now() });
      });
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
    // Ignore les messages trop courts et le flood (anti-spam)
    if (message.content.trim().length < 2) return;
    const now = Date.now();
    if (now - (lastMessageAt.get(message.author.id) || 0) < MESSAGE_COOLDOWN_MS) return;
    lastMessageAt.set(message.author.id, now);

    discord.recordMessage(message.author.id);
  });

  // ── Vocal ───────────────────────────────────────────────────────────────────
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if (!newState.guild || newState.guild.id !== guildId) return;
    const userId = newState.member?.user?.id;
    if (!userId || newState.member?.user?.bot) return;

    const wasCounting = vocalSessions.has(userId);
    const counts = countsAsVocal(newState);

    if (wasCounting && (!counts || oldState.channelId !== newState.channelId)) flushVocal(userId);
    if (counts && !vocalSessions.has(userId)) {
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

  // ── Boutons Accepter / Refuser du salon admin ─────────────────────────────
  client.on(Events.InteractionCreate, async interaction => {
    // Commandes slash (/daily, /points, jeux…) et boutons du blackjack
    if (await require('./discord-commands').handle(interaction)) return;
    if (!interaction.isButton()) return;
    const m = interaction.customId.match(/^k13:(approve|reject):(\d+)$/);
    if (!m) return;
    const roleId = process.env.DISCORD_ADMIN_ROLE_ID;
    const member = interaction.member;
    const allowed = roleId
      ? member?.roles?.cache?.has(roleId)
      : interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!allowed) {
      return interaction.reply({ content: '⛔ Tu n\'as pas la permission de valider les défis.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    // Évite le message "l'interaction a échoué" pendant le traitement
    await interaction.deferUpdate().catch(() => {});
    const ch = require('./challenges');
    const by = interaction.user.globalName || interaction.user.username;
    const res = m[1] === 'approve' ? ch.approvePending(+m[2], { by }) : ch.rejectPending(+m[2], { by });
    if (!res.ok) {
      // Déjà traitée (ex. depuis le site) : on retire les boutons
      await interaction.message.edit({ components: [] }).catch(() => {});
      await interaction.followUp({ content: `ℹ️ ${res.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  client.login(token).catch(err => {
    console.error('[Bot Discord] Erreur de connexion :', err.message);
    console.error('→ Vérifie que DISCORD_BOT_TOKEN est correct dans .env');
  });
}

// Sauvegarde périodique des sessions vocales actives (au cas où le bot redémarre)
function saveAllVocalSessions() {
  const now = Date.now();
  for (const [userId, session] of vocalSessions.entries()) {
    const seconds = Math.floor((now - session.joinedAt) / 1000);
    if (seconds >= 30) {
      discord.recordVocalSeconds(userId, seconds);
      // Remet le timer à zéro pour éviter de double-compter
      vocalSessions.set(userId, { ...session, joinedAt: now, credited: true });
    }
  }
}

function stopBot() {
  if (vocalInterval) clearInterval(vocalInterval);
  for (const userId of [...vocalSessions.keys()]) flushVocal(userId);
  client?.destroy();
}

const getClient = () => client;

module.exports = { startBot, stopBot, getClient };
