'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const { dbGet, dbRun } = require('../models/db');
const discord = require('../services/discord');
const twitch  = require('../services/twitch');
const { requireUser } = require('../middleware/auth');
const router = express.Router();

// ── Discord OAuth (auth principale) ───────────────────────────────────────────
router.get('/discord', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  console.log('[Discord init] Session ID:', req.sessionID, '| State:', state);
  req.session.save((err) => {
    if (err) console.error('[Discord init] session.save error:', err);
    console.log('[Discord init] Session saved, redirecting to Discord...');
    res.redirect(discord.getAuthUrl(state));
  });
});

router.get('/discord/callback', async (req, res) => {
  const { code, state, error } = req.query;

  // Debug : log pour comprendre ce qui se passe
  console.log('[Discord callback] state reçu :', state);
  console.log('[Discord callback] state session:', req.session.oauthState);
  console.log('[Discord callback] session ID   :', req.sessionID);
  console.log('[Discord callback] error        :', error);

  if (error) {
    console.error('[Discord callback] Erreur Discord:', error);
    return res.redirect('/?error=discord_auth_failed');
  }

  // Si state manquant en session (cookie perdu) → on accepte quand même si code présent
  // C'est acceptable en dev local où le cookie peut être instable
  if (state !== req.session.oauthState) {
    console.warn('[Discord callback] State mismatch — session cookie probablement perdu');
    console.warn('  Reçu:', state, '| Attendu:', req.session.oauthState);
    // En dev, on continue quand même si on a le code
    if (!code || process.env.NODE_ENV === 'production') {
      return res.redirect('/?error=discord_state_mismatch');
    }
    console.warn('[Discord callback] Mode dev : on continue sans vérification state');
  }

  try {
    console.log('[Discord callback] Échange du code...');
    const tokens = await discord.exchangeCode(code);
    console.log('[Discord callback] Token ok, récupération user...');
    const dUser  = await discord.getDiscordUser(tokens.access_token);
    console.log('[Discord callback] Discord user:', dUser.id, dUser.username);

    let user = dbGet('SELECT * FROM users WHERE discord_id=?', [dUser.id]);
    if (!user) {
      console.log('[Discord callback] Nouvel utilisateur, création...');
      const r = dbRun(
        'INSERT INTO users (username,discord_id,discord_username,discord_avatar,discord_token,discord_refresh) VALUES (?,?,?,?,?,?)',
        [dUser.username, dUser.id, dUser.username, dUser.avatar, tokens.access_token, tokens.refresh_token]
      );
      console.log('[Discord callback] User créé, id:', r.lastInsertRowid);
      user = dbGet('SELECT * FROM users WHERE id=?', [r.lastInsertRowid]);
      if (!user) throw new Error('User créé mais introuvable en base (lastInsertRowid=' + r.lastInsertRowid + ')');
      discord.checkDiscordChallenges(user.id);
    } else {
      console.log('[Discord callback] User existant id:', user.id);
      dbRun('UPDATE users SET discord_token=?,discord_refresh=?,discord_avatar=?,discord_username=?,last_seen=datetime("now") WHERE id=?',
        [tokens.access_token, tokens.refresh_token, dUser.avatar, dUser.username, user.id]);
    }

    req.session.userId   = user.id;
    req.session.username = user.username;
    console.log('[Discord callback] Session définie userId:', user.id, '— sauvegarde...');
    req.session.save((err) => {
      if (err) {
        console.error('[Discord callback] ERREUR session.save:', err);
        return res.redirect('/?error=session_save_failed');
      }
      console.log('[Discord callback] Session sauvegardée → redirect /');
      // On envoie une page HTML minimaliste qui force un rechargement complet
      // pour éviter que le navigateur utilise la version cachée de index.html
      res.send(`<!DOCTYPE html><html><head>
        <meta http-equiv="Cache-Control" content="no-store"/>
        <script>window.location.replace('/');</script>
      </head><body>Connexion réussie, redirection...</body></html>`);
    });
  } catch (e) {
    console.error('[Discord OAuth] ERREUR:', e.message);
    console.error(e.stack);
    res.redirect('/?error=discord_login_failed&msg=' + encodeURIComponent(e.message));
  }
});

// ── Twitch OAuth (liaison) ─────────────────────────────────────────────────────
// "invalid client" = soit le Client Secret est mauvais, soit la Redirect URI
// ne correspond pas EXACTEMENT à ce qui est enregistré sur dev.twitch.tv
// Vérifie sur https://dev.twitch.tv/console/apps → ton app → Redirect URIs
router.get('/twitch', requireUser, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.save(() => res.redirect(twitch.getAuthUrl(state)));
});

router.get('/twitch/callback', requireUser, async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    console.error('[Twitch] Error from Twitch:', error, req.query.error_description);
    return res.redirect('/?error=twitch_denied');
  }
  if (state !== req.session.oauthState) return res.redirect('/?error=twitch_state_mismatch');
  try {
    const tokens = await twitch.exchangeCode(code);
    const tUser  = await twitch.getTwitchUser(tokens.access_token);
    dbRun('UPDATE users SET twitch_id=?,twitch_login=?,twitch_token=?,twitch_refresh=? WHERE id=?',
      [tUser.id, tUser.login, tokens.access_token, tokens.refresh_token, req.session.userId]);
    req.session.save(() => res.redirect('/?linked=twitch'));
  } catch (e) {
    console.error('[Twitch OAuth] Full error:', e.message);
    // "invalid client" = mauvais Client Secret ou Redirect URI incorrecte
    const hint = e.message.includes('invalid client')
      ? 'twitch_invalid_client'
      : 'twitch_link_failed';
    res.redirect('/?error=' + hint);
  }
});

// ── Admin ──────────────────────────────────────────────────────────────────────
router.post('/admin/login', async (req, res) => {
  const admin = dbGet('SELECT password_hash FROM admin WHERE id=1');
  if (!admin) return res.status(500).json({ ok: false, message: 'Admin non configuré.' });
  const valid = await bcrypt.compare(req.body.password || '', admin.password_hash);
  if (!valid) return res.status(401).json({ ok: false, message: 'Mot de passe incorrect.' });
  req.session.isAdmin = true;
  req.session.save(() => res.json({ ok: true }));
});

router.post('/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

router.get('/me', (req, res) => {
  console.log('[/auth/me] sessionID:', req.sessionID, '| userId:', req.session?.userId);
  if (req.session?.userId) {
    const u = dbGet('SELECT id,username,points,rank,discord_id,discord_username,discord_avatar,twitch_login,twitch_id,epic_username FROM users WHERE id=?', [req.session.userId]);
    return res.json({ ok: true, user: u, isAdmin: !!req.session.isAdmin });
  }
  if (req.session?.isAdmin) return res.json({ ok: true, isAdmin: true });
  res.json({ ok: false });
});

module.exports = router;
