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
let _persistTimer = null;
function initDb() {
  if (_init) return _init;
  _init = initSqlJs().then(SQL => {
    const db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();
    _db = db;
    // Écriture disque groupée : sql.js garde la base en mémoire, on la sauvegarde
    // au plus toutes les 500 ms au lieu de réécrire tout le fichier à chaque requête.
    const persistNow = () => {
      clearTimeout(_persistTimer); _persistTimer = null;
      const tmp = DB_PATH + '.tmp';
      fs.writeFileSync(tmp, Buffer.from(db.export()));
      fs.renameSync(tmp, DB_PATH);
    };
    const persist = () => { if (!_persistTimer) _persistTimer = setTimeout(persistNow, 500); };
    _db._persist = persist;
    _db._persistNow = persistNow;
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

    // ── Migrations ──────────────────────────────────────────────────────────────
    const hasCol = (table, col) => (db.exec(`PRAGMA table_info(${table})`)[0]?.values || []).some(r => r[1] === col);

    // Points cumulés (le rang ne doit pas baisser quand on dépense des points en boutique)
    if (!hasCol('users', 'lifetime_points')) {
      db.run('ALTER TABLE users ADD COLUMN lifetime_points INTEGER NOT NULL DEFAULT 0');
      db.run(`UPDATE users SET lifetime_points = points + COALESCE((
        SELECT SUM(i.cost_points) FROM shop_orders o JOIN shop_items i ON o.item_id=i.id WHERE o.user_id=users.id),0)`);
      // Mêmes seuils que RANKS dans services/challenges.js
      db.run("UPDATE users SET rank = CASE WHEN lifetime_points>=2000 THEN 'gold' WHEN lifetime_points>=1000 THEN 'silver' ELSE 'bronze' END");
    }

    // Origine des sessions de visionnage : 'tracker' (bouton) ou 'se' (StreamElements)
    if (!hasCol('twitch_watch_sessions', 'source')) {
      db.run("ALTER TABLE twitch_watch_sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'tracker'");
      // L'ancienne ligne 'se_sync' contenait le cumul total SE → devient une ligne de base "historique"
      db.run(`UPDATE twitch_watch_sessions SET source='se', started_at='2000-01-01 00:00:00', ended_at='2000-01-01 00:00:00'
              WHERE ended_at='se_sync'`);
    }

    // Dernier cumul StreamElements connu (les syncs n'ajoutent que la différence)
    if (!hasCol('users', 'se_last_total')) {
      db.run('ALTER TABLE users ADD COLUMN se_last_total INTEGER DEFAULT NULL');
      db.run(`UPDATE users SET se_last_total=(SELECT SUM(seconds) FROM twitch_watch_sessions t WHERE t.user_id=users.id AND t.source='se')
              WHERE EXISTS (SELECT 1 FROM twitch_watch_sessions t WHERE t.user_id=users.id AND t.source='se')`);
    }

    // Compte X (Twitter) lié + préférence de notifications privées Discord
    for (const [col, def] of [['twitter_id', 'TEXT'], ['twitter_username', 'TEXT'], ['twitter_token', 'TEXT'],
      ['twitter_refresh', 'TEXT'], ['twitter_token_exp', 'INTEGER'], ['notify_dm', 'INTEGER NOT NULL DEFAULT 1']]) {
      if (!hasCol('users', col)) db.run(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
    }
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS ux_users_twitter ON users(twitter_id) WHERE twitter_id IS NOT NULL');
    // Message Discord (salon admin) associé à une demande de validation, pour le mettre à jour
    if (!hasCol('user_challenges', 'discord_msg_id')) db.run('ALTER TABLE user_challenges ADD COLUMN discord_msg_id TEXT');

    // Giveaways
    db.exec(`
      CREATE TABLE IF NOT EXISTS giveaways (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', prize TEXT NOT NULL DEFAULT '',
        image_url TEXT, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
        winners_count INTEGER NOT NULL DEFAULT 1,
        conditions TEXT NOT NULL DEFAULT '{}',
        ticket_cost INTEGER NOT NULL DEFAULT 0, max_bought INTEGER NOT NULL DEFAULT 0,
        bonus_per_challenge INTEGER NOT NULL DEFAULT 0, max_challenge_bonus INTEGER NOT NULL DEFAULT 0,
        rank_bonus INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        drawn_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS giveaway_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        giveaway_id INTEGER NOT NULL REFERENCES giveaways(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        bought INTEGER NOT NULL DEFAULT 0, spent INTEGER NOT NULL DEFAULT 0,
        joined_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(giveaway_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS giveaway_winners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        giveaway_id INTEGER NOT NULL REFERENCES giveaways(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        rank INTEGER NOT NULL DEFAULT 1,
        drawn_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Doublons user_challenges (même user / challenge / période) → on garde la ligne validée la plus ancienne
    db.run(`DELETE FROM user_challenges WHERE id IN (
      SELECT a.id FROM user_challenges a JOIN user_challenges b
        ON a.user_id=b.user_id AND a.challenge_id=b.challenge_id AND IFNULL(a.period_key,'')=IFNULL(b.period_key,'')
       AND (b.verified>a.verified OR (b.verified=a.verified AND b.id<a.id)))`);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_user_challenge_period
            ON user_challenges(user_id, challenge_id, IFNULL(period_key,''))`);
    db.run('CREATE INDEX IF NOT EXISTS ix_activity_user_date ON discord_activity(user_id,date)');
    db.run('CREATE INDEX IF NOT EXISTS ix_watch_user ON twitch_watch_sessions(user_id,started_at)');
    db.run('CREATE INDEX IF NOT EXISTS ix_invites_inviter ON discord_invites(inviter_id,invited_at)');

    // Les articles boutique par défaut étaient ré-insérés à chaque démarrage (pas de contrainte UNIQUE)
    // → on fusionne les doublons (mêmes nom/type/coût) en gardant le plus ancien.
    db.run(`UPDATE shop_orders SET item_id=(
              SELECT MIN(k.id) FROM shop_items k, shop_items s
              WHERE s.id=shop_orders.item_id AND k.name=s.name AND k.type=s.type AND k.cost_points=s.cost_points)`);
    db.run(`DELETE FROM shop_items WHERE id NOT IN (SELECT MIN(id) FROM shop_items GROUP BY name,type,cost_points)`);
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

    // Boutique (uniquement à la première initialisation)
    if (!db.exec('SELECT COUNT(*) FROM shop_items')[0].values[0][0]) [
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
// Force l'écriture immédiate (arrêt du serveur)
function dbFlush(){ if(_db) _db._persistNow(); }
module.exports={initDb,dbGet,dbAll,dbRun,dbFlush};
