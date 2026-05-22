'use strict';
const fetch = require('node-fetch');
const { dbGet, dbRun } = require('../models/db');

// ── Config ─────────────────────────────────────────────────────────────────────
// STREAMELEMENTS_JWT     = ton JWT token (Dashboard → Mon Compte → Show Secrets → API Token)
// STREAMELEMENTS_CHANNEL = ton channel ID StreamElements (visible dans l'URL de ton dashboard)
//                          Ex: https://streamelements.com/dashboard/loyalty → ID dans l'URL
const SE_JWT     = process.env.STREAMELEMENTS_JWT;
const SE_CHANNEL = process.env.STREAMELEMENTS_CHANNEL_ID;
const BASE       = 'https://api.streamelements.com/kappa/v2';

function isConfigured() {
  return !!(SE_JWT && SE_CHANNEL);
}

// ── Récupère le watchtime d'un viewer depuis StreamElements ───────────────────
// Endpoint : GET /points/{channel}/{username}
// Retourne les points ET le watchtime (en secondes)
async function getViewerWatchtime(twitchUsername) {
  if (!isConfigured()) throw new Error('StreamElements non configuré');
  const url = `${BASE}/points/${SE_CHANNEL}/${encodeURIComponent(twitchUsername)}`;
  console.log('[SE] GET', url);
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${SE_JWT}`, 'Accept': 'application/json' },
  });
  const text = await res.text();
  console.log('[SE] Status:', res.status, '| Body:', text.substring(0, 200));
  if (res.status === 404) return { watchtime: 0, points: 0, found: false };
  if (!res.ok) throw new Error(`StreamElements API ${res.status}: ${text}`);
  const data = JSON.parse(text);
  // watchtime est en MINUTES dans SE
  const watchtimeSecs = (data.watchtime || 0) * 60;
  console.log(`[SE] ${twitchUsername} → watchtime: ${data.watchtime} min = ${watchtimeSecs} sec | points: ${data.points}`);
  return { found: true, points: data.points || 0, watchtime: watchtimeSecs, rank: data.rank || 0 };
}

// ── Sync watchtime StreamElements → notre DB ───────────────────────────────────
// Appelé quand un utilisateur veut valider un challenge watchtime
// Récupère les données SE et les stocke comme une session Twitch unique
async function syncWatchtimeForUser(userId) {
  if (!isConfigured()) return null;

  const user = dbGet('SELECT twitch_login FROM users WHERE id=?', [userId]);
  if (!user?.twitch_login) return null;

  try {
    const seData = await getViewerWatchtime(user.twitch_login);
    if (!seData.found) return { synced: false, message: 'Viewer non trouvé sur StreamElements' };

    // Stocke comme une session "se_sync" horodatée
    // On utilise un slug spécial pour distinguer des sessions manuelles
    const existingSync = dbGet(
      "SELECT id, seconds FROM twitch_watch_sessions WHERE user_id=? AND ended_at='se_sync'",
      [userId]
    );

    if (existingSync) {
      // Met à jour seulement si le nouveau total est plus grand
      if (seData.watchtime > existingSync.seconds) {
        dbRun(
          "UPDATE twitch_watch_sessions SET seconds=?, started_at=datetime('now') WHERE id=?",
          [seData.watchtime, existingSync.id]
        );
      }
    } else {
      dbRun(
        "INSERT INTO twitch_watch_sessions (user_id, started_at, ended_at, seconds) VALUES (?, datetime('now'), 'se_sync', ?)",
        [userId, seData.watchtime]
      );
    }

    return { synced: true, watchtime: seData.watchtime, watchtimeH: (seData.watchtime/3600).toFixed(1) };
  } catch (e) {
    console.error('[StreamElements] sync error:', e.message);
    return { synced: false, message: e.message };
  }
}

// ── Vérifie le watchtime pour un challenge donné ───────────────────────────────
async function checkWatchtimeForChallenge(userId, requiredSeconds) {
  // D'abord sync avec SE
  const sync = await syncWatchtimeForUser(userId);

  // Calcule le total depuis notre DB (inclut sessions manuelles + sync SE)
  const total = (dbGet('SELECT COALESCE(SUM(seconds),0) AS t FROM twitch_watch_sessions WHERE user_id=?', [userId])?.t) || 0;

  return {
    total,
    totalH: (total / 3600).toFixed(1),
    required: requiredSeconds,
    ok: total >= requiredSeconds,
    seSync: sync,
  };
}

module.exports = { isConfigured, getViewerWatchtime, syncWatchtimeForUser, checkWatchtimeForChallenge };
