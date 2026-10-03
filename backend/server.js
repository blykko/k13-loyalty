'use strict';
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path    = require('path');
const { initDb, dbGet, dbRun, dbFlush, dbBackup } = require('./models/db');
const discordBot = require('./services/discord-bot');

const PUBLIC = path.join(__dirname, '../frontend/public');
const isProduction = process.env.NODE_ENV === 'production';
const SESSION_TTL = 7 * 24 * 3600; // secondes

const app = express();
app.disable('x-powered-by');
// Derrière un reverse proxy (nginx, Traefik…) : nécessaire pour que le cookie
// "secure" soit posé en HTTPS, sinon la session est perdue après l'OAuth.
if (isProduction) app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// ── Session store SQLite ────────────────────────────────────────────────────────
// dbGet/dbRun ne fonctionnent qu'après initDb() — les routes sont donc
// enregistrées DANS le .then() ci-dessous.
const now = () => Math.floor(Date.now() / 1000);
class SQLiteStore extends session.Store {
  get(sid, cb) {
    try {
      const row = dbGet('SELECT data FROM sessions WHERE sid=? AND expire>?', [sid, now()]);
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (e) {
      console.error('[Session.get]', e.message);
      cb(null, null);
    }
  }
  set(sid, sess, cb) {
    try {
      dbRun('INSERT OR REPLACE INTO sessions (sid,data,expire) VALUES (?,?,?)', [sid, JSON.stringify(sess), now() + SESSION_TTL]);
      cb(null);
    } catch (e) {
      console.error('[Session.set]', e.message);
      cb(e);
    }
  }
  destroy(sid, cb) {
    try { dbRun('DELETE FROM sessions WHERE sid=?', [sid]); } catch {}
    cb(null);
  }
  // Prolonge la session sans la réécrire (au plus une fois par heure)
  touch(sid, sess, cb) {
    try { dbRun('UPDATE sessions SET expire=? WHERE sid=? AND expire<?', [now() + SESSION_TTL, sid, now() + SESSION_TTL - 3600]); } catch {}
    cb(null);
  }
}

app.use(session({
  store:             new SQLiteStore(),
  secret:            process.env.SESSION_SECRET || 'dev-secret-k13-v4',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   isProduction,
    httpOnly: true,
    maxAge:   SESSION_TTL * 1000,
    sameSite: 'lax',
  },
}));

// Variables indispensables : sans elles la connexion Discord échoue ("Invalid Form Body")
const missingEnv = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI', 'SESSION_SECRET'].filter(k => !process.env[k]);
if (missingEnv.length) console.warn(`⚠️  Variables d'environnement manquantes : ${missingEnv.join(', ')} (fichier .env non chargé ?)`);
if (isProduction && !process.env.SESSION_SECRET) console.warn('⚠️  SESSION_SECRET non défini : sessions non sécurisées !');

const PORT = process.env.PORT || 3000;

initDb().then(() => {
  setInterval(() => { try { dbRun('DELETE FROM sessions WHERE expire<?', [now()]); } catch {} }, 3600000);

  // index.html jamais mis en cache pour que /auth/me soit toujours rappelé après l'OAuth
  const sendIndex = (req, res) => {
    // Lien de parrainage : /?ref=CODE (gardé en session jusqu'à l'inscription)
    if (typeof req.query.ref === 'string' && /^[A-Za-z0-9]{6}$/.test(req.query.ref) && !req.session.userId) req.session.ref = req.query.ref.toUpperCase();
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(PUBLIC, 'index.html'));
  };
  app.get('/', sendIndex);
  app.get('/leaderboard', (_, res) => res.sendFile(path.join(PUBLIC, 'leaderboard.html')));
  // JS/CSS/HTML : le navigateur revalide à chaque chargement (ETag → 304 si inchangé),
  // sinon après une mise à jour il mélange une page neuve avec un ancien script.
  // Images : cache 1 jour.
  app.use(express.static(PUBLIC, {
    index: false,
    setHeaders: (res, file) => {
      res.setHeader('Cache-Control', /\.(js|css|html)$/.test(file) ? 'no-cache' : (isProduction ? 'public, max-age=86400' : 'no-cache'));
    },
  }));
  app.use('/auth',      require('./routes/auth'));
  app.use('/api/user',  require('./routes/user'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api', (_, res) => res.status(404).json({ ok: false, message: 'Route inconnue.' }));

  app.get('/admin*', (_, res) => res.sendFile(path.join(PUBLIC, 'admin.html')));
  app.get('*', sendIndex);

  // Erreurs non gérées (JSON invalide, fichier trop gros…)
  app.use((err, req, res, _next) => {
    console.error('[Erreur]', req.method, req.path, err.message);
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    res.status(status).json({ ok: false, message: err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop lourd (8 Mo max).' : 'Erreur serveur.' });
  });

  // Sauvegarde de la base au démarrage puis toutes les 6 h (un fichier par jour)
  const backup = () => { try { console.log('[Backup]', dbBackup()); } catch (e) { console.error('[Backup] échec :', e.message); } };
  setTimeout(backup, 10_000);
  setInterval(backup, 6 * 3600_000);

  discordBot.startBot();
  const server = app.listen(PORT, () => {
    console.log(`\n🎮 K13 Loyalty  →  http://localhost:${PORT}`);
    console.log(`   Admin        →  http://localhost:${PORT}/admin\n`);
  });

  // Arrêt propre (docker stop) : enregistre le vocal en cours et écrit la base sur disque
  const shutdown = sig => {
    console.log(`[${sig}] Arrêt…`);
    try { discordBot.stopBot(); } catch {}
    try { dbFlush(); } catch (e) { console.error('DB flush failed:', e); }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
