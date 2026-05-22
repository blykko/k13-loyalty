'use strict';
const initSqlJs = require('sql.js');
const path   = require('path');
const fs     = require('fs');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '../../data/k13.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let _db = null;
function getDb() { if (_db) return _db; throw new Error('DB non initialisée'); }

let _init = null;
function initDb() {
  if (_init) return _init;
  _init = initSqlJs().then(SQL => {
    const db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();
    _db = db;
    const persist = () => fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
    _db._persist = persist;
    db.run('PRAGMA foreign_keys=ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        points INTEGER NOT NULL DEFAULT 0,
        rank TEXT NOT NULL DEFAULT 'bronze',
        discord_id TEXT UNIQUE, discord_username TEXT, discord_avatar TEXT,
        discord_token TEXT, discord_refresh TEXT,
        twitch_id TEXT UNIQUE, twitch_login TEXT, twitch_token TEXT, twitch_refresh TEXT,
        epic_username TEXT, epic_creator_code TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS challenges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        points INTEGER NOT NULL,
        type TEXT NOT NULL DEFAULT 'screen',
        required_value INTEGER DEFAULT 0,
        repeat_seconds INTEGER NOT NULL DEFAULT 0,
        redirect_url TEXT DEFAULT NULL,
        redirect_delay INTEGER DEFAULT 20,
        category TEXT NOT NULL DEFAULT 'permanent',
        extra TEXT DEFAULT '{}',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS user_challenges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        challenge_id INTEGER NOT NULL REFERENCES challenges(id),
        completed_at TEXT NOT NULL DEFAULT (datetime('now')),
        verified INTEGER NOT NULL DEFAULT 0,
        period_key TEXT DEFAULT NULL,
        screenshot_path TEXT DEFAULT NULL,
        admin_note TEXT DEFAULT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_redirects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        challenge_id INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        validated_at TEXT DEFAULT NULL
      );
      CREATE TABLE IF NOT EXISTS twitch_watch_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT, seconds INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS discord_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        date TEXT NOT NULL,
        messages INTEGER NOT NULL DEFAULT 0,
        vocal_seconds INTEGER NOT NULL DEFAULT 0,
        UNIQUE(user_id,date)
      );
      CREATE TABLE IF NOT EXISTS shop_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, description TEXT NOT NULL,
        type TEXT NOT NULL, cost_points INTEGER NOT NULL,
        stock INTEGER NOT NULL DEFAULT -1,
        extra TEXT DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS shop_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        item_id INTEGER NOT NULL REFERENCES shop_items(id),
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS promo_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL REFERENCES users(id),
        discount INTEGER NOT NULL, tier TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0, used_at TEXT,
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY, password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expire INTEGER NOT NULL);
      -- Tracking des invitations Discord
      CREATE TABLE IF NOT EXISTS discord_invites (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        inviter_id  INTEGER NOT NULL REFERENCES users(id),
        invited_discord_id TEXT NOT NULL,
        invited_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    persist();

    // Challenges par défaut
    const defaults = [
      // Daily
      ['discord','discord-msg-daily',   '20 messages Discord (quotidien)',  'Envoie 20 messages sur le serveur Discord K13 aujourd\'hui.',   50, 'messages', 20,   86400, null, 0, 'daily'],
      ['discord','discord-vocal-daily', '1h en vocal Discord (quotidien)',  'Passe 1h en vocal sur le Discord K13 aujourd\'hui.',           80, 'vocal',    3600, 86400, null, 0, 'daily'],
      ['twitch', 'twitch-watch-daily',  '30min de stream (quotidien)',      'Regarde 30min de live K13 aujourd\'hui.',                      40, 'watchtime',1800, 86400, null, 0, 'daily'],
      // Weekly
      ['discord','discord-msg-weekly',  '100 messages Discord (hebdo)',     'Envoie 100 messages sur le Discord K13 cette semaine.',       120, 'messages', 100, 604800, null, 0, 'weekly'],
      ['twitch', 'twitch-watch-weekly', '5h de stream (hebdo)',             'Regarde 5h de live K13 cette semaine.',                       150, 'watchtime',18000,604800,null, 0, 'weekly'],
      // Permanent
      ['discord','discord-join',        'Rejoindre le Discord K13',         'Rejoins le serveur Discord officiel K13.',                    100, 'join',     0,    0,     null, 0, 'permanent'],
      ['twitch', 'twitch-follow',       'Follow Twitch K13',                'Suis la chaîne Twitch K13 (vérification automatique).',         50, 'follow',   0,    0,     'https://twitch.tv/k13esport', 0, 'permanent'],
      ['twitch', 'twitch-sub',          'Sub Twitch K13',                   'Abonne-toi à K13 sur Twitch (sub ou prime). Envoie un screen.',200,'screen',   0,    0,     'https://twitch.tv/k13esport', 0, 'permanent'],
      ['twitch', 'twitch-watch-1h',     '1h de visionnage (cumulé)',        'Atteins 1h cumulée de stream K13 en live.',                    60, 'watchtime',3600, 0,     null, 0, 'permanent'],
      ['twitch', 'twitch-watch-5h',     '5h de visionnage (cumulé)',        'Atteins 5h cumulées de stream K13 en live.',                  150, 'watchtime',18000,0,     null, 0, 'permanent'],
      ['twitch', 'twitch-watch-20h',    '20h de visionnage (cumulé)',       'Atteins 20h cumulées de stream K13 en live.',                 400, 'watchtime',72000,0,     null, 0, 'permanent'],
      ['twitter','twitter-follow',      'Follow K13 sur X (Twitter)',       'Suis @K13Esport. Envoie un screen après 20 secondes.',         30, 'redirect', 0,    0,     'https://twitter.com/K13Esport', 20, 'permanent'],
      ['tiktok', 'tiktok-follow',       'Follow K13 sur TikTok',           'Suis K13 sur TikTok. Envoie un screen après le timer.',         30, 'redirect', 0,    0,     'https://www.tiktok.com/@k13esport', 20, 'permanent'],
      ['instagram','insta-follow',      'Follow K13 sur Instagram',         'Suis K13 sur Instagram. Envoie un screen après le timer.',      30, 'redirect', 0,    0,     'https://www.instagram.com/k13esport1', 20, 'permanent'],
            ['discord','discord-invite',      'Inviter quelqu\'un sur le Discord','Invite une personne sur le serveur Discord K13.',             100,'invite',    0,    0,     null, 0, 'permanent'],
      ['epic',   'epic-creator',        'Code créateur Epic Games',         'Utilise le code créateur K13 dans Epic. Envoie un screen.',   150, 'screen',   0,    0,     null, 0, 'permanent'],
      ['discord','discord-invite-daily', 'Inviter 2 amis sur Discord (quotidien)','Invite 2 amis qui rejoignent le serveur K13 aujourd\'hui.',  100, 'invite',   2,    86400, null, 0, 'daily'],
    ];
    const ins = db.prepare(`INSERT OR IGNORE INTO challenges (platform,slug,name,description,points,type,required_value,repeat_seconds,redirect_url,redirect_delay,category,extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,'{}') `);
    for (const r of defaults) ins.run(r);

    // Boutique
    [
      ['Code promo -5%',  'Code de réduction 5% sur la boutique K13. Valable 30 jours.',  'promo_code',  500, -1, '{"discount":5,"tier":"bronze"}'],
      ['Code promo -10%', 'Code de réduction 10% sur la boutique K13. Valable 30 jours.', 'promo_code', 1000, -1, '{"discount":10,"tier":"silver"}'],
      ['Code promo -20%', 'Code de réduction 20% sur la boutique K13. Valable 30 jours.', 'promo_code', 2000, -1, '{"discount":20,"tier":"gold"}'],
      ['Rôle Fan Discord','Rôle "Fan K13" sur le serveur Discord.',                        'discord_role', 300,-1, '{}'],
      ['Rôle VIP Discord','Rôle "VIP K13" exclusif + avantages.',                          'discord_role',1500,-1, '{}'],
    ].forEach(r => db.prepare('INSERT OR IGNORE INTO shop_items (name,description,type,cost_points,stock,extra) VALUES (?,?,?,?,?,?)').run(r));

    // Admin
    if (!db.exec('SELECT id FROM admin WHERE id=1')[0]?.values.length)
      db.run('INSERT INTO admin (id,password_hash) VALUES (1,?)', [bcrypt.hashSync(process.env.ADMIN_PASSWORD||'k13admin2025',12)]);

    persist();
    console.log('[DB] Prêt →', DB_PATH);
    return db;
  });
  return _init;
}

function dbGet(sql,p=[]){const r=getDb().exec(sql,p);if(!r.length||!r[0].values.length)return undefined;return Object.fromEntries(r[0].columns.map((c,i)=>[c,r[0].values[0][i]]))}
function dbAll(sql,p=[]){const r=getDb().exec(sql,p);if(!r.length)return[];return r[0].values.map(row=>Object.fromEntries(r[0].columns.map((c,i)=>[c,row[i]])))}
function dbRun(sql,p=[]){getDb().run(sql,p);const m=getDb().exec('SELECT last_insert_rowid() AS id,changes() AS ch');getDb()._persist();return m.length?{lastInsertRowid:m[0].values[0][0],changes:m[0].values[0][1]}:{lastInsertRowid:0,changes:0}}
module.exports={initDb,dbGet,dbAll,dbRun};
