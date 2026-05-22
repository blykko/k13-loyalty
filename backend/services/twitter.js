'use strict';
const fetch  = require('node-fetch');
const crypto = require('crypto');

const {
  TWITTER_CLIENT_ID, TWITTER_CLIENT_SECRET,
  TWITTER_REDIRECT_URI, TWITTER_ACCOUNT_TO_FOLLOW,
} = process.env;

// Twitter OAuth 2.0 PKCE
// IMPORTANT : Ton app Twitter doit avoir OAuth 2.0 activé (pas seulement 1.0a)
// Dans le portail developer.twitter.com :
//   App → Settings → User authentication settings
//   → OAuth 2.0 : ON
//   → Type of App : Web App
//   → Callback URI : https://TON-NGROK.ngrok-free.app/auth/twitter/callback
//   → Website URL : https://loyalty.k13-esport.com
// Le Client ID OAuth 2.0 ressemble à : "dXNlcl9pZDoxMjM0NTY3ODk" (long, base64-like)
// PAS le Consumer Key (qui ressemble à "9KAJBiMp1H5lMAD9LsX3kOU1C")
// Copie le Client ID depuis : App → Keys and tokens → OAuth 2.0 Client ID and Client Secret

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function getAuthUrl(state, verifier) {
  const challenge = generateCodeChallenge(verifier);
  const p = new URLSearchParams({
    response_type:         'code',
    client_id:             TWITTER_CLIENT_ID,
    redirect_uri:          TWITTER_REDIRECT_URI,
    scope:                 'tweet.read users.read follows.read offline.access',
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  });
  return `https://twitter.com/i/oauth2/authorize?${p}`;
}

async function exchangeCode(code, verifier) {
  // Twitter OAuth 2.0 utilise Basic Auth avec client_id:client_secret
  const credentials = Buffer.from(`${TWITTER_CLIENT_ID}:${TWITTER_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      code,
      grant_type:    'authorization_code',
      redirect_uri:  TWITTER_REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Twitter token exchange failed: ' + text);
  return JSON.parse(text);
}

async function getTwitterUser(token) {
  const res = await fetch('https://api.twitter.com/2/users/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Twitter user fetch failed');
  return (await res.json()).data; // { id, name, username }
}

async function checkFollow(userId, token) {
  const lookupRes = await fetch(
    `https://api.twitter.com/2/users/by/username/${TWITTER_ACCOUNT_TO_FOLLOW}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!lookupRes.ok) throw new Error('Compte Twitter K13 introuvable');
  const targetId = (await lookupRes.json()).data?.id;
  if (!targetId) throw new Error('Compte Twitter K13 introuvable');

  let nextToken = null;
  do {
    const params = new URLSearchParams({ max_results: '1000' });
    if (nextToken) params.set('pagination_token', nextToken);
    const res = await fetch(`https://api.twitter.com/2/users/${userId}/following?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error('Quota Twitter dépassé ou token invalide. Réessaie dans 15 min.');
    const data = await res.json();
    if (data.data?.some(u => u.id === targetId)) return true;
    nextToken = data.meta?.next_token || null;
  } while (nextToken);
  return false;
}

module.exports = { generateCodeVerifier, getAuthUrl, exchangeCode, getTwitterUser, checkFollow };
