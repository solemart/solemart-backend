// services/settings.js — Platform settings with caching
const db = require('../config/db');

let cache = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minute

async function getSettings(force = false) {
  if (!force && cache && Date.now() < cacheExpiry) return cache;
  const { rows } = await db.query(`SELECT key, value FROM platform_settings`);
  cache = {};
  for (const row of rows) {
    cache[row.key] = row.value;
  }
  cacheExpiry = Date.now() + CACHE_TTL_MS;
  return cache;
}

async function getSetting(key, fallback = null) {
  const settings = await getSettings();
  return settings[key] !== undefined ? settings[key] : fallback;
}

function invalidateCache() {
  cache = null;
  cacheExpiry = 0;
}

// Helpers for typed access
async function getPlatformFeePercent()     { return parseFloat(await getSetting('platform_fee_percent', 15)); }
async function getCleaningFeeAmount()      { return parseFloat(await getSetting('cleaning_fee_amount', 8)); }
async function getOwnerSharePercent()      { return parseFloat(await getSetting('owner_share_percent', 85)); }
async function getTreasuresMaxPrice()      { return parseFloat(await getSetting('treasures_max_price', 80)); }
async function getLateFeeCapMultiplier()   { return parseFloat(await getSetting('late_fee_cap_multiplier', 1.0)); }
async function getMinRentalDays()          { return parseInt(await getSetting('min_rental_days', 7)); }
async function getMaxRentalDays()          { return parseInt(await getSetting('max_rental_days', 28)); }
async function getRentalDefaultDays()      { return parseInt(await getSetting('rental_default_days', 7)); }
async function getLateFeeGraceHours()      { return parseInt(await getSetting('late_fee_grace_hours', 0)); }
async function getDeliveryFeeAmount()      { return parseFloat(await getSetting('delivery_fee_amount', 4.99)); }
async function getFreeDeliveryThreshold()  { return parseFloat(await getSetting('free_delivery_threshold', 50)); }
// Listing prepaid-label settings
async function getListingLabelFee()        { return parseFloat(await getSetting('listing_label_fee', 4.99)); }
// How owners pay for a prepaid listing label: 'payout_deduction' (default) or 'upfront'
async function getListingLabelChargeMethod() { return await getSetting('listing_label_charge_method', 'payout_deduction'); }

// Calculate delivery fee for an order subtotal
async function calculateDeliveryFee(subtotal) {
  const threshold = await getFreeDeliveryThreshold();
  if (parseFloat(subtotal) >= threshold) return 0;
  return await getDeliveryFeeAmount();
}

module.exports = {
  getSettings, getSetting, invalidateCache,
  getPlatformFeePercent, getCleaningFeeAmount, getOwnerSharePercent,
  getTreasuresMaxPrice, getLateFeeCapMultiplier,
  getMinRentalDays, getMaxRentalDays, getRentalDefaultDays, getLateFeeGraceHours,
  getDeliveryFeeAmount, getFreeDeliveryThreshold, calculateDeliveryFee,
  getListingLabelFee, getListingLabelChargeMethod,
};
