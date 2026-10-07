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
      db.run("UPDATE users SET rank = CASE WHEN lifetime_points>=2000 THEN 'gold' WHEN lifetime_points>=1000 THEN 'silver' ELSE 'bronze' END"); // seuils avant ×10
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

    // Fidélisation : série quotidienne, parrainage, jeux
    for (const [col, def] of [['streak', 'INTEGER NOT NULL DEFAULT 0'], ['best_streak', 'INTEGER NOT NULL DEFAULT 0'], ['last_daily', 'TEXT'],
      ['ref_code', 'TEXT'], ['referred_by', 'INTEGER'], ['referral_rewarded', 'INTEGER NOT NULL DEFAULT 0'],
      ['games_disabled', 'INTEGER NOT NULL DEFAULT 0'], ['last_gift', 'TEXT'], ['streak_shields', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (!hasCol('users', col)) db.run(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
    }
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS ux_users_ref ON users(ref_code) WHERE ref_code IS NOT NULL');
    db.exec(`
      -- Historique de tous les mouvements de points (classement du mois, historique membre)
      CREATE TABLE IF NOT EXISTS points_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, delta INTEGER NOT NULL,
        reason TEXT NOT NULL, label TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS ix_points_log_user ON points_log(user_id, created_at);
      CREATE INDEX IF NOT EXISTS ix_points_log_date ON points_log(created_at, reason);
      CREATE TABLE IF NOT EXISTS user_badges (
        user_id INTEGER NOT NULL, badge TEXT NOT NULL,
        unlocked_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, badge)
      );
      CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blackjack_games (
        user_id INTEGER PRIMARY KEY, bet INTEGER NOT NULL, state TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Économie v2 : tous les montants ×10 (une seule fois). Les proportions sont conservées,
    // personne ne change de rang ; l'historique est aussi converti pour le classement du mois.
    if (!db.exec("SELECT 1 FROM app_settings WHERE key='economy_v2'")[0]) {
      const hadData = db.exec('SELECT COUNT(*) FROM users')[0].values[0][0] > 0;
      if (hadData) {
        db.run('UPDATE users SET points=points*10, lifetime_points=lifetime_points*10');
        db.run('UPDATE challenges SET points=points*10');
        db.run('UPDATE shop_items SET cost_points=cost_points*10');
        db.run('UPDATE points_log SET delta=delta*10');
        console.log('[DB] Économie v2 : montants multipliés par 10');
      }
      db.run("INSERT INTO app_settings (key,value) VALUES ('economy_v2', datetime('now'))");
    }

    // Défis de l'ouverture (une seule fois) : met à jour / crée la liste officielle
    // et désactive les autres (réactivables depuis l'admin, rien n'est supprimé)
    if (!db.exec("SELECT 1 FROM app_settings WHERE key='launch_v1'")[0]) {
      const list = require('./launch-challenges');
      for (const [platform, slug, name, description, points, type, req, rep, url, delay, category] of list) {
        const exists = db.exec('SELECT id FROM challenges WHERE slug=?', [slug])[0];
        if (exists) db.run(`UPDATE challenges SET platform=?, name=?, description=?, points=?, type=?, required_value=?, repeat_seconds=?,
            redirect_url=COALESCE(redirect_url, ?), redirect_delay=?, category=?, active=1 WHERE slug=?`,
          [platform, name, description, points, type, req, rep, url, delay, category, slug]);
        else db.run(`INSERT INTO challenges (platform,slug,name,description,points,type,required_value,repeat_seconds,redirect_url,redirect_delay,category,extra)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,'{}')`, [platform, slug, name, description, points, type, req, rep, url, delay, category]);
      }
      db.run(`UPDATE challenges SET active=0 WHERE slug NOT IN (${list.map(() => '?').join(',')})`, list.map(c => c[1]));
      db.run("INSERT INTO app_settings (key,value) VALUES ('launch_v1', datetime('now'))");
      console.log(`[DB] Défis de lancement appliqués (${list.length} défis)`);
    }

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
    const defaults = require('./launch-challenges');
    const ins = db.prepare(`INSERT OR IGNORE INTO challenges (platform,slug,name,description,points,type,required_value,repeat_seconds,redirect_url,redirect_delay,category,extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,'{}') `);
    for (const r of defaults) ins.run(r);

    // Boutique (uniquement à la première initialisation)
    if (!db.exec('SELECT COUNT(*) FROM shop_items')[0].values[0][0]) [
      ['Code promo -5%',  'Code de réduction 5% sur la boutique K13. Valable 30 jours.',  'promo_code',  5000, -1, '{"discount":5,"tier":"bronze"}'],
      ['Code promo -10%', 'Code de réduction 10% sur la boutique K13. Valable 30 jours.', 'promo_code', 10000, -1, '{"discount":10,"tier":"silver"}'],
      ['Code promo -20%', 'Code de réduction 20% sur la boutique K13. Valable 30 jours.', 'promo_code', 20000, -1, '{"discount":20,"tier":"gold"}'],
      ['Rôle Fan Discord','Rôle "Fan K13" sur le serveur Discord.',                        'discord_role', 3000,-1, '{}'],
      ['Rôle VIP Discord','Rôle "VIP K13" exclusif + avantages.',                          'discord_role',15000,-1, '{}'],
    ].forEach(r => db.prepare('INSERT OR IGNORE INTO shop_items (name,description,type,cost_points,stock,extra) VALUES (?,?,?,?,?,?)').run(r));

    // Nouveaux articles boutique (une seule fois ; modifiables / désactivables dans l'admin)
    if (!db.exec("SELECT 1 FROM app_settings WHERE key='shop_v2'")[0]) {
      const SHOP_V2 = [
        ['Protection de série', 'Garde ta série 🔥 même si tu rates un jour de /daily. Utilisée automatiquement (3 max en réserve).', 'streak_shield', 2500, -1, '{"emoji":"🧊"}', 1],
        ['Shout-out en live', 'Ton pseudo cité et remercié en direct pendant un live K13.', 'product', 7500, -1, '{"emoji":"📣"}', 1],
        ['Choisis le jeu d\'un live', 'Tu décides du jeu (ou du mode) joué pendant une partie d\'un prochain live.', 'product', 15000, -1, '{"emoji":"🎮"}', 1],
        ['Ton pseudo en fin de vidéo', 'Ton pseudo dans les remerciements d\'une prochaine vidéo K13.', 'product', 12000, -1, '{"emoji":"🎬"}', 1],
        ['Une game avec K13 en live', 'Une place dans le lobby pour jouer avec l\'équipe K13 en direct.', 'product', 30000, 5, '{"emoji":"🕹️"}', 1],
        ['Ton emote sur le Discord', 'Propose une emote : si elle est validée, elle est ajoutée au serveur avec ton nom.', 'product', 40000, -1, '{"emoji":"😎"}', 1],
        ['Sub Twitch offert (1 mois)', 'Un abonnement Twitch d\'un mois offert sur la chaîne K13.', 'product', 60000, 3, '{"emoji":"💜"}', 0],
      ];
      for (const [name, description, type, cost, stock, extra, active] of SHOP_V2)
        if (!db.exec('SELECT 1 FROM shop_items WHERE name=?', [name])[0])
          db.run('INSERT INTO shop_items (name,description,type,cost_points,stock,extra,active) VALUES (?,?,?,?,?,?,?)', [name, description, type, cost, stock, extra, active]);
      db.run("INSERT INTO app_settings (key,value) VALUES ('shop_v2', datetime('now'))");
    }

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
// Sauvegarde quotidienne dans data/backups (14 jours conservés).
// ⚠️ Copier aussi ce dossier hors du VPS (ex. rclone, rsync) pour se protéger d'une panne disque.
// name : sauvegarde ponctuelle (ex. avant un reset), jamais supprimée par la rotation
function dbBackup(keep=14,name=null){
  if(!_db) return;
  const dir=path.join(path.dirname(DB_PATH),'backups'); fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,name?`k13-${name}-${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}.db`:`k13-${new Date().toISOString().slice(0,10)}.db`);
  fs.writeFileSync(file,Buffer.from(_db.export()));
  if(name) return file;
  fs.readdirSync(dir).filter(f=>/^k13-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0,-keep).forEach(f=>fs.unlinkSync(path.join(dir,f)));
  return file;
}
module.exports={initDb,dbGet,dbAll,dbRun,dbFlush,dbBackup};
