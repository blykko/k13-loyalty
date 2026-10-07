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
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_REDIRECT_URI) {
    console.error('[Discord] DISCORD_CLIENT_ID / DISCORD_REDIRECT_URI manquants : variables d\'environnement non chargées');
    return res.redirect('/?error=discord_not_configured');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.save(err => {
    if (err) console.error('[Discord init] session.save error:', err);
    res.redirect(discord.getAuthUrl(state));
  });
});

router.get('/discord/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect('/?error=discord_auth_failed');

  if (!state || state !== req.session.oauthState) {
    // En dev local le cookie peut être instable : on tolère, jamais en production
    if (process.env.NODE_ENV === 'production') return res.redirect('/?error=discord_state_mismatch');
    console.warn('[Discord callback] State mismatch ignoré (mode dev)');
  }
  delete req.session.oauthState;

  try {
    const tokens = await discord.exchangeCode(code);
    const dUser  = await discord.getDiscordUser(tokens.access_token);
    const displayName = dUser.global_name || dUser.username;

    let user = dbGet('SELECT * FROM users WHERE discord_id=?', [dUser.id]);
    if (!user) {
      // username est UNIQUE : on suffixe en cas de collision
      let username = dUser.username, n = 1;
      while (dbGet('SELECT id FROM users WHERE username=?', [username])) username = `${dUser.username}_${++n}`;
      const r = dbRun(
        'INSERT INTO users (username,discord_id,discord_username,discord_avatar,discord_token,discord_refresh) VALUES (?,?,?,?,?,?)',
        [username, dUser.id, displayName, dUser.avatar, tokens.access_token, tokens.refresh_token]);
      user = dbGet('SELECT * FROM users WHERE id=?', [r.lastInsertRowid]);
      if (!user) throw new Error('Utilisateur créé mais introuvable en base');
      // Bonus de bienvenue + rattachement au parrain éventuel
      require('../services/loyalty').onSignup(user.id, req.session.ref);
    } else {
      dbRun("UPDATE users SET discord_token=?,discord_refresh=?,discord_avatar=?,discord_username=?,last_seen=datetime('now') WHERE id=?",
        [tokens.access_token, tokens.refresh_token, dUser.avatar, displayName, user.id]);
    }

    // Challenge "Rejoindre le Discord" : validé seulement si réellement membre du serveur
    const userId = user.id;
    discord.checkGuildMember(dUser.id)
      .then(inGuild => discord.checkDiscordChallenges(userId, inGuild))
      .catch(() => {});

    // Régénère l'ID de session à la connexion (anti fixation de session)
    req.session.regenerate(err => {
      if (err) { console.error('[Discord callback] regenerate:', err); return res.redirect('/?error=session_save_failed'); }
      req.session.userId   = user.id;
      req.session.username = user.username;
      req.session.save(err2 => {
        if (err2) { console.error('[Discord callback] session.save:', err2); return res.redirect('/?error=session_save_failed'); }
        res.redirect('/');
      });
    });
  } catch (e) {
    console.error('[Discord OAuth]', e.message);
    res.redirect('/?error=discord_login_failed');
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
  if (!state || state !== req.session.oauthState) return res.redirect('/?error=twitch_state_mismatch');
  delete req.session.oauthState;
  try {
    const tokens = await twitch.exchangeCode(code);
    const tUser  = await twitch.getTwitchUser(tokens.access_token);
    const other  = dbGet('SELECT id FROM users WHERE twitch_id=? AND id!=?', [tUser.id, req.session.userId]);
    if (other) return res.redirect('/?error=twitch_already_linked');
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
// Anti brute-force : 5 essais ratés → blocage 15 min par IP
const loginFails = new Map();
router.post('/admin/login', async (req, res) => {
  const ip = req.ip;
  const f = loginFails.get(ip);
  if (f && f.count >= 5 && Date.now() - f.at < 15 * 60 * 1000)
    return res.status(429).json({ ok: false, message: 'Trop de tentatives. Réessaie dans 15 minutes.' });
  const admin = dbGet('SELECT password_hash FROM admin WHERE id=1');
  if (!admin) return res.status(500).json({ ok: false, message: 'Admin non configuré.' });
  const valid = await bcrypt.compare(String(req.body.password || ''), admin.password_hash);
  if (!valid) {
    loginFails.set(ip, { count: (f && Date.now() - f.at < 15 * 60 * 1000 ? f.count : 0) + 1, at: Date.now() });
    return res.status(401).json({ ok: false, message: 'Mot de passe incorrect.' });
  }
  loginFails.delete(ip);
  req.session.isAdmin = true;
  req.session.save(() => res.json({ ok: true }));
});

router.post('/logout', (req, res) => req.session.destroy(() => {
  res.clearCookie('connect.sid');
  res.json({ ok: true });
}));

router.get('/me', (req, res) => {
  if (req.session?.userId) {
    const u = dbGet('SELECT id,username,points,rank,discord_id,discord_username,discord_avatar,twitch_login,twitch_id,epic_username FROM users WHERE id=?', [req.session.userId]);
    return res.json({ ok: true, user: u, isAdmin: !!req.session.isAdmin });
  }
  if (req.session?.isAdmin) return res.json({ ok: true, isAdmin: true });
  res.json({ ok: false });
});

module.exports = router;
