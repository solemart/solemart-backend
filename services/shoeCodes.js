// services/shoeCodes.js — Generate unique shoe codes
const db = require('../config/db');

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing 0/O/1/I

function makeRandomSuffix() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CHARS[Math.floor(Math.random() * CHARS.length)];
  return s;
}

function formatBrand(brand) {
  return (brand || 'KSM').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'KSM';
}

async function generateUniqueShoeCode(brand) {
  const brandCode = formatBrand(brand);
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = `KSM-${brandCode}-${makeRandomSuffix()}`;
    const { rows } = await db.query(`SELECT 1 FROM shoes WHERE shoe_code = $1 LIMIT 1`, [code]);
    if (!rows.length) return code;
  }
  // Fallback — append timestamp suffix
  return `KSM-${brandCode}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

module.exports = { generateUniqueShoeCode, formatBrand };
