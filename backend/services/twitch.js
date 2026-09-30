'use strict';
const fetch = require('node-fetch');
const { dbGet, dbRun } = require('../models/db');
const { fromSql } = require('./time');

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

// Token d'application mis en cache jusqu'à expiration (au lieu d'un nouveau token à chaque appel)
let appToken = null, appTokenExp = 0;
async function getAppToken() {
  if (appToken && Date.now() < appTokenExp) return appToken;
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_CLIENT_SECRET, grant_type: 'client_credentials' }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error('Twitch app token: ' + (data.message || res.status));
  appToken = data.access_token;
  appTokenExp = Date.now() + Math.max(60, (data.expires_in || 3600) - 300) * 1000;
  return appToken;
}

// ID de la chaîne K13 (ne change jamais → mis en cache)
let broadcasterId = null;
async function getBroadcasterId() {
  if (broadcasterId) return broadcasterId;
  const token = await getAppToken();
  const res = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(TWITCH_CHANNEL_LOGIN)}`, {
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID },
  });
  const id = (await res.json()).data?.[0]?.id;
  if (!id) throw new Error(`Chaîne "${TWITCH_CHANNEL_LOGIN}" introuvable sur Twitch.`);
  return (broadcasterId = id);
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
  
  const broadcasterId = await getBroadcasterId();

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

  const broadcasterId = await getBroadcasterId();

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

// Statut live mis en cache 60 s (appelé à chaque ping du tracker et affichage du dashboard)
let liveCache = { value: false, at: 0 };
async function isChannelLive() {
  if (Date.now() - liveCache.at < 60_000) return liveCache.value;
  try {
    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return false;
    const token = await getAppToken();
    const res = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(TWITCH_CHANNEL_LOGIN)}`, {
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID },
    });
    const data = await res.json();
    liveCache = { value: data.data?.length > 0, at: Date.now() };
  } catch (e) {
    console.error('[Twitch] isChannelLive error:', e.message);
    liveCache = { value: false, at: Date.now() };
  }
  return liveCache.value;
}

// ── Tracker manuel (utilisé seulement si StreamElements n'est pas configuré) ──
const PING_MAX_GAP = 120; // un ping crédite au maximum 2 min

function startWatchSession(userId) {
  // Réutilise une session encore active (autre onglet) pour éviter le double comptage
  const active = dbGet(`SELECT id FROM twitch_watch_sessions WHERE user_id=? AND source='tracker'
    AND COALESCE(ended_at,started_at) >= datetime('now','-3 minutes') ORDER BY id DESC`, [userId]);
  if (active) return active.id;
  return dbRun("INSERT INTO twitch_watch_sessions (user_id,started_at,ended_at,seconds,source) VALUES (?,datetime('now'),datetime('now'),0,'tracker')", [userId]).lastInsertRowid;
}
function updateWatchSession(sessionId, userId, live = true) {
  const row = dbGet("SELECT started_at, seconds, ended_at FROM twitch_watch_sessions WHERE id=? AND user_id=? AND source='tracker'", [sessionId, userId]);
  if (!row) return 0;
  // Delta depuis le dernier ping, plafonné ; rien n'est crédité si le live est terminé
  const lastPing = fromSql(row.ended_at || row.started_at).getTime();
  const delta = live ? Math.max(0, Math.min(Math.floor((Date.now() - lastPing) / 1000), PING_MAX_GAP)) : 0;
  const newTotal = (row.seconds || 0) + delta;
  dbRun("UPDATE twitch_watch_sessions SET seconds=?,ended_at=datetime('now') WHERE id=?", [newTotal, sessionId]);
  return newTotal;
}
function endWatchSession(sessionId, userId, live = true) { return updateWatchSession(sessionId, userId, live); }
function getTotalWatchSeconds(userId) {
  return dbGet('SELECT COALESCE(SUM(seconds),0) AS t FROM twitch_watch_sessions WHERE user_id=?', [userId])?.t || 0;
}

module.exports = { getAuthUrl, exchangeCode, getTwitchUser, checkFollow, checkSub, isChannelLive, startWatchSession, updateWatchSession, endWatchSession, getTotalWatchSeconds };
