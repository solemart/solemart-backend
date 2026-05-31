// ============================================================
//  label.js — Shipping label generation service
//
//  Royal Mail Click & Drop / ChannelShipper API integration.
//  Creates an order in Click & Drop and (for ChannelShipper/OBA
//  accounts) retrieves a prepaid postage label inline as base64 PDF.
//
//  Auth: set ROYAL_MAIL_API_KEY in the environment. The key is sent
//  in the Authorization header (no "Bearer" prefix, per RM docs).
//
//  If the key is absent, every function degrades gracefully to a
//  placeholder URL so the rest of the app keeps working in dev.
// ============================================================
const logger = require('../config/logger');

const RM_BASE = process.env.ROYAL_MAIL_API_BASE || 'https://api.parcel.royalmail.com/api/v1';
const RM_KEY  = process.env.ROYAL_MAIL_API_KEY || null;

// Kosmos receiving address — where donated/return shoes are sent.
const KOSMOS_ADDRESS = {
  fullName:     'Kosmos — Beautifully Ordered Ltd',
  addressLine1: 'Unit 4, CleanWorks Industrial',
  addressLine2: 'Bermondsey Street',
  city:         'London',
  postcode:     'SE1 3UB',
  countryCode:  'GB',
};

const placeholder = (reference) =>
  `${process.env.STORAGE_PUBLIC_URL || 'https://storage.beautifullyordered.co.uk'}/labels/${reference}.pdf`;

/**
 * Low-level: create one Click & Drop order and optionally pull a label.
 * Returns { orderIdentifier, trackingNumber, labelBase64, labelUrl, placeholder }.
 *
 * @param {object} opts
 * @param {string} opts.reference     - our order reference (becomes orderReference)
 * @param {object} opts.sender        - { fullName, addressLine1, addressLine2, city, postcode, countryCode, emailAddress, phoneNumber }
 * @param {object} opts.recipient     - same shape as sender
 * @param {number} opts.weightGrams   - total parcel weight in grams
 * @param {string} opts.serviceCode   - RM service code (optional; account default used if omitted)
 * @param {string} opts.description   - parcel contents description
 * @param {number} opts.subtotal      - declared value (£), optional
 */
async function createClickAndDropOrder({
  reference, sender, recipient, weightGrams,
  serviceCode, description, subtotal = 0,
}) {
  if (!RM_KEY) {
    logger.warn(`[label] ROYAL_MAIL_API_KEY not set — returning placeholder for ${reference}`);
    return { placeholder: true, labelUrl: placeholder(reference), orderIdentifier: null, trackingNumber: null };
  }

  const orderDate = new Date().toISOString();

  // Build the order payload per Click & Drop CreateOrderRequest schema.
  const order = {
    orderReference: reference,
    recipient: {
      address: {
        fullName:     recipient.fullName,
        addressLine1: recipient.addressLine1,
        addressLine2: recipient.addressLine2 || undefined,
        city:         recipient.city,
        postcode:     recipient.postcode,
        countryCode:  recipient.countryCode || 'GB',
      },
      phoneNumber:  recipient.phoneNumber || undefined,
      emailAddress: recipient.emailAddress || undefined,
    },
    sender: sender ? {
      address: {
        fullName:     sender.fullName,
        addressLine1: sender.addressLine1,
        addressLine2: sender.addressLine2 || undefined,
        city:         sender.city,
        postcode:     sender.postcode,
        countryCode:  sender.countryCode || 'GB',
      },
      phoneNumber:  sender.phoneNumber || undefined,
      emailAddress: sender.emailAddress || undefined,
    } : undefined,
    packages: [{
      weightInGrams: Math.max(1, Math.round(weightGrams || 1000)),
      packageFormatIdentifier: 'parcel',
      contents: description || 'Footwear',
    }],
    orderDate,
    subtotal: subtotal || 0,
    shippingCostCharged: 0,
    total: subtotal || 0,
    currencyCode: 'GBP',
    // Inline label generation. Across all items, total labels must not exceed 1
    // when requesting inline (per RM API constraint) — we only ever send 1 order.
    label: {
      includeLabelInResponse: true,
      includeCN: false,
      includeReturnsLabel: false,
    },
  };

  if (serviceCode) {
    order.postageDetails = { serviceCode };
  }

  const body = { items: [order] };

  const res = await fetch(`${RM_BASE}/orders`, {
    method: 'POST',
    headers: {
      'Authorization': RM_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error(`[label] Click & Drop create failed (${res.status}) for ${reference}: ${text}`);
    // Graceful fallback — order/label couldn't be made, but don't crash the flow.
    return { placeholder: true, labelUrl: placeholder(reference), orderIdentifier: null, trackingNumber: null, error: `RM ${res.status}` };
  }

  const json = await res.json();
  // CreateOrdersResponse: { createdOrders: [ { orderIdentifier, orderReference, trackingNumber, label, ... } ], failedOrders: [...] }
  const created = (json.createdOrders && json.createdOrders[0]) || null;
  const failed  = (json.failedOrders && json.failedOrders[0]) || null;

  if (!created) {
    logger.error(`[label] No created order for ${reference}: ${JSON.stringify(failed || json).slice(0, 500)}`);
    return { placeholder: true, labelUrl: placeholder(reference), orderIdentifier: null, trackingNumber: null, error: 'no_created_order' };
  }

  // The label may come back as base64 in created.label (string) on ChannelShipper/OBA accounts.
  const labelBase64 = typeof created.label === 'string'
    ? created.label
    : (created.label && created.label.base64 ? created.label.base64 : null);

  return {
    placeholder: false,
    orderIdentifier: created.orderIdentifier || null,
    trackingNumber: created.trackingNumber || null,
    labelBase64: labelBase64 || null,
    // If the account can't return a label inline (OLP), labelBase64 is null;
    // the order still exists in Click & Drop and RM will email the label.
    labelUrl: labelBase64 ? null : placeholder(reference),
  };
}

/**
 * Retrieve a label PDF for an existing order (ChannelShipper/OBA).
 * Returns base64 string or null.
 */
async function getOrderLabel(orderIdentifier) {
  if (!RM_KEY || !orderIdentifier) return null;
  try {
    const res = await fetch(
      `${RM_BASE}/orders/${orderIdentifier}/label?documentType=postageLabel&includeReturnsLabel=false`,
      { method: 'GET', headers: { 'Authorization': RM_KEY, 'Accept': 'application/pdf' } }
    );
    if (!res.ok) {
      logger.warn(`[label] getOrderLabel ${orderIdentifier} failed: ${res.status}`);
      return null;
    }
    const buf = await res.arrayBuffer();
    return Buffer.from(buf).toString('base64');
  } catch (e) {
    logger.warn(`[label] getOrderLabel error: ${e.message}`);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────
//  Public, domain-specific wrappers
// ──────────────────────────────────────────────────────────────────

/**
 * Listing/collection label for owner submissions.
 * Owner is the SENDER; Kosmos is the RECIPIENT.
 */
const generateListingLabel = async ({ reference, owner, shoes, collectionAddress, weightGrams }) => {
  logger.info(`[label] listing label for ${reference}`);
  const sender = collectionAddress ? {
    fullName:     owner?.name || 'Owner',
    addressLine1: collectionAddress.line1,
    addressLine2: collectionAddress.line2,
    city:         collectionAddress.city,
    postcode:     collectionAddress.postcode,
    countryCode:  'GB',
    emailAddress: owner?.email,
  } : null;

  const result = await createClickAndDropOrder({
    reference, sender, recipient: KOSMOS_ADDRESS,
    weightGrams: weightGrams || ((shoes?.length || 1) * 1000),
    description: 'Pre-owned footwear for listing',
  });
  return result.labelBase64 ? `data:application/pdf;base64,${result.labelBase64}` : result.labelUrl;
};

/**
 * Return label for clean bookings.
 * Kosmos is the SENDER; customer is the RECIPIENT (we ship cleaned shoes back).
 */
const generateCleanLabel = async ({ reference, contact, returnAddress, service, pairCount, total, weightGrams }) => {
  logger.info(`[label] clean return label for ${reference}`);
  const recipient = {
    fullName:     contact?.name || 'Customer',
    addressLine1: returnAddress?.line1,
    addressLine2: returnAddress?.line2,
    city:         returnAddress?.city,
    postcode:     returnAddress?.postcode,
    countryCode:  'GB',
    emailAddress: contact?.email,
    phoneNumber:  contact?.phone,
  };
  const result = await createClickAndDropOrder({
    reference, sender: KOSMOS_ADDRESS, recipient,
    weightGrams: weightGrams || ((pairCount || 1) * 1000),
    description: 'Cleaned footwear return',
  });
  return result.labelBase64 ? `data:application/pdf;base64,${result.labelBase64}` : result.labelUrl;
};

/**
 * Charity donation label.
 * Donor is the SENDER; Kosmos is the RECIPIENT (donor ships shoes to us).
 * Returns the full result object so callers can store tracking too.
 */
const generateDonationLabel = async ({ reference, donor, collectionAddress, pairCount, weightGrams }) => {
  logger.info(`[label] donation label for ${reference}`);
  const sender = {
    fullName:     donor?.name || 'Donor',
    addressLine1: collectionAddress?.line1 || 'Donor address on file',
    addressLine2: collectionAddress?.line2,
    city:         collectionAddress?.city || '',
    postcode:     collectionAddress?.postcode || '',
    countryCode:  'GB',
    emailAddress: donor?.email,
  };

  const result = await createClickAndDropOrder({
    reference,
    sender: collectionAddress ? sender : null, // post-yourself donors may not give an address
    recipient: KOSMOS_ADDRESS,
    weightGrams: weightGrams || ((pairCount || 1) * 1200),
    description: 'Donated footwear',
  });

  // Backward-compatible: callers currently expect a string. Return a data URL
  // when we have the label, else the placeholder URL. Tracking is attached as
  // a property for callers that want it (string objects can't carry props, so
  // we expose a parallel helper return via the .__tracking convention below).
  const url = result.labelBase64 ? `data:application/pdf;base64,${result.labelBase64}` : result.labelUrl;

  // Attach metadata in a way callers can optionally read.
  return Object.assign(new String(url), {
    labelUrl: url,
    trackingNumber: result.trackingNumber || null,
    orderIdentifier: result.orderIdentifier || null,
    isPlaceholder: !!result.placeholder,
  });
};

module.exports = {
  generateListingLabel,
  generateCleanLabel,
  generateDonationLabel,
  createClickAndDropOrder,
  getOrderLabel,
  KOSMOS_ADDRESS,
};
