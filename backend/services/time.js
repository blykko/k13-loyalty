'use strict';
// Helpers de dates centralisés : toutes les périodes (quotidien, hebdo, mensuel)
// sont calculées sur le fuseau Europe/Paris, et toutes les dates stockées en base
// par SQLite (datetime('now')) sont en UTC au format "YYYY-MM-DD HH:MM:SS".

const TZ = 'Europe/Paris';
const DAY = 86400, WEEK = 604800, MONTH = 2592000;

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function parisParts(date = new Date()) {
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

// Décalage Paris - UTC (en ms) à un instant donné
function offsetMs(date) {
  const p = parisParts(date);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

// Instant UTC correspondant à minuit (heure de Paris) du jour y-m-d
function parisMidnight(y, m, d) {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetMs(new Date(guess));
  t = guess - offsetMs(new Date(t)); // 2e passe pour les changements d'heure
  return new Date(t);
}

const pad = n => String(n).padStart(2, '0');

// "YYYY-MM-DD" (jour calendaire à Paris)
function parisDate(date = new Date()) {
  const p = parisParts(date);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

// Format SQLite UTC "YYYY-MM-DD HH:MM:SS"
function toSql(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// Parse une date SQLite (UTC sans suffixe) de façon indépendante du fuseau du serveur
function fromSql(s) {
  if (!s) return null;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) return new Date(s);
  return new Date(s.replace(' ', 'T') + 'Z');
}

// Début de la période courante pour un challenge répétable (null = permanent)
function periodStart(repeatSeconds, now = new Date()) {
  if (!repeatSeconds) return null;
  const p = parisParts(now);
  if (repeatSeconds === DAY) return parisMidnight(p.y, p.m, p.d);
  if (repeatSeconds === WEEK) {
    const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() || 7; // 1=lundi..7=dimanche
    const monday = new Date(Date.UTC(p.y, p.m - 1, p.d - dow + 1));
    return parisMidnight(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
  }
  if (repeatSeconds === MONTH) return parisMidnight(p.y, p.m, 1);
  // Période personnalisée : fenêtres fixes alignées sur l'epoch
  const s = Math.floor(now.getTime() / 1000);
  return new Date(Math.floor(s / repeatSeconds) * repeatSeconds * 1000);
}

// Clé de période stockée dans user_challenges.period_key
function periodKey(repeatSeconds, now = new Date()) {
  if (!repeatSeconds) return null;
  const start = periodStart(repeatSeconds, now);
  if (repeatSeconds === DAY)   return `day-${parisDate(start)}`;
  if (repeatSeconds === WEEK)  return `week-${parisDate(start)}`;
  if (repeatSeconds === MONTH) return `month-${parisDate(start).slice(0, 7)}`;
  return `period-${Math.floor(start.getTime() / 1000 / repeatSeconds)}`;
}

module.exports = { TZ, DAY, WEEK, MONTH, parisDate, toSql, fromSql, periodStart, periodKey };
