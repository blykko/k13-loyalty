'use strict';
const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { dbGet, dbAll, dbRun } = require('../models/db');
const twitch   = require('../services/twitch');
const ch       = require('../services/challenges');
const shop     = require('../services/shop');
const { requireUser } = require('../middleware/auth');

const router = express.Router();
router.use(requireUser);

// ── Upload screenshots ─────────────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, '../../frontend/public/uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = `${req.session.userId}_${req.params.challengeId}_${Date.now()}${ext}`;
    cb(null, name);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg','.jpeg','.png','.gif','.webp'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// ── Stats ──────────────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    // Sync StreamElements watchtime en arrière-plan (non-bloquant)
    const se = require('../services/streamelements');
    if (se.isConfigured()) {
      se.syncWatchtimeForUser(req.session.userId).catch(() => {});
    }
    res.json({ ok: true, ...ch.getUserStats(req.session.userId) });
  }
  catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── Valider un challenge ───────────────────────────────────────────────────────
router.post('/challenge/:slug/verify', async (req, res) => {
  try { res.json(await ch.verifyChallenge(req.session.userId, req.params.slug)); }
  catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ── Valider après timer redirect ───────────────────────────────────────────────
router.post('/challenge/redirect/validate', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ ok: false, message: 'Token manquant.' });
  res.json(ch.validateRedirectTimer(req.session.userId, token));
});

// ── Upload screenshot ──────────────────────────────────────────────────────────
router.post('/challenge/:challengeId/screenshot', upload.single('screenshot'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'Aucun fichier valide reçu (jpg/png/gif/webp, max 8MB).' });
  const challengeId = parseInt(req.params.challengeId);
  const userId      = req.session.userId;
  const filePath    = '/uploads/' + req.file.filename;
  const challenge   = dbGet('SELECT * FROM challenges WHERE id=?', [challengeId]);

  // Epic + Twitch sub = validation admin requise. Reste = auto-validé.
  const needsAdmin = challenge?.platform === 'epic' || challenge?.slug === 'twitch-sub';
  const verified   = needsAdmin ? 0 : 1;

  const existing = dbGet('SELECT * FROM user_challenges WHERE user_id=? AND challenge_id=?', [userId, challengeId]);
  if (existing) {
    dbRun('UPDATE user_challenges SET screenshot_path=?,verified=?,completed_at=datetime("now") WHERE user_id=? AND challenge_id=?',
      [filePath, verified, userId, challengeId]);
  } else {
    dbRun('INSERT INTO user_challenges (user_id,challenge_id,verified,screenshot_path) VALUES (?,?,?,?)',
      [userId, challengeId, verified, filePath]);
  }
  // Si auto-validé (pas admin requis), attribue les points immédiatement
  if (!needsAdmin && challenge) {
    const { addPoints } = require('../services/challenges');
    addPoints(userId, challenge.points);
  }
  // Si admin requis (epic, twitch-sub) : points donnés uniquement par l'admin via /pending approve
  if (needsAdmin) {
    res.json({ ok: true, pending: true, message: '📸 Screenshot envoyé ! L\'admin K13 validera sous 24h.' });
  } else {
    res.json({ ok: true, message: `✅ Screenshot reçu ! +${challenge?.points||0} pts attribués.` });
  }
});

// ── Epic Games ─────────────────────────────────────────────────────────────────
router.post('/epic', (req, res) => {
  const { epic_username, epic_creator_code } = req.body;
  if (!epic_username) return res.status(400).json({ ok: false, message: 'Pseudo Epic requis.' });
  dbRun('UPDATE users SET epic_username=?,epic_creator_code=? WHERE id=?', [epic_username, epic_creator_code||null, req.session.userId]);
  res.json({ ok: true, message: 'Infos Epic Games enregistrées.' });
});

// ── Watch time Twitch ──────────────────────────────────────────────────────────
router.post('/watchtime/start', async (req, res) => {
  const user = dbGet('SELECT twitch_id FROM users WHERE id=?', [req.session.userId]);
  if (!user?.twitch_id) return res.status(400).json({ ok: false, message: 'Lie ton compte Twitch d\'abord.' });
  const live = await twitch.isChannelLive().catch(() => false);
  if (!live) return res.status(400).json({ ok: false, live: false, message: 'K13 n\'est pas en live en ce moment.' });
  const sessionId = twitch.startWatchSession(req.session.userId);
  res.json({ ok: true, sessionId });
});
router.post('/watchtime/ping', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) twitch.updateWatchSession(sessionId, req.session.userId);
  res.json({ ok: true, totalSeconds: twitch.getTotalWatchSeconds(req.session.userId) });
});
router.post('/watchtime/end', (req, res) => {
  if (req.body.sessionId) twitch.endWatchSession(req.body.sessionId, req.session.userId);
  res.json({ ok: true, totalSeconds: twitch.getTotalWatchSeconds(req.session.userId) });
});

// ── Boutique ───────────────────────────────────────────────────────────────────
router.get('/shop', (req, res) => res.json({ ok: true, items: shop.getItems() }));
router.post('/shop/buy/:itemId', async (req, res) => {
  try { res.json(await shop.purchase(req.session.userId, parseInt(req.params.itemId))); }
  catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

module.exports = router;
