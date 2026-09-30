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
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${SE_JWT}`, 'Accept': 'application/json' },
  });
  const text = await res.text();
  if (res.status === 404) return { watchtime: 0, points: 0, found: false };
  if (!res.ok) throw new Error(`StreamElements API ${res.status}: ${text}`);
  const data = JSON.parse(text);
  // watchtime est en MINUTES dans SE
  const watchtimeSecs = (data.watchtime || 0) * 60;
  return { found: true, points: data.points || 0, watchtime: watchtimeSecs, rank: data.rank || 0 };
}

// ── Sync watchtime StreamElements → notre DB ───────────────────────────────────
// SE ne donne qu'un CUMUL. Pour que les challenges quotidiens/hebdo ne soient pas
// validés par le visionnage passé, on stocke :
//   - une ligne "de base" datée de 2000-01-01 (cumul au 1er sync → compte uniquement
//     pour les challenges permanents)
//   - puis une ligne par augmentation, datée du moment du sync.
// users.se_last_total mémorise le dernier cumul : un reset admin (suppression des
// lignes) remet donc réellement le compteur à zéro.
const SYNC_MIN_INTERVAL = 2 * 60 * 1000;
const lastSync = new Map();

async function syncWatchtimeForUser(userId, { force = false } = {}) {
  if (!isConfigured()) return null;

  const user = dbGet('SELECT twitch_login, se_last_total FROM users WHERE id=?', [userId]);
  if (!user?.twitch_login) return null;

  // Limite les appels à l'API SE (le dashboard se recharge souvent)
  const last = lastSync.get(userId) || 0;
  if (!force && Date.now() - last < SYNC_MIN_INTERVAL) return { synced: false, throttled: true };
  if (force && Date.now() - last < 15 * 1000) return { synced: false, throttled: true };
  lastSync.set(userId, Date.now());

  try {
    const seData = await getViewerWatchtime(user.twitch_login);
    if (!seData.found) return { synced: false, message: 'Viewer non trouvé sur StreamElements' };

    const total = seData.watchtime;
    if (user.se_last_total == null) {
      if (total > 0) dbRun(`INSERT INTO twitch_watch_sessions (user_id,started_at,ended_at,seconds,source)
             VALUES (?,'2000-01-01 00:00:00','2000-01-01 00:00:00',?,'se')`, [userId, total]);
      dbRun('UPDATE users SET se_last_total=? WHERE id=?', [total, userId]);
    } else if (total > user.se_last_total) {
      dbRun(`INSERT INTO twitch_watch_sessions (user_id,started_at,ended_at,seconds,source)
             VALUES (?,datetime('now'),datetime('now'),?,'se')`, [userId, total - user.se_last_total]);
      dbRun('UPDATE users SET se_last_total=? WHERE id=?', [total, userId]);
    } else if (total < user.se_last_total) {
      // Cumul SE remis à zéro côté StreamElements : on repart de la nouvelle valeur
      dbRun('UPDATE users SET se_last_total=? WHERE id=?', [total, userId]);
    }
    return { synced: true, watchtime: seData.watchtime };
  } catch (e) {
    console.error('[StreamElements] sync error:', e.message);
    return { synced: false, message: e.message };
  }
}

module.exports = { isConfigured, getViewerWatchtime, syncWatchtimeForUser };
