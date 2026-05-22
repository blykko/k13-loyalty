'use strict';
/**
 * Stripe Promotion Codes
 * Génère automatiquement un code promo dans Stripe et le retourne.
 *
 * Prérequis dans .env :
 *   STRIPE_SECRET_KEY=sk_live_...   (ou sk_test_... pour les tests)
 *   STRIPE_COUPON_5=coupon_id_5pct   <- ID des coupons créés dans Stripe Dashboard
 *   STRIPE_COUPON_10=coupon_id_10pct
 *   STRIPE_COUPON_20=coupon_id_20pct
 *
 * Comment créer les coupons dans Stripe :
 *   Dashboard → Produits → Coupons → Créer un coupon
 *   Ex : "K13-5PCT", 5% de réduction, durée = once
 *   Copie l'ID du coupon (cus_xxx ou "K13-5PCT") dans .env
 */
const fetch = require('node-fetch');

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const COUPON_IDS = {
  5:  process.env.STRIPE_COUPON_5,
  10: process.env.STRIPE_COUPON_10,
  20: process.env.STRIPE_COUPON_20,
};

async function stripeRequest(method, path, body) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${STRIPE_KEY}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Stripe error ' + res.status);
  return data;
}

/**
 * Génère un code promo Stripe pour un discount donné.
 * @param {number} discountPct - 5, 10 ou 20
 * @param {string} customCode  - Le code affiché (ex: K13-GOLD-ABCDEF)
 * @param {number} expiresInDays - Validité en jours (défaut 30)
 */
async function createPromoCode(discountPct, customCode, expiresInDays = 7) {
  if (!STRIPE_KEY) throw new Error('STRIPE_SECRET_KEY non configuré dans .env');
  const couponId = COUPON_IDS[discountPct];
  if (!couponId) throw new Error(`STRIPE_COUPON_${discountPct} non configuré dans .env`);

  // 7 jours par défaut, 1 utilisation max
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInDays * 86400;

  const promo = await stripeRequest('POST', '/promotion_codes', {
    coupon:         couponId,
    code:           customCode,       // Code lisible par l'utilisateur
    max_redemptions: '1',             // 1 seule utilisation
    expires_at:     String(expiresAt),
  });

  return {
    stripeId: promo.id,
    code:     promo.code,
    url:      `https://dashboard.stripe.com/promotion_codes/${promo.id}`,
  };
}

/**
 * Vérifie si Stripe est configuré
 */
function isStripeConfigured() {
  return !!(STRIPE_KEY && (COUPON_IDS[5] || COUPON_IDS[10] || COUPON_IDS[20]));
}

module.exports = { createPromoCode, isStripeConfigured };
