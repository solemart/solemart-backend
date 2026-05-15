const nodemailer = require('nodemailer');
const logger     = require('../config/logger');

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const FROM = process.env.EMAIL_FROM || 'Kosmos <hello@kosmos.co.uk>';

const send = async (to, subject, html) => {
  try {
    await transporter.sendMail({ from: FROM, to, subject, html });
    logger.info(`Email sent to ${to}: ${subject}`);
  } catch (err) {
    logger.error(`Email failed to ${to}: ${err.message}`);
    throw err;
  }
};

// ── Shared styles ─────────────────────────────────────────────
const baseStyle = `
  font-family: 'Georgia', serif; background: #f7f5f2; padding: 40px 0; color: #1a1714;
`;
const card = (content) => `
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e4e0da;border-radius:6px;overflow:hidden">
    <div style="background:#0f0e0c;padding:24px 32px;text-align:center">
      <span style="font-size:24px;letter-spacing:4px;text-transform:uppercase;color:#f7f5f2">Sole<span style="color:#b89a5a">Mart</span></span>
    </div>
    <div style="padding:36px 32px">${content}</div>
    <div style="background:#f3f0eb;padding:18px 32px;font-size:11px;color:#7a7369;text-align:center;border-top:1px solid #e4e0da">
      Kosmos Ltd · Unit 4, CleanWorks Industrial, Bermondsey St, London SE1 3UB<br/>
      <a href="https://kosmos.co.uk" style="color:#b89a5a">kosmos.co.uk</a>
    </div>
  </div>`;

const h1 = (text) => `<h1 style="font-size:26px;font-weight:400;margin:0 0 8px">${text}</h1>`;
const p  = (text) => `<p style="font-size:14px;line-height:1.7;color:#6b6760;margin:12px 0">${text}</p>`;
const btn = (text, url) =>
  `<a href="${url}" style="display:inline-block;background:#b89a5a;color:#fff;padding:12px 28px;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;text-decoration:none;border-radius:4px;margin-top:20px">${text}</a>`;
const ref = (text) =>
  `<div style="background:#f3f0eb;border:1px solid #e4e0da;border-radius:4px;padding:14px 18px;margin:18px 0;font-family:monospace;font-size:16px;letter-spacing:3px;text-align:center">${text}</div>`;

// ── Templates ─────────────────────────────────────────────────

const sendWelcome = (user) => send(
  user.email,
  'Welcome to Kosmos',
  `<div style="${baseStyle}">${card(`
    ${h1(`Welcome, ${user.first_name}.`)}
    ${p('Your Kosmos account is all set. Browse the collection, list your shoes, or book a professional clean — all from one place.')}
    ${btn('Browse the Collection', 'https://kosmos.co.uk')}
  `)}</div>`
);

const sendOrderConfirmation = (user, order, shoe) => send(
  user.email,
  `Order confirmed — ${shoe.brand} ${shoe.model}`,
  `<div style="${baseStyle}">${card(`
    ${h1('Order Confirmed')}
    ${p(`Thanks ${user.first_name}, your ${order.order_type === 'rent' ? `${order.rental_days}-day rental` : 'purchase'} is confirmed. We'll clean the shoes and dispatch within 1–2 business days.`)}
    ${ref(order.reference)}
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin:18px 0">
      <tr><td style="padding:8px 0;color:#7a7369;border-bottom:1px solid #e4e0da">Shoe</td><td style="padding:8px 0;border-bottom:1px solid #e4e0da;text-align:right">${shoe.emoji} ${shoe.brand} ${shoe.model}</td></tr>
      <tr><td style="padding:8px 0;color:#7a7369;border-bottom:1px solid #e4e0da">Size</td><td style="padding:8px 0;border-bottom:1px solid #e4e0da;text-align:right">UK ${shoe.size}</td></tr>
      <tr><td style="padding:8px 0;color:#7a7369;border-bottom:1px solid #e4e0da">Type</td><td style="padding:8px 0;border-bottom:1px solid #e4e0da;text-align:right">${order.order_type === 'rent' ? `Rental · ${order.rental_days} days` : 'Purchase'}</td></tr>
      <tr><td style="padding:8px 0;font-weight:600">Total</td><td style="padding:8px 0;text-align:right;font-weight:600;color:#b89a5a">£${order.total}</td></tr>
    </table>
    ${btn('View Order', `https://kosmos.co.uk/account`)}
  `)}</div>`
);

const sendOrderDispatched = (user, order) => send(
  user.email,
  `Your shoes are on their way — ${order.reference}`,
  `<div style="${baseStyle}">${card(`
    ${h1('On Their Way 👟')}
    ${p(`Great news, ${user.first_name} — your order has been dispatched and is on its way to you.`)}
    ${ref(order.reference)}
    ${order.tracking_number ? p(`<strong>Tracking:</strong> ${order.tracking_number}`) : ''}
    ${order.return_label_url && order.order_type === 'rent' ? p('Your <strong>return label</strong> is attached — keep it safe for when your rental ends.') : ''}
    ${btn('View Order', `https://kosmos.co.uk/account`)}
  `)}</div>`
);

const sendReturnInitiated = (user, order) => send(
  user.email,
  `Return initiated — ${order.reference}`,
  `<div style="${baseStyle}">${card(`
    ${h1('Return Initiated')}
    ${p(`Hi ${user.first_name}, we've received your return request. Please use the prepaid label included with your delivery to send the shoes back to us.`)}
    ${ref(order.reference)}
    ${p('Once we receive and inspect the shoes, your rental will be marked as complete within 1 business day.')}
  `)}</div>`
);

const sendSubmissionConfirmation = (user, submission, shoes, labelUrl) => send(
  user.email,
  `Submission received — ${submission.reference}`,
  `<div style="${baseStyle}">${card(`
    ${h1('We\'ve Got Your Submission')}
    ${p(`Thanks ${user.first_name}! We've received your listing submission for ${shoes.length} pair${shoes.length !== 1 ? 's' : ''}. Your collection label is attached to this email.`)}
    ${ref(submission.reference)}
    ${p(`<strong>What happens next:</strong> Print the label, pack your shoes securely, and drop the parcel at any Royal Mail point. Once we receive them, our team will authenticate and clean each pair within 3–5 business days.`)}
    ${p('You\'ll earn 85% of every successful transaction. The £3.99 collection fee will be deducted from your first payout.')}
    ${labelUrl ? `<p style="font-size:13px;margin-top:16px"><a href="${labelUrl}" style="color:#b89a5a">Download label →</a></p>` : ''}
  `)}</div>`
);

const sendShoeListed = (user, shoe) => send(
  user.email,
  `Your ${shoe.brand} ${shoe.model} is now live`,
  `<div style="${baseStyle}">${card(`
    ${h1(`${shoe.emoji} Now Listed`)}
    ${p(`Great news, ${user.first_name}! Your <strong>${shoe.brand} ${shoe.model}</strong> (UK ${shoe.size}) has passed authentication and is now live on the platform.`)}
    <div style="background:#f3f0eb;border:1px solid #e4e0da;border-radius:4px;padding:16px;margin:18px 0;font-size:13px">
      <div style="margin-bottom:4px;color:#7a7369">Auth Grade</div>
      <div style="font-size:20px;font-weight:600">${shoe.auth_grade}</div>
    </div>
    ${p(`You'll be notified and paid within 7 days of each completed rental or sale. You earn 85% of every transaction.`)}
    ${btn('View My Listings', 'https://kosmos.co.uk/account')}
  `)}</div>`
);

const sendShoeRejected = (user, shoe) => send(
  user.email,
  `Update on your ${shoe.brand} ${shoe.model}`,
  `<div style="${baseStyle}">${card(`
    ${h1('Submission Update')}
    ${p(`Hi ${user.first_name}, unfortunately your <strong>${shoe.brand} ${shoe.model}</strong> did not pass our authentication process and cannot be listed on the platform at this time.`)}
    <div style="background:#fdf0f0;border:1px solid rgba(140,32,32,.2);border-radius:4px;padding:16px;margin:18px 0;font-size:13px;color:#8c2020">
      <strong>Reason:</strong> ${shoe.rejection_reason}
    </div>
    ${p('We will return your shoes to your collection address within 5 business days. If you have any questions, please don\'t hesitate to get in touch.')}
    ${btn('Contact Us', 'https://kosmos.co.uk/contact')}
  `)}</div>`
);

const sendCleanBookingConfirmation = (contact, booking, labelUrl) => send(
  contact.email,
  `Clean booking confirmed — ${booking.reference}`,
  `<div style="${baseStyle}">${card(`
    ${h1('Booking Confirmed 🧹')}
    ${p(`Hi ${contact.name}, your ${booking.service_name} booking is confirmed. Your shipping label is attached — print it, attach it to your parcel, and drop it at any Royal Mail point.`)}
    ${ref(booking.reference)}
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin:18px 0">
      <tr><td style="padding:8px 0;color:#7a7369;border-bottom:1px solid #e4e0da">Service</td><td style="padding:8px 0;border-bottom:1px solid #e4e0da;text-align:right">${booking.service_name}</td></tr>
      <tr><td style="padding:8px 0;color:#7a7369;border-bottom:1px solid #e4e0da">Pairs</td><td style="padding:8px 0;border-bottom:1px solid #e4e0da;text-align:right">${booking.pair_count}</td></tr>
      <tr><td style="padding:8px 0;font-weight:600">Total</td><td style="padding:8px 0;text-align:right;font-weight:600;color:#b89a5a">£${booking.total_price}</td></tr>
    </table>
    ${labelUrl ? `<p style="font-size:13px"><a href="${labelUrl}" style="color:#b89a5a">Download label →</a></p>` : ''}
  `)}</div>`
);

const sendDonationConfirmation = (donor, donation, labelUrl) => send(
  donor.email,
  `Donation confirmed — ${donation.reference}`,
  `<div style="${baseStyle}">${card(`
    ${h1('Thank You for Donating 💚')}
    ${p(`Hi ${donor.name}, your shoe donation has been confirmed. We'll collect from your address and every penny of profit will go directly to <strong>${donation.charity_name}</strong>.`)}
    ${ref(donation.reference)}
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin:18px 0">
      <tr><td style="padding:8px 0;color:#7a7369;border-bottom:1px solid #e4e0da">Shoes</td><td style="padding:8px 0;border-bottom:1px solid #e4e0da;text-align:right">${donation.shoe_description}</td></tr>
      <tr><td style="padding:8px 0;color:#7a7369;border-bottom:1px solid #e4e0da">Pairs</td><td style="padding:8px 0;border-bottom:1px solid #e4e0da;text-align:right">${donation.pair_count}</td></tr>
      <tr><td style="padding:8px 0;color:#7a7369;border-bottom:1px solid #e4e0da">Charity</td><td style="padding:8px 0;border-bottom:1px solid #e4e0da;text-align:right;color:#1a7a4a;font-weight:600">${donation.charity_name}</td></tr>
      <tr><td style="padding:8px 0;font-weight:600">Collection Fee</td><td style="padding:8px 0;text-align:right;font-weight:600">£${donation.collection_fee}</td></tr>
    </table>
    <div style="background:#eaf5f0;border:1px solid #a8d9bf;border-radius:4px;padding:14px;font-size:13px;color:#1a7a4a;margin:16px 0">
      💚 100% of all rental income and sale proceeds go directly to ${donation.charity_name} (Registered Charity No. ${donation.charity_number}). We publish quarterly impact reports at kosmos.co.uk/charity.
    </div>
    ${labelUrl ? `<p style="font-size:13px;margin-top:16px"><a href="${labelUrl}" style="color:#b89a5a">Download your collection label →</a></p>` : ''}
  `)}</div>`
);

module.exports = {
  sendWelcome,
  sendOrderConfirmation,
  sendOrderDispatched,
  sendReturnInitiated,
  sendSubmissionConfirmation,
  sendShoeListed,
  sendShoeRejected,
  sendCleanBookingConfirmation,
  sendDonationConfirmation,
};
