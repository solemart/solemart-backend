// ============================================================
//  label.js — Shipping label generation service
//  In production: generate a real PDF using pdfkit or html-pdf,
//  upload to S3/R2, and return the signed URL.
//  For now: returns a placeholder URL pattern.
// ============================================================
const { v4: uuid } = require('uuid');
const logger = require('../config/logger');

/**
 * Generate a listing/collection label for owner submissions.
 * @returns {string} URL of the generated label (PDF)
 */
const generateListingLabel = async ({ reference, owner, shoes, collectionAddress }) => {
  // TODO: integrate with pdfkit or Puppeteer to render a real PDF,
  // upload to Cloudflare R2/S3, and return the public URL.
  // For now we return a deterministic placeholder URL.
  logger.info(`Generating listing label for ${reference}`);
  return `${process.env.STORAGE_PUBLIC_URL}/labels/${reference}.pdf`;
};

/**
 * Generate a return label for clean bookings.
 * @returns {string} URL of the generated label (PDF)
 */
const generateCleanLabel = async ({ reference, contact, returnAddress, service, pairCount, total }) => {
  logger.info(`Generating clean label for ${reference}`);
  return `${process.env.STORAGE_PUBLIC_URL}/labels/${reference}.pdf`;
};

/**
 * Generate a charity donation collection label.
 */
const generateDonationLabel = async ({ reference, donor, collectionAddress, pairCount }) => {
  logger.info(`Generating donation label for ${reference}`);
  return `${process.env.STORAGE_PUBLIC_URL}/labels/${reference}.pdf`;
};

module.exports = { generateListingLabel, generateCleanLabel, generateDonationLabel };


// ============================================================
//  activityLog.js — Audit trail helper
// ============================================================
