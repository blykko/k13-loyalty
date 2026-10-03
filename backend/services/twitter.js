'use strict';
const fetch  = require('node-fetch');
const crypto = require('crypto');
const { dbGet, dbRun } = require('../models/db');

const {
  TWITTER_CLIENT_ID, TWITTER_CLIENT_SECRET,
  TWITTER_REDIRECT_URI, TWITTER_ACCOUNT_TO_FOLLOW,
} = process.env;

// Twitter / X — OAuth 2.0 avec PKCE
// Portail developer.x.com → App → User authentication settings :
//   OAuth 2.0 : ON · Type : Web App · Callback : https://loyalty.k13-esport.com/auth/twitter/callback
// Utiliser le "OAuth 2.0 Client ID" (pas la Consumer Key).
//
// ⚠️ Accès API selon l'offre X :
//   Free  : liaison du compte uniquement
//   Basic : likes, retweets, réponses vérifiables
//   follow (GET /users/:id/following) : non disponible en Free/Basic
// Quand l'API refuse (403/429), la vérification bascule en validation manuelle.

const API = 'https://api.twitter.com/2';
const SCOPES = 'tweet.read users.read follows.read like.read offline.access';

function isConfigured() { return !!(TWITTER_CLIENT_ID && TWITTER_REDIRECT_URI); }

// Erreur "l'API ne permet pas de vérifier" → validation manuelle
class TwitterUnavailable extends Error {}
// Erreur "le compte doit être relié à nouveau"
class TwitterRelink extends Error {}

function generateCodeVerifier() { return crypto.randomBytes(32).toString('base64url'); }

function getAuthUrl(state, verifier) {
  const p = new URLSearchParams({
    response_type: 'code', client_id: TWITTER_CLIENT_ID, redirect_uri: TWITTER_REDIRECT_URI,
    scope: SCOPES, state,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  return `https://x.com/i/oauth2/authorize?${p}`;
}

async function tokenRequest(params) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  // Client confidentiel (Web App) : Basic auth ; client public : client_id dans le corps
  if (TWITTER_CLIENT_SECRET) headers.Authorization = 'Basic ' + Buffer.from(`${TWITTER_CLIENT_ID}:${TWITTER_CLIENT_SECRET}`).toString('base64');
  else params.client_id = TWITTER_CLIENT_ID;
  const res = await fetch(`${API}/oauth2/token`, { method: 'POST', headers, body: new URLSearchParams(params) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Twitter token (${res.status}): ${text.substring(0, 200)}`);
  return JSON.parse(text);
}

const exchangeCode = (code, verifier) =>
  tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: TWITTER_REDIRECT_URI, code_verifier: verifier });

async function getTwitterUser(token) {
  const res = await fetch(`${API}/users/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Twitter user fetch failed: ' + res.status);
  return (await res.json()).data; // { id, name, username }
}

function saveTokens(userId, t) {
  dbRun('UPDATE users SET twitter_token=?, twitter_refresh=?, twitter_token_exp=? WHERE id=?',
    [t.access_token, t.refresh_token || null, Date.now() + ((t.expires_in || 7200) - 120) * 1000, userId]);
}

// Token utilisateur valide (rafraîchi si expiré — les access tokens X durent 2h)
async function getValidToken(userId, force = false) {
  const u = dbGet('SELECT twitter_token, twitter_refresh, twitter_token_exp FROM users WHERE id=?', [userId]);
  if (!u?.twitter_token) throw new TwitterRelink('Compte X non lié.');
  if (!force && u.twitter_token_exp && Date.now() < u.twitter_token_exp) return u.twitter_token;
  if (!u.twitter_refresh) throw new TwitterRelink('Session X expirée, relie ton compte.');
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: u.twitter_refresh });
    saveTokens(userId, t);
    return t.access_token;
  } catch (e) {
    console.warn('[Twitter] refresh échoué:', e.message);
    throw new TwitterRelink('Session X expirée, relie ton compte.');
  }
}

// Appel API avec le token du membre ; gère expiration et limites d'accès
async function apiGet(userId, path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getValidToken(userId, attempt > 0);
    const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 && attempt === 0) continue;
    if (res.status === 401) throw new TwitterRelink('Session X expirée, relie ton compte.');
    if (res.status === 403 || res.status === 429 || res.status >= 500) {
      const body = await res.text();
      console.warn(`[Twitter] ${path} → ${res.status} ${body.substring(0, 160)}`);
      throw new TwitterUnavailable(res.status === 429 ? 'Limite API X atteinte' : 'Accès API X insuffisant');
    }
    if (!res.ok) throw new Error(`API X ${res.status}`);
    return res.json();
  }
}

// Parcourt une liste paginée jusqu'à trouver l'id recherché (max `pages` pages)
async function findInPages(userId, path, targetId, pages = 5) {
  let next = null;
  for (let i = 0; i < pages; i++) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await apiGet(userId, path + (next ? `${sep}pagination_token=${encodeURIComponent(next)}` : ''));
    if (data.data?.some(x => x.id === targetId)) return true;
    next = data.meta?.next_token;
    if (!next) return false;
  }
  return false;
}

// Extrait l'id d'un tweet depuis son URL (x.com/…/status/123 ou twitter.com/…)
function parseTweetId(url) {
  const m = String(url || '').match(/(?:twitter|x)\.com\/[^/]+\/status(?:es)?\/(\d+)/i);
  return m ? m[1] : null;
}
// Extrait le pseudo d'une URL de profil (x.com/K13Esport)
function parseUsername(url) {
  const m = String(url || '').match(/(?:twitter|x)\.com\/(?!i\/|intent\/|home)([A-Za-z0-9_]{1,15})\/?(?:$|\?)/i);
  return m ? m[1] : null;
}

async function lookupUserId(userId, username) {
  const data = await apiGet(userId, `/users/by/username/${encodeURIComponent(username)}`);
  if (!data.data?.id) throw new Error(`Compte X @${username} introuvable.`);
  return data.data.id;
}

// ── Vérifications ──────────────────────────────────────────────────────────────
// type : tw_like | tw_retweet | tw_reply | tw_follow
// Retourne true/false, ou lève TwitterUnavailable / TwitterRelink
async function verifyAction(userId, type, url) {
  const u = dbGet('SELECT twitter_id, twitter_username FROM users WHERE id=?', [userId]);
  if (!u?.twitter_id) throw new TwitterRelink('Lie ton compte X.');

  if (type === 'tw_follow') {
    const target = parseUsername(url) || TWITTER_ACCOUNT_TO_FOLLOW;
    if (!target) throw new Error('Compte à suivre non configuré.');
    const targetId = await lookupUserId(userId, target);
    return findInPages(userId, `/users/${u.twitter_id}/following?max_results=1000`, targetId, 3);
  }

  const tweetId = parseTweetId(url);
  if (!tweetId) throw new Error('Lien du tweet invalide, contacte un admin.');
  if (type === 'tw_like')    return findInPages(userId, `/tweets/${tweetId}/liking_users?max_results=100`, u.twitter_id);
  if (type === 'tw_retweet') return findInPages(userId, `/tweets/${tweetId}/retweeted_by?max_results=100`, u.twitter_id);
  if (type === 'tw_reply') {
    const q = encodeURIComponent(`conversation_id:${tweetId} from:${u.twitter_username}`);
    const data = await apiGet(userId, `/tweets/search/recent?query=${q}&max_results=10`);
    if (data.meta?.result_count > 0) return true;
    // Une citation (quote tweet) compte aussi comme commentaire
    const quotes = await apiGet(userId, `/tweets/${tweetId}/quote_tweets?max_results=100&tweet.fields=author_id`);
    return !!quotes.data?.some(t => t.author_id === u.twitter_id);
  }
  throw new Error('Type de défi X inconnu.');
}

module.exports = {
  isConfigured, generateCodeVerifier, getAuthUrl, exchangeCode, getTwitterUser, saveTokens,
  verifyAction, parseTweetId, parseUsername, TwitterUnavailable, TwitterRelink,
};
