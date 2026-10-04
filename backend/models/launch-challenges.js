'use strict';
/**
 * Défis de l'ouverture du site.
 * Utilisés pour une installation neuve, et appliqués une fois sur une base existante
 * (migration "launch_v1" dans db.js). Ensuite, tout se gère depuis l'admin.
 *
 * Équilibrage (points) :
 *  - permanents = gros bonus de démarrage (≈ 60 000 pts au total) pour accrocher les nouveaux
 *  - quotidiens ≈ 1 200 pts/jour, hebdos ≈ 11 500 pts/semaine pour faire revenir
 */
const DAY = 86400, WEEK = 604800;

// [platform, slug, name, description, points, type, required_value, repeat_seconds, redirect_url, redirect_delay, category]
module.exports = [
  // ── Bienvenue (une seule fois) ────────────────────────────────────────────────
  ['discord',   'discord-join',      'Rejoindre le Discord K13',        'Rejoins le serveur Discord officiel K13.',                         1500, 'join',      0,      0, null, 0, 'permanent'],
  ['twitch',    'twitch-follow',     'Suivre K13 sur Twitch',           'Suis la chaîne Twitch K13 (vérification automatique).',             1000, 'follow',    0,      0, 'https://twitch.tv/k13esport', 0, 'permanent'],
  ['twitter',   'twitter-follow',    'Suivre K13 sur X',                'Abonne-toi au compte X de K13.',                                     800, 'redirect',  0,      0, 'https://x.com/K13Esport', 20, 'permanent'],
  ['tiktok',    'tiktok-follow',     'Suivre K13 sur TikTok',           'Abonne-toi au compte TikTok de K13.',                                800, 'redirect',  0,      0, 'https://www.tiktok.com/@k13esport', 20, 'permanent'],
  ['instagram', 'insta-follow',      'Suivre K13 sur Instagram',        'Abonne-toi au compte Instagram de K13.',                             800, 'redirect',  0,      0, 'https://www.instagram.com/k13esport1', 20, 'permanent'],
  ['epic',      'likemap',           'Aimer la map Fortnite K13',       'Mets un j\'aime sur la map K13 dans Fortnite et envoie une capture.', 1000, 'screen',    0,      0, null, 0, 'permanent'],

  // ── Progression (une seule fois, objectifs cumulés) ──────────────────────────
  ['twitch',    'twitch-watch-1h',   '1h de live K13',                  'Regarde 1h de live K13 au total.',                                  1000, 'watchtime', 3600,   0, null, 0, 'permanent'],
  ['twitch',    'twitch-watch-5h',   '5h de live K13',                  'Regarde 5h de live K13 au total.',                                  2500, 'watchtime', 18000,  0, null, 0, 'permanent'],
  ['twitch',    'twitch-watch-20h',  '20h de live K13',                 'Regarde 20h de live K13 au total.',                                 6000, 'watchtime', 72000,  0, null, 0, 'permanent'],
  ['twitch',    'twitch-watch-50h',  '50h de live K13',                 'Regarde 50h de live K13 au total. Un vrai fidèle !',               15000, 'watchtime', 180000, 0, null, 0, 'permanent'],
  ['discord',   'discord-msg-100',   '100 messages sur le Discord',     'Envoie 100 messages au total sur le Discord K13.',                  1500, 'messages',  100,    0, null, 0, 'permanent'],
  ['discord',   'discord-msg-1000',  '1 000 messages sur le Discord',   'Envoie 1 000 messages au total sur le Discord K13.',                8000, 'messages',  1000,   0, null, 0, 'permanent'],
  ['discord',   'discord-vocal-10h', '10h en vocal',                    'Passe 10h au total en vocal sur le Discord K13.',                   5000, 'vocal',     36000,  0, null, 0, 'permanent'],
  ['discord',   'discord-invite',    'Inviter 1 ami sur le Discord',    'Invite un ami sur le serveur Discord K13.',                         2000, 'invite',    1,      0, null, 0, 'permanent'],
  ['discord',   'discord-invite-5',  'Inviter 5 amis sur le Discord',   'Invite 5 amis sur le serveur Discord K13.',                        10000, 'invite',    5,      0, null, 0, 'permanent'],

  // ── Quotidiens ────────────────────────────────────────────────────────────────
  ['discord',   'discord-msg-daily',   '10 messages aujourd\'hui',      'Envoie 10 messages sur le Discord K13 aujourd\'hui.',                300, 'messages',  10,     DAY, null, 0, 'daily'],
  ['discord',   'discord-vocal-daily', '30 min en vocal aujourd\'hui',  'Passe 30 min en vocal sur le Discord K13 aujourd\'hui.',             400, 'vocal',     1800,   DAY, null, 0, 'daily'],
  ['twitch',    'twitch-watch-daily',  '30 min de live aujourd\'hui',   'Regarde 30 min de live K13 aujourd\'hui.',                           500, 'watchtime', 1800,   DAY, null, 0, 'daily'],

  // ── Hebdomadaires ─────────────────────────────────────────────────────────────
  ['discord',   'discord-msg-weekly',    '100 messages cette semaine',   'Envoie 100 messages sur le Discord K13 cette semaine.',            2000, 'messages',  100,    WEEK, null, 0, 'weekly'],
  ['discord',   'discord-vocal-weekly',  '3h de vocal cette semaine',    'Passe 3h en vocal sur le Discord K13 cette semaine.',              2500, 'vocal',     10800,  WEEK, null, 0, 'weekly'],
  ['twitch',    'twitch-watch-weekly',   '3h de live cette semaine',     'Regarde 3h de live K13 cette semaine.',                            3000, 'watchtime', 10800,  WEEK, null, 0, 'weekly'],
  ['discord',   'discord-invite-weekly', 'Inviter 2 amis cette semaine', 'Invite 2 amis sur le Discord K13 cette semaine.',                  4000, 'invite',    2,      WEEK, null, 0, 'weekly'],
];
