'use strict';
const crypto = require('crypto');
const { dbGet, dbRun, dbAll } = require('../models/db');
const discord = require('./discord');
// Note: discord.getTotalInvites disponible si défini
const twitch  = require('./twitch');
const se      = require('./streamelements');

function updateRank(userId) {
  const u = dbGet('SELECT points FROM users WHERE id=?', [userId]);
  if (!u) return;
  const rank = u.points >= 2000 ? 'gold' : u.points >= 1000 ? 'silver' : 'bronze';
  dbRun('UPDATE users SET rank=? WHERE id=?', [rank, userId]);
  discord.syncRoleForUser(userId).catch(() => {});
}

// Formate les secondes en texte lisible (30 min, 1h, 1h 30min, etc.)
function fmtSecs(s) {
  if (!s || s === 0) return '0 min';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

function addPoints(userId, pts) {
  if (!pts || pts <= 0) return;
  dbRun('UPDATE users SET points=points+?,last_seen=datetime("now") WHERE id=?', [pts, userId]);
  updateRank(userId);
}
function removePoints(userId, pts) {
  dbRun('UPDATE users SET points=MAX(0,points-?) WHERE id=?', [pts, userId]);
  updateRank(userId);
}
function getPeriodKey(challenge) {
  if (!challenge.repeat_seconds) return null;
  const now = new Date();
  // Quotidien : clé = date du jour (YYYY-MM-DD heure Paris)
  if (challenge.repeat_seconds === 86400) {
    // Reset à minuit heure de Paris
    const paris = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    return `day-${paris.getFullYear()}-${String(paris.getMonth()+1).padStart(2,'0')}-${String(paris.getDate()).padStart(2,'0')}`;
  }
  // Hebdomadaire : clé = année + numéro de semaine ISO (lundi-dimanche)
  if (challenge.repeat_seconds === 604800) {
    const paris = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const dayOfWeek = paris.getDay() || 7; // 1=lundi..7=dimanche
    const mondayDate = new Date(paris); mondayDate.setDate(paris.getDate() - dayOfWeek + 1);
    return `week-${mondayDate.getFullYear()}-${String(mondayDate.getMonth()+1).padStart(2,'0')}-${String(mondayDate.getDate()).padStart(2,'0')}`;
  }
  // Mensuel : clé = YYYY-MM
  if (challenge.repeat_seconds === 2592000) {
    const paris = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    return `month-${paris.getFullYear()}-${String(paris.getMonth()+1).padStart(2,'0')}`;
  }
  // Autres : période glissante
  return `period-${Math.floor(Math.floor(Date.now()/1000) / challenge.repeat_seconds)}`;
}
function isAlreadyDone(userId, challengeId, periodKey) {
  if (periodKey) return !!dbGet('SELECT id FROM user_challenges WHERE user_id=? AND challenge_id=? AND period_key=?',[userId,challengeId,periodKey]);
  return !!dbGet('SELECT id FROM user_challenges WHERE user_id=? AND challenge_id=?',[userId,challengeId]);
}
function markDone(userId, challengeId, verified=1, periodKey=null, screenshotPath=null) {
  dbRun('INSERT OR IGNORE INTO user_challenges (user_id,challenge_id,verified,period_key,screenshot_path) VALUES (?,?,?,?,?)',
    [userId,challengeId,verified,periodKey,screenshotPath]);
}

// ── Initier une redirection (timer) ───────────────────────────────────────────
function initiateRedirect(userId, challengeId) {
  const token = crypto.randomBytes(16).toString('hex');
  dbRun('INSERT INTO pending_redirects (user_id,challenge_id,token) VALUES (?,?,?)', [userId,challengeId,token]);
  return token;
}

// Validation après le timer (appelé par le frontend)
function validateRedirectTimer(userId, token) {
  const p = dbGet('SELECT * FROM pending_redirects WHERE token=? AND user_id=? AND validated_at IS NULL', [token, userId]);
  if (!p) return { ok: false, message: 'Token invalide ou déjà utilisé.' };
  const ch = dbGet('SELECT * FROM challenges WHERE id=?', [p.challenge_id]);
  if (!ch) return { ok: false, message: 'Challenge introuvable.' };
  const elapsed = Math.floor((Date.now() - new Date(p.created_at).getTime()) / 1000);
  if (elapsed < (ch.redirect_delay - 3))
    return { ok: false, message: `Attends encore ${ch.redirect_delay - elapsed} secondes.` };
  dbRun('UPDATE pending_redirects SET validated_at=datetime("now") WHERE token=?', [token]);
  // Timer validé → points attribués directement, pas de screen requis
  const periodKey = getPeriodKey(ch);
  if (isAlreadyDone(userId, ch.id, periodKey))
    return { ok: false, message: 'Déjà complété !' };
  markDone(userId, ch.id, 1, periodKey);
  addPoints(userId, ch.points);
  return { ok: true, message: `+${ch.points} pts ! Challenge "${ch.name}" validé ✅`, points: ch.points };
}

async function verifyChallenge(userId, slug) {
  const user = dbGet('SELECT * FROM users WHERE id=?', [userId]);
  const ch   = dbGet('SELECT * FROM challenges WHERE slug=? AND active=1', [slug]);
  if (!ch) return { ok: false, message: 'Challenge introuvable.' };
  const periodKey = getPeriodKey(ch);
  // Pour les challenges screen : si déjà verified=1, c'est terminé. Si verified=0, on permet de renvoyer un screen.
  const existingEntry = periodKey
    ? dbGet('SELECT * FROM user_challenges WHERE user_id=? AND challenge_id=? AND period_key=?',[userId,ch.id,periodKey])
    : dbGet('SELECT * FROM user_challenges WHERE user_id=? AND challenge_id=?',[userId,ch.id]);
  if (existingEntry?.verified === 1)
    return { ok: false, message: periodKey ? 'Déjà fait pour cette période !' : 'Déjà complété !' };
  // Si pending (verified=0) et type screen, permet de renvoyer un screen
  if (existingEntry?.verified === 0 && ch.type === 'screen') {
    return { ok: true, screen: true, needsScreen: true, challengeId: ch.id,
      requireAdmin: ch.slug === 'twitch-sub' || ch.platform === 'epic',
      message: '📸 Un screen est déjà en attente. Tu peux en renvoyer un.' };
  }
  if (existingEntry?.verified === 0 && ch.type !== 'screen')
    return { ok: false, message: periodKey ? 'Déjà soumis pour cette période.' : 'Déjà soumis, en attente de validation.' };

  // ── Redirection + timer ────────────────────────────────────────────────────
  if (ch.type === 'redirect' && ch.redirect_url) {
    const token = initiateRedirect(userId, ch.id);
    return { ok: false, redirect: true, url: ch.redirect_url, token,
      delay: ch.redirect_delay || 20, challengeName: ch.name, challengeId: ch.id };
  }

  // ── Twitch : follow (API automatique) ────────────────────────────────────
  if (ch.slug === 'twitch-follow') {
    if (!user.twitch_id || !user.twitch_token)
      return { ok: false, message: 'Lie ton compte Twitch.', needsLink: 'twitch' };
    try {
      const follows = await twitch.checkFollow(userId);
      if (!follows) return { ok: false, message: 'Tu ne suis pas encore la chaîne Twitch K13. Suis-la puis réessaie.', openUrl: `https://www.twitch.tv/${process.env.TWITCH_CHANNEL_LOGIN||'k13esport'}` };
    } catch (e) {
      return { ok: false, message: 'Erreur Twitch : ' + e.message };
    }
    markDone(userId, ch.id, 1, periodKey);
    addPoints(userId, ch.points);
    return { ok: true, message: `+${ch.points} pts ! Follow Twitch vérifié ✅`, points: ch.points };
  }

  // ── Screen : twitch-sub + epic = admin requis / autres = auto-validé ──────
  if (ch.type === 'screen') {
    const needsAdmin = ch.slug === 'twitch-sub' || ch.platform === 'epic';
    markDone(userId, ch.id, 0, periodKey);
    return { ok: false, screen: true, needsScreen: true,
      challengeId: ch.id, challengeName: ch.name,
      requireAdmin: needsAdmin,
      message: '📸 Envoie un screenshot pour valider ce défi.' };
  }

  // ── Discord : join ─────────────────────────────────────────────────────────
  if (ch.type === 'join') {
    if (!user.discord_id) return { ok: false, message: 'Connecte ton Discord.', needsLink: 'discord' };
    const ok = await discord.checkGuildMember(user.discord_id).catch(() => false);
    if (!ok) return { ok: false, message: 'Tu n\'es pas encore dans le serveur Discord K13.' };
    markDone(userId, ch.id, 1, periodKey);
    addPoints(userId, ch.points);
    return { ok: true, message: `+${ch.points} pts ! Bienvenue sur le Discord K13 🎉`, points: ch.points };
  }

  // ── Discord : invitations ──────────────────────────────────────────────────
  if (ch.type === 'invite') {
    if (!user.discord_id) return { ok: false, message: 'Connecte ton Discord.', needsLink: 'discord' };
    const count = discord.getInviteCount(userId);
    if (count < ch.required_value)
      return { ok: false, message: `Tu as invité ${count} personne(s). Objectif : ${ch.required_value}.`,
        progress: { current: count, required: ch.required_value } };
    markDone(userId, ch.id, 1, periodKey);
    addPoints(userId, ch.points);
    return { ok: true, message: `+${ch.points} pts ! Invitation Discord validée ✅`, points: ch.points };
  }

  // ── Discord : messages ─────────────────────────────────────────────────────
  if (ch.type === 'messages') {
    if (!user.discord_id) return { ok: false, message: 'Connecte ton Discord.', needsLink: 'discord' };
    // Utilise la date Paris pour les challenges quotidiens
    let from = '2000-01-01';
    if (ch.repeat_seconds === 86400) {
      const paris = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
      from = `${paris.getFullYear()}-${String(paris.getMonth()+1).padStart(2,'0')}-${String(paris.getDate()).padStart(2,'0')}`;
    } else if (ch.repeat_seconds) {
      from = new Date(Date.now()-ch.repeat_seconds*1000).toISOString().split('T')[0];
    }
    const count = (dbGet('SELECT COALESCE(SUM(messages),0) AS c FROM discord_activity WHERE user_id=? AND date>=?',[userId,from])?.c)||0;
    if (count < ch.required_value)
      return { ok: false, message: `${count} messages envoyés. Objectif : ${ch.required_value}.`,
        progress: { current: count, required: ch.required_value } };
    markDone(userId, ch.id, 1, periodKey);
    addPoints(userId, ch.points);
    return { ok: true, message: `+${ch.points} pts ! Objectif messages Discord atteint ✅`, points: ch.points };
  }

  // ── Discord : vocal ────────────────────────────────────────────────────────
  if (ch.type === 'vocal') {
    if (!user.discord_id) return { ok: false, message: 'Connecte ton Discord.', needsLink: 'discord' };
    let from = '2000-01-01';
    if (ch.repeat_seconds === 86400) {
      const paris = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
      from = `${paris.getFullYear()}-${String(paris.getMonth()+1).padStart(2,'0')}-${String(paris.getDate()).padStart(2,'0')}`;
    } else if (ch.repeat_seconds) {
      from = new Date(Date.now()-ch.repeat_seconds*1000).toISOString().split('T')[0];
    }
    const secs = (dbGet('SELECT COALESCE(SUM(vocal_seconds),0) AS c FROM discord_activity WHERE user_id=? AND date>=?',[userId,from])?.c)||0;
    if (secs < ch.required_value) {
      return { ok: false, message: `${fmtSecs(secs)} en vocal. Encore ${fmtSecs(ch.required_value - secs)}.`,
        progress: { current: secs, required: ch.required_value } };
    }
    markDone(userId, ch.id, 1, periodKey);
    addPoints(userId, ch.points);
    return { ok: true, message: `+${ch.points} pts ! Temps vocal validé ✅`, points: ch.points };
  }

  // ── Twitch : watchtime ─────────────────────────────────────────────────────
  if (ch.type === 'watchtime') {
    if (!user.twitch_id) return { ok: false, message: 'Lie ton compte Twitch d\'abord.', needsLink: 'twitch' };

    // Si StreamElements est configuré, sync automatiquement avant de vérifier
    if (se.isConfigured()) {
      await se.syncWatchtimeForUser(userId).catch(() => {});
    }

    // Calcule le from selon la période
    let from = '2000-01-01T00:00:00.000Z';
    if (ch.repeat_seconds === 86400) {
      const paris = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
      paris.setHours(0,0,0,0);
      from = paris.toISOString();
    } else if (ch.repeat_seconds === 604800) {
      const paris = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
      const dow = paris.getDay() || 7;
      paris.setDate(paris.getDate() - dow + 1); paris.setHours(0,0,0,0);
      from = paris.toISOString();
    } else if (ch.repeat_seconds) {
      from = new Date(Date.now()-ch.repeat_seconds*1000).toISOString();
    }

    // Pour les challenges permanents (pas de période), inclut aussi la session SE sync
    const secs = (dbGet(
      'SELECT COALESCE(SUM(seconds),0) AS c FROM twitch_watch_sessions WHERE user_id=? AND (started_at>=? OR ended_at=?)',
      [userId, from, 'se_sync']
    )?.c)||0;

    if (secs < ch.required_value) {
      const seHint = se.isConfigured() ? ' (sync SE toutes les 5-10 min)' : ' — utilise le tracker si K13 est en live';
      return { ok: false, message: `${fmtSecs(secs)} regardés. Encore ${fmtSecs(ch.required_value - secs)}.${seHint}`,
        progress: { current: secs, required: ch.required_value } };
    }
    markDone(userId, ch.id, 1, periodKey);
    addPoints(userId, ch.points);
    return { ok: true, message: `+${ch.points} pts ! Watch time validé ✅`, points: ch.points };
  }

  // ── Discord : invite ──────────────────────────────────────────────────────
  if (ch.type === 'invite') {
    if (!user.discord_id) return { ok: false, message: 'Connecte ton Discord.', needsLink: 'discord' };
    const totalInvites = discord.getTotalInvites ? discord.getTotalInvites(userId) : 0;
    const required = ch.required_value || 1;
    if (totalInvites < required) {
      return { ok: false,
        message: `Tu as invité ${totalInvites} personne${totalInvites>1?'s':''}. Objectif : ${required}.`,
        progress: { current: totalInvites, required } };
    }
    markDone(userId, ch.id, 1, periodKey);
    addPoints(userId, ch.points);
    return { ok: true, message: `+${ch.points} pts ! Invitation Discord validée ✅`, points: ch.points };
  }

  return { ok: false, message: `Type de challenge "${ch.type}" non géré. Contacte l'admin.` };
}

function getUserStats(userId) {
  const user = dbGet('SELECT * FROM users WHERE id=?', [userId]);
  const challenges = dbAll('SELECT * FROM challenges WHERE active=1 ORDER BY category,platform,points');
  const completed  = dbAll('SELECT * FROM user_challenges WHERE user_id=? ORDER BY completed_at DESC', [userId]);
  const doneMap = {};
  for (const c of completed) {
    // Priorité aux entrées verified=1 sur les non-verified
    if (!doneMap[c.challenge_id] || (c.verified === 1 && doneMap[c.challenge_id].verified === 0)) {
      doneMap[c.challenge_id] = c;
    }
  }

  const watchSec  = (dbGet('SELECT COALESCE(SUM(seconds),0) AS t FROM twitch_watch_sessions WHERE user_id=?',[userId])?.t)||0;
  const discMsgs  = (dbGet('SELECT COALESCE(SUM(messages),0) AS t FROM discord_activity WHERE user_id=?',[userId])?.t)||0;
  const discVocal = (dbGet('SELECT COALESCE(SUM(vocal_seconds),0) AS t FROM discord_activity WHERE user_id=?',[userId])?.t)||0;
  const codes     = dbAll('SELECT * FROM promo_codes WHERE user_id=? ORDER BY created_at DESC',[userId]);
  const orders    = dbAll('SELECT o.*,i.name AS item_name FROM shop_orders o JOIN shop_items i ON o.item_id=i.id WHERE o.user_id=? ORDER BY o.created_at DESC',[userId]);
  const done      = challenges.filter(c => doneMap[c.id]?.verified===1).length;

  return {
    user: { id:user.id, username:user.username, points:user.points, rank:user.rank,
      discord_id:user.discord_id, discord_username:user.discord_username, discord_avatar:user.discord_avatar,
      twitch_login:user.twitch_login, twitch_id:user.twitch_id, epic_username:user.epic_username },
    challenges: challenges.map(c => {
      const entry = doneMap[c.id];
      const periodKey = getPeriodKey(c);
      const periodEntry = periodKey
        ? dbGet('SELECT * FROM user_challenges WHERE user_id=? AND challenge_id=? AND period_key=? ORDER BY completed_at DESC',[userId,c.id,periodKey])
        : null;
      const eff = periodKey ? periodEntry : entry;
      let progress = null;
      if (c.type==='watchtime') {
        let wtFrom = '2000-01-01T00:00:00.000Z';
        if (c.repeat_seconds === 86400) {
          const p=new Date(new Date().toLocaleString('en-US',{timeZone:'Europe/Paris'})); p.setHours(0,0,0,0); wtFrom=p.toISOString();
        } else if (c.repeat_seconds === 604800) {
          const p=new Date(new Date().toLocaleString('en-US',{timeZone:'Europe/Paris'})); const dow=p.getDay()||7; p.setDate(p.getDate()-dow+1); p.setHours(0,0,0,0); wtFrom=p.toISOString();
        } else if (c.repeat_seconds) {
          wtFrom=new Date(Date.now()-c.repeat_seconds*1000).toISOString();
        }
        // Pour les permanents, inclut aussi la session SE (se_sync)
        const wtQuery = c.repeat_seconds
          ? 'SELECT COALESCE(SUM(seconds),0) AS t FROM twitch_watch_sessions WHERE user_id=? AND started_at>=? AND ended_at!=?'
          : 'SELECT COALESCE(SUM(seconds),0) AS t FROM twitch_watch_sessions WHERE user_id=?';
        const wtParams = c.repeat_seconds ? [userId, wtFrom, 'se_sync'] : [userId];
        const wtTotal = c.repeat_seconds
          ? (dbGet(wtQuery, wtParams)?.t||0)
          : (dbGet('SELECT COALESCE(SUM(seconds),0) AS t FROM twitch_watch_sessions WHERE user_id=?',[userId])?.t||0);
        progress={current: wtTotal, required: c.required_value};
      }
      if (c.type==='invite') {
        const inv = discord.getInviteCount(userId, c.repeat_seconds);
        progress={current: inv, required: c.required_value||1};
      }
      if (c.type==='invite')    { progress={current:discord.getInviteCount(userId),required:c.required_value}; }
      if (c.type==='messages')  {
        let from='2000-01-01';
        if(c.repeat_seconds===86400){const p=new Date(new Date().toLocaleString('en-US',{timeZone:'Europe/Paris'}));from=`${p.getFullYear()}-${String(p.getMonth()+1).padStart(2,'0')}-${String(p.getDate()).padStart(2,'0')}`;}
        else if(c.repeat_seconds){from=new Date(Date.now()-c.repeat_seconds*1000).toISOString().split('T')[0];}
        progress={current:(dbGet('SELECT COALESCE(SUM(messages),0) AS t FROM discord_activity WHERE user_id=? AND date>=?',[userId,from])?.t)||0,required:c.required_value};
      }
      if (c.type==='vocal')     {
        let from='2000-01-01';
        if(c.repeat_seconds===86400){const p=new Date(new Date().toLocaleString('en-US',{timeZone:'Europe/Paris'}));from=`${p.getFullYear()}-${String(p.getMonth()+1).padStart(2,'0')}-${String(p.getDate()).padStart(2,'0')}`;}
        else if(c.repeat_seconds){from=new Date(Date.now()-c.repeat_seconds*1000).toISOString().split('T')[0];}
        progress={current:(dbGet('SELECT COALESCE(SUM(vocal_seconds),0) AS t FROM discord_activity WHERE user_id=? AND date>=?',[userId,from])?.t)||0,required:c.required_value};
      }
      return { ...c, completed:eff?.verified===1, pending:eff?.verified===0, progress, screenshotPath: eff?.screenshot_path||null };
    }),
    progression: { done, total:challenges.length, pct:challenges.length?Math.round(done/challenges.length*100):0 },
    activity: { watchSec, discMsgs, discVocal },
    codes, orders,
  };
}

module.exports = { verifyChallenge, validateRedirectTimer, getUserStats, addPoints, removePoints, updateRank, markDone };
