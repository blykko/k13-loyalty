'use strict';
const { dbGet, dbRun, dbAll } = require('../models/db');
const discord = require('./discord');
const stripe  = require('./stripe');

function getItems() {
  return dbAll('SELECT * FROM shop_items WHERE active=1 ORDER BY cost_points');
}

async function purchase(userId, itemId) {
  const user = dbGet('SELECT * FROM users WHERE id=?', [userId]);
  const item = dbGet('SELECT * FROM shop_items WHERE id=? AND active=1', [itemId]);
  if (!item) return { ok: false, message: 'Article introuvable.' };
  if (user.points < item.cost_points)
    return { ok: false, message: `Il te faut ${item.cost_points} pts. Tu en as ${user.points}.` };
  if (item.stock === 0) return { ok: false, message: 'Stock épuisé.' };

  // Débite les points
  dbRun('UPDATE users SET points=points-? WHERE id=?', [item.cost_points, userId]);

  const extra = JSON.parse(item.extra || '{}');
  let result = null;

  // ── Code promo (Stripe si configuré, sinon local) ────────────────────────
  if (item.type === 'promo_code') {
    const chars   = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const suffix  = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const tier    = extra.tier || 'bronze';
    const discount= extra.discount || 5;
    const code    = `K13-${tier.toUpperCase()}-${suffix}`;

    if (stripe.isStripeConfigured()) {
      try {
        const stripePromo = await stripe.createPromoCode(discount, code, 30);
        result = stripePromo.code; // Normalement = code, mais Stripe peut ajouter un suffix si doublon
      } catch (e) {
        console.warn('[Stripe] Génération code échouée, fallback local:', e.message);
        result = code; // Fallback : code local sans Stripe
      }
    } else {
      result = code;
    }

    dbRun(`INSERT INTO promo_codes (code,user_id,discount,tier,expires_at) VALUES (?,?,?,?,datetime('now','+7 days'))`,
      [result, userId, discount, tier]);
  }

  // ── Rôle Discord ──────────────────────────────────────────────────────────
  if (item.type === 'discord_role') {
    const roleId = extra.role_id || process.env[extra.role_env] || '';
    if (user.discord_id && roleId) {
      const ok = await discord.assignRole(user.discord_id, roleId);
      result = ok ? 'Rôle attribué sur Discord !' : 'Erreur attribution rôle (contacte un admin)';
    } else {
      result = 'Connecte ton Discord pour recevoir le rôle.';
    }
  }

  // Stock infini = -1
  if (item.stock > 0) dbRun('UPDATE shop_items SET stock=stock-1 WHERE id=?', [itemId]);

  const orderId = dbRun('INSERT INTO shop_orders (user_id,item_id,status,result) VALUES (?,?,?,?)',
    [userId, itemId, 'completed', result]).lastInsertRowid;

  // Recalcul du rang
  const { updateRank } = require('./challenges');
  updateRank(userId);

  return { ok: true, message: `✅ Achat confirmé !`, result, item: item.name };
}

module.exports = { getItems, purchase };
