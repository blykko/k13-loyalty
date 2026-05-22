'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const path    = require('path');
const fs      = require('fs');
const { dbGet, dbAll, dbRun } = require('../models/db');
const discord = require('../services/discord');
const { requireAdmin } = require('../middleware/auth');
const { addPoints, removePoints, updateRank, markDone } = require('../services/challenges');
const router = express.Router();
router.use(requireAdmin);

// ── Stats ──────────────────────────────────────────────────────────────────────
router.get('/stats', (req,res) => res.json({ ok:true,
  totalUsers:    dbGet('SELECT COUNT(*) AS c FROM users').c,
  totalCodes:    dbGet('SELECT COUNT(*) AS c FROM promo_codes').c,
  usedCodes:     dbGet('SELECT COUNT(*) AS c FROM promo_codes WHERE used=1').c,
  pendingVerifs: dbGet('SELECT COUNT(*) AS c FROM user_challenges WHERE verified=0').c,
  pendingScreens:dbGet('SELECT COUNT(*) AS c FROM user_challenges WHERE verified=0 AND screenshot_path IS NOT NULL').c,
}));

// ── Membres ────────────────────────────────────────────────────────────────────
router.get('/users', (req,res) => res.json({ ok:true, users: dbAll(`
  SELECT u.*,
    (SELECT COUNT(*) FROM user_challenges uc WHERE uc.user_id=u.id AND uc.verified=1) AS challenges_done,
    (SELECT COUNT(*) FROM user_challenges uc WHERE uc.user_id=u.id) AS challenges_total,
    (SELECT COUNT(*) FROM promo_codes pc WHERE pc.user_id=u.id) AS codes_total,
    (SELECT COALESCE(SUM(messages),0) FROM discord_activity da WHERE da.user_id=u.id) AS discord_messages,
    (SELECT COALESCE(SUM(vocal_seconds),0) FROM discord_activity da WHERE da.user_id=u.id) AS discord_vocal,
    (SELECT COALESCE(SUM(seconds),0) FROM twitch_watch_sessions tw WHERE tw.user_id=u.id) AS twitch_watch_seconds
  FROM users u ORDER BY u.points DESC`) }));

// ── Classement des plus actifs en live ────────────────────────────────────────
router.get('/live-ranking', (req,res) => {
  const ranking = dbAll(`
    SELECT u.id, u.discord_username, u.username, u.twitch_login,
           COALESCE(SUM(tw.seconds),0) AS total_seconds,
           COUNT(tw.id) AS session_count,
           MAX(tw.started_at) AS last_session
    FROM users u
    LEFT JOIN twitch_watch_sessions tw ON tw.user_id=u.id
    WHERE tw.seconds > 0
    GROUP BY u.id
    ORDER BY total_seconds DESC
    LIMIT 50`);
  res.json({ ok:true, ranking });
});

// ── Détail membre ──────────────────────────────────────────────────────────────
router.get('/users/:id', (req,res) => {
  const user = dbGet('SELECT * FROM users WHERE id=?', [req.params.id]);
  if (!user) return res.status(404).json({ ok:false });
  const allCh   = dbAll('SELECT * FROM challenges WHERE active=1');
  const done    = dbAll('SELECT * FROM user_challenges WHERE user_id=?', [user.id]);
  const doneMap = {}; for (const d of done) doneMap[d.challenge_id]=d;
  const codes   = dbAll('SELECT * FROM promo_codes WHERE user_id=? ORDER BY created_at DESC',[user.id]);
  const orders  = dbAll('SELECT o.*,i.name AS item_name FROM shop_orders o JOIN shop_items i ON o.item_id=i.id WHERE o.user_id=? ORDER BY o.created_at DESC',[user.id]);
  const sessions= dbAll('SELECT date,messages,vocal_seconds FROM discord_activity WHERE user_id=? ORDER BY date DESC LIMIT 30',[user.id]);
  res.json({ ok:true, user, challenges:allCh.map(c=>({...c,status:doneMap[c.id]})), codes, orders, activity:sessions });
});

// ── Ajuster les points ─────────────────────────────────────────────────────────
router.post('/users/:id/points', (req,res) => {
  const { delta, reason } = req.body;
  if (typeof delta !== 'number') return res.status(400).json({ ok:false, message:'Delta requis.' });
  const user = dbGet('SELECT points FROM users WHERE id=?',[req.params.id]);
  if (!user) return res.status(404).json({ ok:false });
  const newPts = Math.max(0, user.points + delta);
  dbRun('UPDATE users SET points=? WHERE id=?',[newPts, req.params.id]);
  updateRank(parseInt(req.params.id));
  res.json({ ok:true, message:`${delta>0?'+'+delta:delta} pts. Nouveau total: ${newPts}`, newPoints:newPts });
});

// ── Valider / invalider un challenge pour un user ─────────────────────────────
router.post('/users/:userId/challenge/:challengeId/validate', (req,res) => {
  const ch = dbGet('SELECT * FROM challenges WHERE id=?',[req.params.challengeId]);
  if (!ch) return res.status(404).json({ ok:false });
  const existing = dbGet('SELECT * FROM user_challenges WHERE user_id=? AND challenge_id=?',[req.params.userId,req.params.challengeId]);
  if (existing) {
    dbRun('UPDATE user_challenges SET verified=1,admin_note=? WHERE user_id=? AND challenge_id=?',
      [req.body.note||null, req.params.userId, req.params.challengeId]);
    if (existing.verified===0) addPoints(parseInt(req.params.userId), ch.points);
  } else {
    markDone(parseInt(req.params.userId),parseInt(req.params.challengeId),1);
    addPoints(parseInt(req.params.userId),ch.points);
  }
  res.json({ ok:true, message:`"${ch.name}" validé (+${ch.points} pts).` });
});

router.delete('/users/:userId/challenge/:challengeId', (req,res) => {
  const ch    = dbGet('SELECT * FROM challenges WHERE id=?',[req.params.challengeId]);
  const entry = dbGet('SELECT * FROM user_challenges WHERE user_id=? AND challenge_id=?',[req.params.userId,req.params.challengeId]);
  if (entry?.verified===1 && ch) removePoints(parseInt(req.params.userId), ch.points);
  dbRun('DELETE FROM user_challenges WHERE user_id=? AND challenge_id=?',[req.params.userId,req.params.challengeId]);

  // Reset les compteurs associés au type de challenge
  if (ch?.type === 'messages') {
    // Reset messages du jour/semaine selon la période
    const today = new Date().toISOString().split('T')[0];
    if (ch.repeat_seconds === 86400) {
      dbRun('UPDATE discord_activity SET messages=0 WHERE user_id=? AND date=?',[req.params.userId, today]);
    } else if (ch.repeat_seconds === 604800) {
      dbRun('UPDATE discord_activity SET messages=0 WHERE user_id=? AND date>=date("now","-7 days")',[req.params.userId]);
    } else {
      dbRun('UPDATE discord_activity SET messages=0 WHERE user_id=?',[req.params.userId]);
    }
  }
  if (ch?.type === 'vocal') {
    const today = new Date().toISOString().split('T')[0];
    if (ch.repeat_seconds === 86400) {
      dbRun('UPDATE discord_activity SET vocal_seconds=0 WHERE user_id=? AND date=?',[req.params.userId, today]);
    } else if (ch.repeat_seconds === 604800) {
      dbRun('UPDATE discord_activity SET vocal_seconds=0 WHERE user_id=? AND date>=date("now","-7 days")',[req.params.userId]);
    } else {
      dbRun('UPDATE discord_activity SET vocal_seconds=0 WHERE user_id=?',[req.params.userId]);
    }
  }
  if (ch?.type === 'watchtime') {
    dbRun('DELETE FROM twitch_watch_sessions WHERE user_id=? AND ended_at!=?',[req.params.userId,'se_sync']);
    // Ne reset pas la session SE sync (c'est l'historique réel)
  }
  res.json({ ok:true, message:'Validation retirée et compteurs réinitialisés.' });
});

// ── Validations en attente (avec et sans screen) ───────────────────────────────
router.get('/pending', (req,res) => {
  const pending = dbAll(`
    SELECT uc.id, uc.screenshot_path, uc.completed_at, uc.admin_note,
           u.id AS user_id, u.username, u.discord_username,
           c.name AS challenge_name, c.platform, c.points, c.slug, c.id AS challenge_id
    FROM user_challenges uc
    JOIN users u ON uc.user_id=u.id
    JOIN challenges c ON uc.challenge_id=c.id
    WHERE uc.verified=0
    ORDER BY uc.screenshot_path DESC, uc.completed_at ASC`);
  res.json({ ok:true, pending });
});

router.post('/pending/:id/approve', (req,res) => {
  const entry = dbGet('SELECT * FROM user_challenges WHERE id=?',[req.params.id]);
  if (!entry) return res.status(404).json({ ok:false });
  const ch = dbGet('SELECT * FROM challenges WHERE id=?',[entry.challenge_id]);
  dbRun('UPDATE user_challenges SET verified=1,admin_note=? WHERE id=?',[req.body.note||null, req.params.id]);
  addPoints(entry.user_id, ch.points);
  // Supprime le screenshot après validation pour éviter le surstockage
  if (entry.screenshot_path) {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(__dirname, '../../frontend/public', entry.screenshot_path);
    fs.unlink(filePath, () => {}); // Silencieux si le fichier n'existe pas
    dbRun('UPDATE user_challenges SET screenshot_path=NULL WHERE id=?',[entry.id]);
  }
  res.json({ ok:true, message:`+${ch.points} pts attribués.` });
});

router.post('/pending/:id/reject', (req,res) => {
  dbRun('DELETE FROM user_challenges WHERE id=?',[req.params.id]);
  res.json({ ok:true, message:'Rejeté.' });
});

// ── Codes promo ────────────────────────────────────────────────────────────────
router.get('/codes', (req,res) => res.json({ ok:true, codes:dbAll('SELECT p.*,u.username FROM promo_codes p JOIN users u ON p.user_id=u.id ORDER BY p.created_at DESC') }));
router.get('/codes/verify/:code', (req,res) => {
  const code=dbGet('SELECT p.*,u.username FROM promo_codes p JOIN users u ON p.user_id=u.id WHERE p.code=?',[req.params.code.toUpperCase()]);
  if (!code) return res.json({ ok:false,valid:false,message:'Code introuvable.' });
  if (code.used) return res.json({ ok:false,valid:false,message:'Déjà utilisé.',code });
  if (new Date(code.expires_at)<new Date()) return res.json({ ok:false,valid:false,message:'Expiré.',code });
  res.json({ ok:true,valid:true,code });
});
router.post('/codes/:code/use', (req,res) => {
  const r=dbRun("UPDATE promo_codes SET used=1,used_at=datetime('now') WHERE code=? AND used=0",[req.params.code.toUpperCase()]);
  res.json(r.changes?{ok:true}:{ok:false,message:'Déjà utilisé ou introuvable.'});
});

// ── Challenges admin ───────────────────────────────────────────────────────────
router.get('/challenges', (req,res) => res.json({ ok:true,challenges:dbAll('SELECT * FROM challenges ORDER BY category,platform,points') }));
router.post('/challenges', (req,res) => {
  const{platform,slug,name,description,points,type,required_value,repeat_seconds,redirect_url,redirect_delay,category,extra}=req.body;
  if(!platform||!slug||!name||!points) return res.status(400).json({ok:false,message:'Champs manquants.'});
  try{
    dbRun('INSERT INTO challenges (platform,slug,name,description,points,type,required_value,repeat_seconds,redirect_url,redirect_delay,category,extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [platform,slug,name,description||'',points,type||'screen',required_value||0,repeat_seconds||0,redirect_url||null,redirect_delay||20,category||'permanent',JSON.stringify(extra||{})]);
    res.json({ok:true});
  }catch{res.status(409).json({ok:false,message:'Slug déjà existant.'});}
});
router.patch('/challenges/:id', (req,res) => {
  const c=dbGet('SELECT * FROM challenges WHERE id=?',[req.params.id]);
  if(!c) return res.status(404).json({ok:false});
  const f=req.body;
  dbRun('UPDATE challenges SET active=?,points=?,name=?,description=?,type=?,required_value=?,repeat_seconds=?,redirect_url=?,redirect_delay=?,category=? WHERE id=?',
    [f.active??c.active,f.points??c.points,f.name??c.name,f.description??c.description,f.type??c.type,f.required_value??c.required_value,f.repeat_seconds??c.repeat_seconds,f.redirect_url??c.redirect_url,f.redirect_delay??c.redirect_delay,f.category??c.category,req.params.id]);
  res.json({ok:true});
});
router.delete('/challenges/:id', (req,res) => {
  const { hard } = req.query; // ?hard=1 pour suppression définitive
  if (hard === '1') {
    dbRun('DELETE FROM user_challenges WHERE challenge_id=?',[req.params.id]);
    dbRun('DELETE FROM challenges WHERE id=?',[req.params.id]);
  } else {
    dbRun('UPDATE challenges SET active=0 WHERE id=?',[req.params.id]);
  }
  res.json({ok:true});
});

// ── Boutique ───────────────────────────────────────────────────────────────────
router.get('/shop', (req,res) => res.json({ok:true,items:dbAll('SELECT * FROM shop_items ORDER BY cost_points')}));
router.post('/shop', (req,res) => {
  const{name,description,type,cost_points,stock,extra}=req.body;
  if(!name||!type||!cost_points) return res.status(400).json({ok:false,message:'Champs manquants.'});
  dbRun('INSERT INTO shop_items (name,description,type,cost_points,stock,extra) VALUES (?,?,?,?,?,?)',[name,description||'',type,cost_points,stock??-1,JSON.stringify(extra||{})]);
  res.json({ok:true});
});
router.delete('/shop/:id', (req,res) => {
  const { hard } = req.query;
  if (hard === '1') {
    dbRun('DELETE FROM shop_items WHERE id=?',[req.params.id]);
  } else {
    dbRun('UPDATE shop_items SET active=0 WHERE id=?',[req.params.id]);
  }
  res.json({ok:true});
});
router.patch('/shop/:id', (req,res) => {
  const i=dbGet('SELECT * FROM shop_items WHERE id=?',[req.params.id]);
  if(!i) return res.status(404).json({ok:false});
  const f=req.body;
  dbRun('UPDATE shop_items SET active=?,cost_points=?,stock=?,name=?,description=? WHERE id=?',[f.active??i.active,f.cost_points??i.cost_points,f.stock??i.stock,f.name??i.name,f.description??i.description,req.params.id]);
  res.json({ok:true});
});
router.get('/orders', (req,res) => res.json({ok:true,orders:dbAll('SELECT o.*,u.username,i.name AS item_name FROM shop_orders o JOIN users u ON o.user_id=u.id JOIN shop_items i ON o.item_id=i.id ORDER BY o.created_at DESC')}));

// ── Bot Discord events ─────────────────────────────────────────────────────────
router.post('/bot/message', (req,res) => { if(req.body.discord_id) discord.recordMessage(req.body.discord_id); res.json({ok:true}); });
router.post('/bot/vocal',   (req,res) => { if(req.body.discord_id&&req.body.seconds) discord.recordVocalSeconds(req.body.discord_id,parseInt(req.body.seconds)); res.json({ok:true}); });

// ── Change password ────────────────────────────────────────────────────────────

// ── Reset des défis ────────────────────────────────────────────────────────────

// Reset tous les défis d'un utilisateur
router.post('/users/:id/reset', (req,res) => {
  const userId = req.params.id;
  dbRun('DELETE FROM user_challenges WHERE user_id=?',[userId]);
  dbRun('UPDATE discord_activity SET messages=0, vocal_seconds=0 WHERE user_id=?',[userId]);
  dbRun('DELETE FROM twitch_watch_sessions WHERE user_id=? AND ended_at!=?',[userId,'se_sync']);
  // Remet les points à 0
  if (req.body.resetPoints) {
    dbRun('UPDATE users SET points=0,rank="bronze" WHERE id=?',[userId]);
  }
  res.json({ ok:true, message:'Tous les défis réinitialisés.' });
});

// Reset global : tous les défis de tout le monde
router.post('/reset-all', (req,res) => {
  const { confirmText } = req.body;
  if (confirmText !== 'CONFIRMER') return res.status(400).json({ ok:false, message:'Confirmation incorrecte.' });
  dbRun('DELETE FROM user_challenges');
  dbRun('UPDATE discord_activity SET messages=0, vocal_seconds=0');
  dbRun('DELETE FROM twitch_watch_sessions WHERE ended_at!=?',['se_sync']);
  if (req.body.resetPoints) {
    dbRun('UPDATE users SET points=0,rank="bronze"');
  }
  res.json({ ok:true, message:'Tous les défis de tous les membres réinitialisés.' });
});



// ── Reset invitations ──────────────────────────────────────────────────────────
router.post('/reset-invites', (req,res) => {
  const { userId } = req.body;
  if (userId) {
    dbRun('DELETE FROM discord_invites WHERE inviter_id=?', [userId]);
    dbRun('DELETE FROM user_challenges WHERE user_id=? AND challenge_id IN (SELECT id FROM challenges WHERE type=?)', [userId, 'invite']);
    res.json({ ok:true, message:'Invitations réinitialisées pour cet utilisateur.' });
  } else {
    // Reset tous le monde
    dbRun('DELETE FROM discord_invites');
    dbRun('DELETE FROM user_challenges WHERE challenge_id IN (SELECT id FROM challenges WHERE type=?)' , ['invite']);
    res.json({ ok:true, message:'Toutes les invitations réinitialisées.' });
  }
});



// ── Diagnostic StreamElements ──────────────────────────────────────────────────
router.get('/diag/streamelements', async (req,res) => {
  const se = require('../services/streamelements');
  const jwt = process.env.STREAMELEMENTS_JWT;
  const channelId = process.env.STREAMELEMENTS_CHANNEL_ID;
  if (!se.isConfigured()) {
    return res.json({ ok: false, configured: false,
      jwt_present: !!jwt, channel_present: !!channelId,
      message: 'SE non configuré. Vérifie STREAMELEMENTS_JWT et STREAMELEMENTS_CHANNEL_ID dans .env.' });
  }
  try {
    const fetch = require('node-fetch');
    // Test 1 : channels/me
    const meRes = await fetch('https://api.streamelements.com/kappa/v2/channels/me', {
      headers: { 'Authorization': `Bearer ${jwt}` }
    });
    const meText = await meRes.text();
    if (!meRes.ok) {
      return res.json({ ok: false, step: 'JWT', status: meRes.status, body: meText.substring(0,300) });
    }
    const me = JSON.parse(meText);
    const match = me._id === channelId;

    // Test 2 : récupère un viewer (le streamer lui-même)
    let viewerTest = null;
    try {
      const vRes = await fetch(`https://api.streamelements.com/kappa/v2/points/${channelId}/${me.username}`, {
        headers: { 'Authorization': `Bearer ${jwt}` }
      });
      const vText = await vRes.text();
      viewerTest = { status: vRes.status, body: JSON.parse(vText) };
    } catch(e) { viewerTest = { error: e.message }; }

    res.json({
      ok: match,
      channel: me.username,
      channel_id_env: channelId,
      channel_id_real: me._id,
      id_match: match,
      loyalty_enabled: me.modules?.loyalty ?? 'inconnu',
      viewer_test: viewerTest,
      message: match
        ? (viewerTest?.body?.watchtime !== undefined ? '✅ SE OK — watchtime disponible' : '⚠️ Loyalty System peut-être désactivé')
        : `❌ Channel ID incorrect dans .env. Correct: ${me._id}`
    });
  } catch(e) {
    res.json({ ok: false, message: 'Erreur réseau: ' + e.message });
  }
});

// ── Diagnostic Twitch live ─────────────────────────────────────────────────────
router.get('/diag/twitch', async (req,res) => {
  try {
    const twitch = require('../services/twitch');
    const live = await twitch.isChannelLive();
    res.json({ ok: true, live, channel: process.env.TWITCH_CHANNEL_LOGIN });
  } catch(e) {
    res.json({ ok: false, message: e.message });
  }
});


router.post('/change-password', async (req,res) => {
  if(!req.body.newPassword||req.body.newPassword.length<10) return res.status(400).json({ok:false,message:'10 caractères minimum.'});
  dbRun('UPDATE admin SET password_hash=? WHERE id=1',[await bcrypt.hash(req.body.newPassword,12)]);
  res.json({ok:true});
});


// ── Stats détaillées ───────────────────────────────────────────────────────────
router.get('/stats/detailed', (req,res) => {
  const totalPoints    = dbGet('SELECT COALESCE(SUM(points),0) AS s FROM users').s;
  const activeUsers7d  = dbGet('SELECT COUNT(*) AS c FROM users WHERE last_seen>datetime("now","-7 days")').c;
  const totalCompleted = dbGet('SELECT COUNT(*) AS c FROM user_challenges WHERE verified=1').c;
  const totalOrders2   = dbGet('SELECT COUNT(*) AS c FROM shop_orders').c;
  const totalUsers2    = dbGet('SELECT COUNT(*) AS c FROM users').c;
  const convRate       = totalUsers2 ? Math.round(totalOrders2/totalUsers2*100) : 0;

  const rankDist = dbAll('SELECT rank, COUNT(*) AS c FROM users GROUP BY rank ORDER BY CASE rank WHEN "gold" THEN 1 WHEN "silver" THEN 2 ELSE 3 END');
  const topChallenges = dbAll(`
    SELECT c.name, c.platform, COUNT(uc.id) AS completions
    FROM user_challenges uc JOIN challenges c ON uc.challenge_id=c.id
    WHERE uc.verified=1
    GROUP BY c.id ORDER BY completions DESC LIMIT 10`);
  const discordActivity = dbAll(`
    SELECT u.discord_username, u.username,
      SUM(CASE WHEN da.date>=date('now','-7 days') THEN da.messages ELSE 0 END) AS msgs7d,
      SUM(CASE WHEN da.date>=date('now','-7 days') THEN da.vocal_seconds ELSE 0 END) AS vocal7d,
      MAX(da.date) AS last_activity
    FROM discord_activity da JOIN users u ON da.user_id=u.id
    GROUP BY u.id HAVING msgs7d>0 OR vocal7d>0
    ORDER BY msgs7d DESC LIMIT 20`);
  const newUsers = dbAll(`SELECT username,discord_username,twitch_login,points,created_at FROM users WHERE created_at>datetime('now','-30 days') ORDER BY created_at DESC LIMIT 30`);

  const seConfigured = require('../services/streamelements').isConfigured();
  const stripeConfigured = require('../services/stripe').isStripeConfigured();
  res.json({ ok:true, totalPoints, activeUsers7d, totalCompleted, convRate, rankDist, topChallenges, discordActivity, newUsers, seConfigured, stripeConfigured });
});


// ── Reset challenge d'un utilisateur (remet à 0 compteurs + entrée user_challenges) ─
router.post('/users/:userId/challenge/:challengeId/reset', (req,res) => {
  const ch = dbGet('SELECT * FROM challenges WHERE id=?',[req.params.challengeId]);
  const entry = dbGet('SELECT * FROM user_challenges WHERE user_id=? AND challenge_id=?',[req.params.userId,req.params.challengeId]);

  // Si était validé, retire les points
  if(entry?.verified===1 && ch) removePoints(parseInt(req.params.userId), ch.points);

  // Supprime toutes les entrées pour ce challenge (toutes périodes)
  dbRun('DELETE FROM user_challenges WHERE user_id=? AND challenge_id=?',[req.params.userId,req.params.challengeId]);

  // Reset les compteurs spécifiques selon le type
  if(ch?.type==='watchtime'){
    dbRun('DELETE FROM twitch_watch_sessions WHERE user_id=?',[req.params.userId]);
  }
  if(ch?.type==='messages'){
    dbRun('UPDATE discord_activity SET messages=0 WHERE user_id=?',[req.params.userId]);
  }
  if(ch?.type==='vocal'){
    dbRun('UPDATE discord_activity SET vocal_seconds=0 WHERE user_id=?',[req.params.userId]);
  }

  res.json({ok:true,message:`Challenge "${ch?.name}" réinitialisé pour l'utilisateur.`});
});

// ── Reset TOUS les challenges d'un utilisateur ─────────────────────────────────
router.post('/users/:userId/reset-all', (req,res) => {
  const user = dbGet('SELECT * FROM users WHERE id=?',[req.params.userId]);
  if(!user) return res.status(404).json({ok:false});
  // Remet les points à 0
  dbRun('UPDATE users SET points=0,rank="bronze" WHERE id=?',[req.params.userId]);
  // Supprime tous les challenges
  dbRun('DELETE FROM user_challenges WHERE user_id=?',[req.params.userId]);
  // Reset toutes les activités
  dbRun('DELETE FROM twitch_watch_sessions WHERE user_id=?',[req.params.userId]);
  dbRun('UPDATE discord_activity SET messages=0,vocal_seconds=0 WHERE user_id=?',[req.params.userId]);
  res.json({ok:true,message:`Tous les défis de "${user.username}" remis à zéro.`});
});

// ── Reset les challenges de TOUS les utilisateurs ─────────────────────────────
router.post('/reset-all-users', (req,res) => {
  const { challengeId } = req.body;
  if(challengeId){
    // Reset un challenge spécifique pour tout le monde
    const ch = dbGet('SELECT * FROM challenges WHERE id=?',[challengeId]);
    // Retire les points de tous ceux qui l'avaient validé
    const validated = dbAll('SELECT user_id FROM user_challenges WHERE challenge_id=? AND verified=1',[challengeId]);
    for(const v of validated) removePoints(v.user_id, ch?.points||0);
    dbRun('DELETE FROM user_challenges WHERE challenge_id=?',[challengeId]);
    if(ch?.type==='watchtime') dbRun('DELETE FROM twitch_watch_sessions');
    if(ch?.type==='messages')  dbRun('UPDATE discord_activity SET messages=0');
    if(ch?.type==='vocal')     dbRun('UPDATE discord_activity SET vocal_seconds=0');
    res.json({ok:true,message:`Challenge "${ch?.name}" réinitialisé pour tous les membres.`});
  } else {
    // Reset total : tous challenges, tous users
    dbRun('UPDATE users SET points=0,rank="bronze"');
    dbRun('DELETE FROM user_challenges');
    dbRun('DELETE FROM twitch_watch_sessions');
    dbRun('UPDATE discord_activity SET messages=0,vocal_seconds=0');
    res.json({ok:true,message:'Programme remis à zéro pour tous les membres.'});
  }
});

module.exports = router;
