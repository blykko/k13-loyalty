'use strict';
const fetch = require('node-fetch');
const { dbGet, dbRun } = require('../models/db');

const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_REDIRECT_URI, TWITCH_CHANNEL_LOGIN } = process.env;

// Scope étendu pour follow + sub
function getAuthUrl(state) {
  const p = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID, redirect_uri: TWITCH_REDIRECT_URI,
    response_type: 'code',
    scope: 'user:read:follows user:read:subscriptions',
    state,
  });
  return `https://id.twitch.tv/oauth2/authorize?${p}`;
}

async function getAppToken() {
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_CLIENT_SECRET, grant_type: 'client_credentials' }),
  });
  return (await res.json()).access_token;
}

async function exchangeCode(code) {
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: TWITCH_REDIRECT_URI }),
  });
  if (!res.ok) throw new Error('Twitch token exchange: ' + await res.text());
  return res.json();
}

async function refreshUserToken(refresh_token) {
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token }),
  });
  if (!res.ok) throw new Error('Twitch refresh failed');
  return res.json();
}

async function getTwitchUser(access_token) {
  const res = await fetch('https://api.twitch.tv/helix/users', {
    headers: { Authorization: `Bearer ${access_token}`, 'Client-Id': TWITCH_CLIENT_ID },
  });
  if (!res.ok) throw new Error('Twitch user fetch failed');
  return (await res.json()).data[0];
}

async function getValidToken(userId) {
  const user = dbGet('SELECT twitch_token,twitch_refresh FROM users WHERE id=?', [userId]);
  if (!user?.twitch_token) throw new Error('Compte Twitch non lié.');
  // Vérifie si le token est valide
  const test = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: `OAuth ${user.twitch_token}` },
  });
  if (test.ok) return user.twitch_token;
  // Refresh
  const refreshed = await refreshUserToken(user.twitch_refresh);
  dbRun('UPDATE users SET twitch_token=?,twitch_refresh=? WHERE id=?',
    [refreshed.access_token, refreshed.refresh_token, userId]);
  return refreshed.access_token;
}

async function checkFollow(userId) {
  const user  = dbGet('SELECT twitch_id FROM users WHERE id=?', [userId]);
  if (!user?.twitch_id) throw new Error('Compte Twitch non lié.');
  const token = await getValidToken(userId);
  
  const appToken = await getAppToken();
  const chanRes  = await fetch(`https://api.twitch.tv/helix/users?login=${TWITCH_CHANNEL_LOGIN}`, {
    headers: { Authorization: `Bearer ${appToken}`, 'Client-Id': TWITCH_CLIENT_ID },
  });
  const chanData = await chanRes.json();
  if (!chanData.data?.length) throw new Error(`Chaîne "${TWITCH_CHANNEL_LOGIN}" introuvable sur Twitch.`);
  const broadcasterId = chanData.data[0].id;

  const res = await fetch(
    `https://api.twitch.tv/helix/channels/followed?user_id=${user.twitch_id}&broadcaster_id=${broadcasterId}`,
    { headers: { Authorization: `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID } }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Erreur API Twitch: ${res.status} ${err}`);
  }
  const data = await res.json();
  return data.data?.length > 0;
}

async function checkSub(userId) {
  // Vérifie un abonnement (sub ou prime) via user:read:subscriptions
  const user  = dbGet('SELECT twitch_id FROM users WHERE id=?', [userId]);
  if (!user?.twitch_id) throw new Error('Compte Twitch non lié.');
  const token = await getValidToken(userId);

  const appToken = await getAppToken();
  const chanRes  = await fetch(`https://api.twitch.tv/helix/users?login=${TWITCH_CHANNEL_LOGIN}`, {
    headers: { Authorization: `Bearer ${appToken}`, 'Client-Id': TWITCH_CLIENT_ID },
  });
  const broadcasterId = (await chanRes.json()).data?.[0]?.id;
  if (!broadcasterId) throw new Error('Chaîne K13 introuvable.');

  // GET /helix/subscriptions/user — vérifie si l'utilisateur est abonné
  const res = await fetch(
    `https://api.twitch.tv/helix/subscriptions/user?broadcaster_id=${broadcasterId}&user_id=${user.twitch_id}`,
    { headers: { Authorization: `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID } }
  );
  // 404 = pas abonné, 200 = abonné
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Erreur API sub Twitch: ${res.status}`);
  const data = await res.json();
  return data.data?.length > 0;
}

async function isChannelLive() {
  try {
    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
      console.warn('[Twitch] CLIENT_ID ou CLIENT_SECRET manquant dans .env');
      return false;
    }
    const token = await getAppToken();
    const res = await fetch(`https://api.twitch.tv/helix/streams?user_login=${TWITCH_CHANNEL_LOGIN}`, {
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID },
    });
    const data = await res.json();
    console.log(`[Twitch] isChannelLive → ${TWITCH_CHANNEL_LOGIN}: ${data.data?.length > 0 ? 'EN LIVE ✅' : 'hors ligne'}`);
    return data.data?.length > 0;
  } catch (e) {
    console.error('[Twitch] isChannelLive error:', e.message);
    return false;
  }
}

function startWatchSession(userId) {
  return dbRun('INSERT INTO twitch_watch_sessions (user_id,started_at,seconds) VALUES (?,datetime("now"),0)', [userId]).lastInsertRowid;
}
function updateWatchSession(sessionId, userId) {
  // Récupère la session et la dernière mise à jour
  const row = dbGet('SELECT started_at, seconds, ended_at FROM twitch_watch_sessions WHERE id=? AND user_id=?', [sessionId, userId]);
  if (!row) return 0;
  // Calcule le delta depuis le dernier ping (ended_at), pas depuis started_at
  const lastPing = row.ended_at ? new Date(row.ended_at).getTime() : new Date(row.started_at).getTime();
  const delta    = Math.floor((Date.now() - lastPing) / 1000);
  // Plafonne le delta à 120s (2 pings max) pour éviter les dérives
  const safeDelta = Math.min(delta, 120);
  const newTotal  = (row.seconds || 0) + safeDelta;
  dbRun('UPDATE twitch_watch_sessions SET seconds=?,ended_at=datetime("now") WHERE id=? AND user_id=?', [newTotal, sessionId, userId]);
  return newTotal;
}
function endWatchSession(sessionId, userId) { return updateWatchSession(sessionId, userId); }
function getTotalWatchSeconds(userId) {
  return dbGet('SELECT COALESCE(SUM(seconds),0) AS t FROM twitch_watch_sessions WHERE user_id=?', [userId])?.t || 0;
}

module.exports = { getAuthUrl, exchangeCode, getTwitchUser, checkFollow, checkSub, isChannelLive, startWatchSession, updateWatchSession, endWatchSession, getTotalWatchSeconds };
