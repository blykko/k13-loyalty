'use strict';
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path    = require('path');
const { initDb, dbGet, dbRun } = require('./models/db');
const discordBot = require('./services/discord-bot');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Session store SQLite ────────────────────────────────────────────────────────
// IMPORTANT : dbGet/dbRun ne fonctionnent qu'après initDb() — c'est pourquoi
// les routes sont enregistrées DANS le .then() ci-dessous
class SQLiteStore extends session.Store {
  get(sid, cb) {
    try {
      const row = dbGet('SELECT data FROM sessions WHERE sid=? AND expire>?', [sid, Math.floor(Date.now()/1000)]);
      const data = row ? JSON.parse(row.data) : null;
      console.log('[Session.get] sid:', sid.substring(0,8)+'...', '| userId:', data?.userId ?? 'NONE');
      cb(null, data);
    } catch(e) {
      console.error('[Session.get] ERROR:', e.message);
      cb(null, null);
    }
  }
  set(sid, sess, cb) {
    try {
      const exp  = Math.floor(Date.now()/1000) + 604800;
      dbRun('INSERT OR REPLACE INTO sessions (sid,data,expire) VALUES (?,?,?)', [sid, JSON.stringify(sess), exp]);
      console.log('[Session.set] sid:', sid.substring(0,8)+'...', '| userId:', sess.userId ?? 'NONE');
      cb(null);
    } catch(e) {
      console.error('[Session.set] ERROR:', e.message);
      cb(e);
    }
  }
  destroy(sid, cb) {
    try { dbRun('DELETE FROM sessions WHERE sid=?', [sid]); } catch {}
    cb(null);
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

setInterval(() => { try { dbRun('DELETE FROM sessions WHERE expire<?', [Math.floor(Date.now()/1000)]); } catch {} }, 3600000);

const isProduction = process.env.NODE_ENV === 'production';

app.use(session({
  store:             new SQLiteStore(),
  secret:            process.env.SESSION_SECRET || 'dev-secret-k13-v4',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   isProduction,
    httpOnly: true,
    maxAge:   7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
  },
}));

const PORT = process.env.PORT || 3000;

// Toutes les routes sont enregistrées APRÈS initDb() pour garantir
// que la DB est prête quand le session store l'utilise
initDb().then(() => {
  // Force no-cache sur index.html pour que /auth/me soit toujours appelé après redirect OAuth
  app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
  });
  app.use(express.static(path.join(__dirname, '../frontend/public')));
  app.use('/uploads', express.static(path.join(__dirname, '../frontend/public/uploads')));
  app.use('/auth',      require('./routes/auth'));
  app.use('/api/user',  require('./routes/user'));
  app.use('/api/admin', require('./routes/admin'));

  app.get('/admin*', (_, res) => res.sendFile(path.join(__dirname, '../frontend/public/admin.html')));
  app.get('*',       (_, res) => res.sendFile(path.join(__dirname, '../frontend/public/index.html')));

  discordBot.startBot();
  app.listen(PORT, () => {
    console.log(`\n🎮 K13 Loyalty  →  http://localhost:${PORT}`);
    console.log(`   Admin        →  http://localhost:${PORT}/admin\n`);
  });
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
