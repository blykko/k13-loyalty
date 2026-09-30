'use strict';
const fetch = require('node-fetch');
const { dbGet, dbRun, dbAll } = require('../models/db');

const {
  DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI,
  DISCORD_BOT_TOKEN,  DISCORD_GUILD_ID,
  DISCORD_ROLE_BRONZE_ID, DISCORD_ROLE_SILVER_ID, DISCORD_ROLE_GOLD_ID,
} = process.env;

// ── OAuth2 ─────────────────────────────────────────────────────────────────────
function getAuthUrl(state) {
  const p = new URLSearchParams({
    client_id:     DISCORD_CLIENT_ID,
    redirect_uri:  DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope:         'identify guilds guilds.join',
    state,
  });
  return `https://discord.com/oauth2/authorize?${p}`;
}

async function exchangeCode(code) {
  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code', code, redirect_uri: DISCORD_REDIRECT_URI,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Discord token exchange failed (${res.status}): ${text.substring(0, 200)}`);
  return JSON.parse(text);
}

async function refreshToken(refresh_token) {
  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'refresh_token', refresh_token,
    }),
  });
  if (!res.ok) throw new Error('Discord refresh failed');
  return res.json();
}

async function getDiscordUser(access_token) {
  const res = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!res.ok) throw new Error('Discord user fetch failed');
  return res.json(); // { id, username, avatar, discriminator }
}

// ── Vérifier si l'utilisateur est membre du serveur ────────────────────────────
async function checkGuildMember(discordId) {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) return false;
  const res = await fetch(
    `https://discord.com/api/guilds/${DISCORD_GUILD_ID}/members/${discordId}`,
    { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
  );
  return res.ok;
}

// ── Attribuer un rôle via le bot ───────────────────────────────────────────────
async function assignRole(discordId, roleId) {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID || !roleId) return false;
  const res = await fetch(
    `https://discord.com/api/guilds/${DISCORD_GUILD_ID}/members/${discordId}/roles/${roleId}`,
    { method: 'PUT', headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
  );
  return res.ok || res.status === 204;
}

// ── Activité Discord (alimentée par le bot) ────────────────────────────────────
// Les dates sont stockées en jour calendaire de Paris (comme les périodes des challenges)
const { parisDate } = require('./time');
// require paresseux : challenges.js dépend lui-même de ce module
const autoCheck = (...a) => require('./challenges').autoCheck(...a);

function recordMessage(discordId) {
  const user = dbGet('SELECT id FROM users WHERE discord_id=?', [discordId]);
  if (!user) return;
  dbRun(`INSERT INTO discord_activity (user_id,date,messages,vocal_seconds) VALUES (?,?,1,0)
         ON CONFLICT(user_id,date) DO UPDATE SET messages=messages+1`,
    [user.id, parisDate()]);
  autoCheck(user.id, { types: ['messages'], inGuild: true });
}

function recordVocalSeconds(discordId, seconds) {
  if (!seconds || seconds <= 0) return;
  const user = dbGet('SELECT id FROM users WHERE discord_id=?', [discordId]);
  if (!user) return;
  dbRun(`INSERT INTO discord_activity (user_id,date,messages,vocal_seconds) VALUES (?,?,0,?)
         ON CONFLICT(user_id,date) DO UPDATE SET vocal_seconds=vocal_seconds+?`,
    [user.id, parisDate(), seconds, seconds]);
  autoCheck(user.id, { types: ['vocal'], inGuild: true });
}

// Vérifie les challenges Discord d'un utilisateur.
// inGuild=true uniquement si on sait qu'il est membre du serveur (event du bot, API vérifiée)
function checkDiscordChallenges(userId, inGuild = false) {
  autoCheck(userId, { types: ['messages', 'vocal', 'invite'], inGuild });
}

// Appelé par le bot quand un nouveau membre rejoint
function checkDiscordChallenges_byDiscordId(discordId) {
  const user = dbGet('SELECT id FROM users WHERE discord_id=?', [discordId]);
  if (user) checkDiscordChallenges(user.id, true);
}

// ── Rôle par palier ────────────────────────────────────────────────────────────
const RANK_ROLES = {
  bronze: DISCORD_ROLE_BRONZE_ID,
  silver: DISCORD_ROLE_SILVER_ID,
  gold:   DISCORD_ROLE_GOLD_ID,
};
async function removeRole(discordId, roleId) {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID || !roleId) return false;
  const res = await fetch(
    `https://discord.com/api/guilds/${DISCORD_GUILD_ID}/members/${discordId}/roles/${roleId}`,
    { method: 'DELETE', headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
  );
  return res.ok;
}
// Donne le rôle du palier actuel et retire ceux des autres paliers
async function syncRoleForUser(userId) {
  const user = dbGet('SELECT discord_id,rank FROM users WHERE id=?', [userId]);
  if (!user?.discord_id) return;
  for (const [rank, roleId] of Object.entries(RANK_ROLES)) {
    if (!roleId) continue;
    if (rank === user.rank) await assignRole(user.discord_id, roleId);
    else await removeRole(user.discord_id, roleId);
  }
}

// ── Invitations Discord ───────────────────────────────────────────────────────
function recordInvite(inviterDiscordId, invitedDiscordId) {
  if (inviterDiscordId === invitedDiscordId) return;
  const inviter = dbGet('SELECT id FROM users WHERE discord_id=?', [inviterDiscordId]);
  if (!inviter) return; // L'invitant n'est pas inscrit sur le site

  // Une même personne ne compte qu'une fois (même si elle quitte et revient)
  const existing = dbGet('SELECT id FROM discord_invites WHERE invited_discord_id=?', [invitedDiscordId]);
  if (existing) return;

  dbRun('INSERT INTO discord_invites (inviter_id, invited_discord_id) VALUES (?,?)',
    [inviter.id, invitedDiscordId]);
  console.log(`[Discord] Invitation enregistrée : user ${inviter.id} a invité ${invitedDiscordId}`);
  autoCheck(inviter.id, { types: ['invite'] });
}

// Nombre d'invitations depuis une date SQL UTC (null = depuis toujours)
function getInviteCount(userId, sinceSql = null) {
  if (!sinceSql) return dbGet('SELECT COUNT(*) AS c FROM discord_invites WHERE inviter_id=?', [userId])?.c || 0;
  return dbGet('SELECT COUNT(*) AS c FROM discord_invites WHERE inviter_id=? AND invited_at>=?', [userId, sinceSql])?.c || 0;
}

module.exports = {
  getAuthUrl, exchangeCode, refreshToken, getDiscordUser,
  checkGuildMember, assignRole, removeRole, syncRoleForUser,
  recordMessage, recordVocalSeconds,
  checkDiscordChallenges, checkDiscordChallenges_byDiscordId, recordInvite, getInviteCount,
};
