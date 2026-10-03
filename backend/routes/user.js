'use strict';
const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const { dbGet, dbAll, dbRun } = require('../models/db');
const twitch   = require('../services/twitch');
const se       = require('../services/streamelements');
const ch       = require('../services/challenges');
const shop     = require('../services/shop');
const { requireUser } = require('../middleware/auth');

const router = express.Router();

// ── Classement public (page /leaderboard) ──────────────────────────────────────
const loyalty = require('../services/loyalty');
const games   = require('../services/games');

// ── Classement public (page /leaderboard) : ?period=month|all ─────────────────
const lbCache = {};
router.get('/leaderboard', (req, res) => {
  const period = req.query.period === 'all' ? 'all' : 'month';
  if (!lbCache[period] || Date.now() - lbCache[period].at > 60_000) lbCache[period] = { at: Date.now(), data: loyalty.leaderboard(period, 50) };
  res.json({ ok: true, period, leaderboard: lbCache[period].data, me: req.session?.userId || null });
});

router.use(requireUser);

// ── Upload screenshots ─────────────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, '../../frontend/public/uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
const ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    // Nom aléatoire (non devinable), sans rien reprendre de l'URL
    filename: (req, file, cb) => cb(null,
      `${req.session.userId}_${crypto.randomBytes(12).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null,
    ALLOWED_EXT.includes(path.extname(file.originalname).toLowerCase()) && /^image\//.test(file.mimetype)),
});

const removeUpload = p => { if (p) fs.unlink(path.join(uploadsDir, path.basename(p)), () => {}); };

// ── Stats ──────────────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const userId = req.session.userId;
    // Sync StreamElements (limité à 1 appel / 2 min / user) puis validation auto des défis atteints
    if (se.isConfigured()) await se.syncWatchtimeForUser(userId).catch(() => {});
    ch.autoCheck(userId);
    const stats = ch.getUserStats(userId);
    if (!stats) return res.status(401).json({ ok: false, message: 'Compte introuvable.' });
    const user = dbGet('SELECT * FROM users WHERE id=?', [userId]);
    res.json({ ok: true, ...stats, daily: loyalty.dailyStatus(user), onboarding: loyalty.onboarding(userId),
      month: loyalty.positionOf(userId, 'month'), gamesDisabled: !!user.games_disabled });
  } catch (e) {
    console.error('[stats]', e);
    res.status(500).json({ ok: false, message: 'Erreur serveur.' });
  }
});

// ── Statut du live Twitch ──────────────────────────────────────────────────────
router.get('/live', async (req, res) => {
  const live = await twitch.isChannelLive().catch(() => false);
  res.json({ ok: true, live, channel: process.env.TWITCH_CHANNEL_LOGIN || 'k13esport', seConfigured: se.isConfigured() });
});

// ── Valider un challenge ───────────────────────────────────────────────────────
router.post('/challenge/:slug/verify', async (req, res) => {
  try { res.json(await ch.verifyChallenge(req.session.userId, req.params.slug)); }
  catch (e) {
    console.error('[verify]', e);
    res.status(500).json({ ok: false, message: 'Erreur serveur, réessaie.' });
  }
});

// ── Valider après timer redirect ───────────────────────────────────────────────
router.post('/challenge/redirect/validate', (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ ok: false, message: 'Token manquant.' });
  res.json(ch.validateRedirectTimer(req.session.userId, String(token)));
});

// ── Upload screenshot ──────────────────────────────────────────────────────────
router.post('/challenge/:challengeId/screenshot', upload.single('screenshot'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'Aucune image valide reçue (jpg/png/gif/webp, 8 Mo max).' });
  const challengeId = parseInt(req.params.challengeId, 10);
  const filePath = '/uploads/' + req.file.filename;
  const result = Number.isInteger(challengeId)
    ? ch.submitScreenshot(req.session.userId, challengeId, filePath)
    : { ok: false, keepFile: false, message: 'Challenge invalide.' };
  if (!result.keepFile) removeUpload(filePath);
  if (result.replaced) removeUpload(result.replaced);
  const { keepFile, replaced, ...body } = result;
  res.status(result.ok ? 200 : 400).json(body);
});

// ── Epic Games ─────────────────────────────────────────────────────────────────
router.post('/epic', (req, res) => {
  const epic_username = String(req.body?.epic_username || '').trim().slice(0, 64);
  const epic_creator_code = String(req.body?.epic_creator_code || '').trim().slice(0, 64);
  if (!epic_username) return res.status(400).json({ ok: false, message: 'Pseudo Epic requis.' });
  dbRun('UPDATE users SET epic_username=?,epic_creator_code=? WHERE id=?', [epic_username, epic_creator_code || null, req.session.userId]);
  res.json({ ok: true, message: 'Infos Epic Games enregistrées.' });
});

// ── Fidélisation ───────────────────────────────────────────────────────────────
router.post('/daily', (req, res) => res.json(loyalty.claimDaily(req.session.userId)));
router.get('/profile', (req, res) => {
  const id = req.session.userId;
  res.json({ ok: true, badges: loyalty.badgesOf(id), history: loyalty.history(id, 40), referral: loyalty.referralInfo(id),
    month: loyalty.positionOf(id, 'month'), all: loyalty.positionOf(id, 'all') });
});
router.get('/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="k13-loyalty-mes-donnees.json"');
  res.json(loyalty.exportData(req.session.userId));
});
router.post('/delete', (req, res) => {
  if (req.body?.confirm !== 'SUPPRIMER') return res.status(400).json({ ok: false, message: 'Tape SUPPRIMER pour confirmer.' });
  loyalty.deleteAccount(req.session.userId);
  req.session.destroy(() => { res.clearCookie('connect.sid'); res.json({ ok: true, message: 'Compte supprimé.' }); });
});

// ── Jeux ───────────────────────────────────────────────────────────────────────
router.get('/games', (req, res) => {
  const id = req.session.userId;
  res.json({ ok: true, limits: games.limits(id), blackjack: games.blackjackState(id),
    balance: dbGet('SELECT points FROM users WHERE id=?', [id]).points });
});
const withBadges = (id, r) => { if (r.ok) r.limits = games.limits(id); return r; };
router.post('/games/coinflip', (req, res) => res.json(withBadges(req.session.userId, games.coinflip(req.session.userId, req.body?.bet, req.body?.choice))));
router.post('/games/roulette', (req, res) => res.json(withBadges(req.session.userId, games.roulette(req.session.userId, req.body?.bet, req.body?.type, req.body?.value))));
router.post('/games/blackjack/start', (req, res) => res.json(withBadges(req.session.userId, games.blackjackStart(req.session.userId, req.body?.bet))));
router.post('/games/blackjack/:action(hit|stand|double)', (req, res) => res.json(withBadges(req.session.userId, games.blackjackAction(req.session.userId, req.params.action))));

// ── Préférences ────────────────────────────────────────────────────────────────
router.post('/settings', (req, res) => {
  if (req.body?.notify_dm !== undefined) dbRun('UPDATE users SET notify_dm=? WHERE id=?', [req.body.notify_dm ? 1 : 0, req.session.userId]);
  if (req.body?.games_disabled !== undefined) dbRun('UPDATE users SET games_disabled=? WHERE id=?', [req.body.games_disabled ? 1 : 0, req.session.userId]);
  res.json({ ok: true, message: 'Préférences enregistrées.' });
});

// ── Watch time Twitch (tracker manuel, seulement sans StreamElements) ──────────
router.post('/watchtime/start', async (req, res) => {
  if (se.isConfigured()) return res.status(400).json({ ok: false, message: 'Le visionnage est suivi automatiquement.' });
  const user = dbGet('SELECT twitch_id FROM users WHERE id=?', [req.session.userId]);
  if (!user?.twitch_id) return res.status(400).json({ ok: false, message: 'Lie ton compte Twitch d\'abord.' });
  const live = await twitch.isChannelLive().catch(() => false);
  if (!live) return res.status(400).json({ ok: false, live: false, message: 'K13 n\'est pas en live en ce moment.' });
  res.json({ ok: true, sessionId: twitch.startWatchSession(req.session.userId) });
});
router.post('/watchtime/ping', async (req, res) => {
  const sessionId = parseInt(req.body?.sessionId, 10);
  const live = await twitch.isChannelLive().catch(() => false);
  if (sessionId) twitch.updateWatchSession(sessionId, req.session.userId, live);
  if (live) ch.autoCheck(req.session.userId, { types: ['watchtime'] });
  res.json({ ok: true, live, totalSeconds: twitch.getTotalWatchSeconds(req.session.userId) });
});
router.post('/watchtime/end', async (req, res) => {
  const sessionId = parseInt(req.body?.sessionId, 10);
  const live = await twitch.isChannelLive().catch(() => false);
  if (sessionId) twitch.endWatchSession(sessionId, req.session.userId, live);
  ch.autoCheck(req.session.userId, { types: ['watchtime'] });
  res.json({ ok: true, totalSeconds: twitch.getTotalWatchSeconds(req.session.userId) });
});

// ── Boutique ───────────────────────────────────────────────────────────────────
router.get('/shop', (req, res) => res.json({ ok: true, items: shop.getItems() }));
router.post('/shop/buy/:itemId', async (req, res) => {
  try { res.json(await shop.purchase(req.session.userId, parseInt(req.params.itemId, 10))); }
  catch (e) {
    console.error('[shop]', e);
    res.status(500).json({ ok: false, message: 'Erreur serveur.' });
  }
});

module.exports = router;
