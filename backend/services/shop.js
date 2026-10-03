'use strict';
const crypto  = require('crypto');
const { dbGet, dbRun, dbAll } = require('../models/db');
const discord = require('./discord');
const stripe  = require('./stripe');

const PROMO_VALIDITY_DAYS = 30;

function getItems() {
  return dbAll('SELECT id,name,description,type,cost_points,stock FROM shop_items WHERE active=1 ORDER BY cost_points');
}

function parseExtra(item) {
  try { return JSON.parse(item.extra || '{}'); } catch { return {}; }
}

function randomCode(tier) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  const suffix = Array.from(bytes, b => chars[b % chars.length]).join('');
  return `K13-${tier.toUpperCase()}-${suffix}`;
}

async function purchase(userId, itemId) {
  const user = dbGet('SELECT * FROM users WHERE id=?', [userId]);
  const item = dbGet('SELECT * FROM shop_items WHERE id=? AND active=1', [itemId]);
  if (!user || !item) return { ok: false, message: 'Article introuvable.' };
  if (item.stock === 0) return { ok: false, message: 'Stock épuisé.' };
  if (user.points < item.cost_points)
    return { ok: false, message: `Il te faut ${item.cost_points} pts. Tu en as ${user.points}.` };

  const extra = parseExtra(item);

  // Vérifications AVANT de débiter les points
  let roleId = null;
  if (item.type === 'discord_role') {
    roleId = extra.role_id || process.env[extra.role_env] || '';
    if (!roleId) return { ok: false, message: 'Ce rôle n\'est pas encore configuré. Contacte un admin.' };
    if (!user.discord_id) return { ok: false, message: 'Connecte ton Discord pour recevoir le rôle.' };
    if (!(await discord.checkGuildMember(user.discord_id).catch(() => false)))
      return { ok: false, message: 'Rejoins d\'abord le serveur Discord K13 pour recevoir le rôle.' };
  }

  // Débit atomique (évite le double achat par double-clic)
  const debit = dbRun('UPDATE users SET points=points-? WHERE id=? AND points>=?', [item.cost_points, userId, item.cost_points]);
  if (!debit.changes) return { ok: false, message: 'Points insuffisants.' };
  const { logPoints } = require('./challenges');
  logPoints(userId, -item.cost_points, 'shop', item.name);
  if (item.stock > 0) {
    const st = dbRun('UPDATE shop_items SET stock=stock-1 WHERE id=? AND stock>0', [itemId]);
    if (!st.changes) {
      dbRun('UPDATE users SET points=points+? WHERE id=?', [item.cost_points, userId]);
      return { ok: false, message: 'Stock épuisé.' };
    }
  }
  const refund = () => {
    dbRun('UPDATE users SET points=points+? WHERE id=?', [item.cost_points, userId]);
    logPoints(userId, item.cost_points, 'shop', `Remboursement ${item.name}`);
    if (item.stock > 0) dbRun('UPDATE shop_items SET stock=stock+1 WHERE id=?', [itemId]);
  };

  let result = null;

  // ── Code promo (Stripe si configuré, sinon local) ────────────────────────
  if (item.type === 'promo_code') {
    const tier     = extra.tier || 'bronze';
    const discount = extra.discount || 5;
    let code = randomCode(tier);
    if (stripe.isStripeConfigured()) {
      try {
        code = (await stripe.createPromoCode(discount, code, PROMO_VALIDITY_DAYS)).code;
      } catch (e) {
        console.warn('[Stripe] Génération code échouée, fallback local:', e.message);
      }
    }
    dbRun(`INSERT INTO promo_codes (code,user_id,discount,tier,expires_at) VALUES (?,?,?,?,datetime('now','+${PROMO_VALIDITY_DAYS} days'))`,
      [code, userId, discount, tier]);
    result = code;
  }

  // ── Rôle Discord ──────────────────────────────────────────────────────────
  if (item.type === 'discord_role') {
    const ok = await discord.assignRole(user.discord_id, roleId).catch(() => false);
    if (!ok) {
      refund();
      return { ok: false, message: 'Impossible d\'attribuer le rôle (points remboursés). Contacte un admin.' };
    }
    result = 'Rôle attribué sur Discord !';
  }

  // ── Produit physique / autre : traité manuellement par l'admin ─────────────
  const status = item.type === 'product' ? 'pending' : 'completed';
  if (item.type === 'product') result = 'Commande enregistrée — un admin va te contacter.';

  dbRun('INSERT INTO shop_orders (user_id,item_id,status,result) VALUES (?,?,?,?)', [userId, itemId, status, result]);
  // Le rang dépend des points cumulés : un achat ne fait pas perdre de palier.

  return { ok: true, message: '✅ Achat confirmé !', result, item: item.name, type: item.type };
}

module.exports = { getItems, purchase };
