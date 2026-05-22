'use strict';
const fetch  = require('node-fetch');
const crypto = require('crypto');
const { TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REDIRECT_URI } = process.env;

// TikTok Login Kit v2
// IMPORTANT : La redirect URI doit être EXACTEMENT celle déclarée dans le portail TikTok
// (sans slash final, même casse)
// En dev : http://localhost:3000/auth/tiktok/callback
// L'app TikTok doit avoir le produit "Login Kit" activé ET
// le scope "user.info.basic" autorisé dans les "Scopes"

function getAuthUrl(state, codeVerifier) {
  const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  // TikTok v2 : les paramètres doivent être dans cet ordre exact
  const params = new URLSearchParams();
  params.set('client_key', TIKTOK_CLIENT_KEY);
  params.set('scope', 'user.info.basic');
  params.set('response_type', 'code');
  params.set('redirect_uri', TIKTOK_REDIRECT_URI);
  params.set('state', state);
  params.set('code_challenge', challenge);
  params.set('code_challenge_method', 'S256');
  return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
}

async function exchangeCode(code, codeVerifier) {
  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache',
    },
    body: new URLSearchParams({
      client_key:    TIKTOK_CLIENT_KEY,
      client_secret: TIKTOK_CLIENT_SECRET,
      code,
      grant_type:    'authorization_code',
      redirect_uri:  TIKTOK_REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('TikTok token exchange failed: ' + text);
  return JSON.parse(text);
}

async function getTikTokUser(access_token) {
  const res = await fetch(
    'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url,username',
    { headers: { Authorization: `Bearer ${access_token}` } }
  );
  if (!res.ok) throw new Error('TikTok user fetch failed: ' + await res.text());
  const data = await res.json();
  return data.data?.user;
}

module.exports = { getAuthUrl, exchangeCode, getTikTokUser };
