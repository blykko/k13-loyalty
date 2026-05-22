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
  console.log('[Discord exchangeCode] client_id:', DISCORD_CLIENT_ID);
  console.log('[Discord exchangeCode] redirect_uri:', DISCORD_REDIRECT_URI);
  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code', code, redirect_uri: DISCORD_REDIRECT_URI,
    }),
  });
  const text = await res.text();
  console.log('[Discord exchangeCode] status:', res.status, '| body:', text.substring(0, 200));
  if (!res.ok) throw new Error('Discord token exchange failed: ' + text);
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
// Le bot Discord écoute les events et appelle ces fonctions
function recordMessage(discordId) {
  const user = dbGet('SELECT id FROM users WHERE discord_id=?', [discordId]);
  if (!user) return;
  const date = new Date().toISOString().split('T')[0];
  dbRun(`INSERT INTO discord_activity (user_id,date,messages,vocal_seconds) VALUES (?,?,1,0)
         ON CONFLICT(user_id,date) DO UPDATE SET messages=messages+1`,
    [user.id, date]);
  checkDiscordChallenges(user.id);
}

function recordVocalSeconds(discordId, seconds) {
  const user = dbGet('SELECT id FROM users WHERE discord_id=?', [discordId]);
  if (!user) return;
  const date = new Date().toISOString().split('T')[0];
  dbRun(`INSERT INTO discord_activity (user_id,date,messages,vocal_seconds) VALUES (?,?,0,?)
         ON CONFLICT(user_id,date) DO UPDATE SET vocal_seconds=vocal_seconds+?`,
    [user.id, date, seconds, seconds]);
  checkDiscordChallenges(user.id);
}

function getTotalMessages(userId) {
  const r = dbGet('SELECT COALESCE(SUM(messages),0) AS total FROM discord_activity WHERE user_id=?', [userId]);
  return r ? r.total : 0;
}

function getTodayVocalSeconds(userId) {
  const date = new Date().toISOString().split('T')[0];
  const r = dbGet('SELECT COALESCE(vocal_seconds,0) AS v FROM discord_activity WHERE user_id=? AND date=?', [userId, date]);
  return r ? r.v : 0;
}

function getTotalVocalSeconds(userId) {
  const r = dbGet('SELECT COALESCE(SUM(vocal_seconds),0) AS total FROM discord_activity WHERE user_id=?', [userId]);
  return r ? r.total : 0;
}

// ── Auto-check des challenges Discord après activité ──────────────────────────
function checkDiscordChallenges(userId) {
  const challenges = dbAll(`SELECT * FROM challenges WHERE platform='discord' AND active=1`);
  for (const ch of challenges) {
    const periodKey = getPeriodKey(ch);
    const alreadyDone = dbGet(
      `SELECT id FROM user_challenges WHERE user_id=? AND challenge_id=? AND (period_key=? OR period_key IS NULL)`,
      [userId, ch.id, periodKey]
    );
    if (alreadyDone) continue;

    let qualified = false;
    if (ch.type === 'messages') qualified = getTotalMessages(userId) >= ch.required_value;
    if (ch.type === 'vocal')    qualified = getTodayVocalSeconds(userId) >= ch.required_value;
    if (ch.type === 'join') {
      const user = dbGet('SELECT discord_id FROM users WHERE id=?', [userId]);
      if (user?.discord_id) qualified = true;
    }

    if (qualified) {
      dbRun(`INSERT OR IGNORE INTO user_challenges (user_id,challenge_id,verified,period_key) VALUES (?,?,1,?)`,
        [userId, ch.id, periodKey]);
      dbRun('UPDATE users SET points=points+?,last_seen=datetime("now") WHERE id=?', [ch.points, userId]);
      updateRank(userId);
      console.log(`[Discord] Challenge "${ch.name}" complété pour user ${userId} (+${ch.points} pts)`);
    }
  }
}

function getPeriodKey(challenge) {
  if (!challenge.repeat_seconds) return null;
  const now = Math.floor(Date.now() / 1000);
  return String(Math.floor(now / challenge.repeat_seconds));
}

function updateRank(userId) {
  const user = dbGet('SELECT points FROM users WHERE id=?', [userId]);
  if (!user) return;
  const rank = user.points >= 2000 ? 'gold' : user.points >= 1000 ? 'silver' : 'bronze';
  dbRun('UPDATE users SET rank=? WHERE id=?', [rank, userId]);
}

// ── Rôle par palier ────────────────────────────────────────────────────────────
const RANK_ROLES = {
  bronze: process.env.DISCORD_ROLE_BRONZE_ID,
  silver: process.env.DISCORD_ROLE_SILVER_ID,
  gold:   process.env.DISCORD_ROLE_GOLD_ID,
};
async function syncRoleForUser(userId) {
  const user = dbGet('SELECT discord_id,rank FROM users WHERE id=?', [userId]);
  if (!user?.discord_id) return;
  const roleId = RANK_ROLES[user.rank];
  if (roleId) await assignRole(user.discord_id, roleId);
}


// Appelé par le bot quand un nouveau membre rejoint
function checkDiscordChallenges_byDiscordId(discordId) {
  const user = dbGet('SELECT id FROM users WHERE discord_id=?', [discordId]);
  if (!user) return;
  checkDiscordChallenges(user.id);
}

// ── Invitations Discord ───────────────────────────────────────────────────────
// Table: discord_invites(id, inviter_id, invited_discord_id, created_at)
// Enregistre une invitation et crédite le challenge si seuil atteint

function recordInvite(inviterDiscordId, invitedDiscordId) {
  const inviter = dbGet('SELECT id FROM users WHERE discord_id=?', [inviterDiscordId]);
  if (!inviter) return; // L'invitant n'est pas inscrit sur le site

  // Évite les doublons
  const existing = dbGet(
    'SELECT id FROM discord_invites WHERE inviter_id=? AND invited_discord_id=?',
    [inviter.id, invitedDiscordId]
  );
  if (existing) return;

  dbRun('INSERT INTO discord_invites (inviter_id, invited_discord_id) VALUES (?,?)',
    [inviter.id, invitedDiscordId]);

  console.log(`[Discord] Invitation enregistrée : user ${inviter.id} a invité ${invitedDiscordId}`);
  checkInviteChallenges(inviter.id);
}

// Compte les invitations d'un user selon la période du challenge
function getInviteCount(userId, repeatSeconds) {
  if (!repeatSeconds) {
    return dbGet('SELECT COUNT(*) AS c FROM discord_invites WHERE inviter_id=?', [userId])?.c || 0;
  }
  // Pour les challenges quotidiens, compte uniquement aujourd'hui (Paris TZ)
  const paris = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const todayStart = `${paris.getFullYear()}-${String(paris.getMonth()+1).padStart(2,'0')}-${String(paris.getDate()).padStart(2,'0')} 00:00:00`;
  return dbGet(
    "SELECT COUNT(*) AS c FROM discord_invites WHERE inviter_id=? AND invited_at>=?",
    [userId, todayStart]
  )?.c || 0;
}

function checkInviteChallenges(userId) {
  const challenges = dbAll("SELECT * FROM challenges WHERE type='invite' AND active=1");
  for (const ch of challenges) {
    const periodKey = getPeriodKey(ch);
    const count = getInviteCount(userId, ch.repeat_seconds);
    if (count < ch.required_value) continue;

    // Vérifie si déjà validé pour cette période
    const query = periodKey
      ? 'SELECT id FROM user_challenges WHERE user_id=? AND challenge_id=? AND period_key=?'
      : 'SELECT id FROM user_challenges WHERE user_id=? AND challenge_id=?';
    const params = periodKey ? [userId, ch.id, periodKey] : [userId, ch.id];
    if (dbGet(query, params)) continue;

    dbRun('INSERT INTO user_challenges (user_id,challenge_id,verified,period_key) VALUES (?,?,1,?)',
      [userId, ch.id, periodKey]);
    dbRun('UPDATE users SET points=points+? WHERE id=?', [ch.points, userId]);
    updateRank(userId);
    console.log(`[Discord] Challenge invite "${ch.name}" validé pour user ${userId} (+${ch.points} pts)`);
  }
}


module.exports = {
  getAuthUrl, exchangeCode, refreshToken, getDiscordUser,
  checkGuildMember, assignRole, syncRoleForUser,
  recordMessage, recordVocalSeconds,
  getTotalMessages, getTodayVocalSeconds, getTotalVocalSeconds,
  checkDiscordChallenges, checkDiscordChallenges_byDiscordId, recordInvite, getInviteCount, checkInviteChallenges, updateRank,
};
