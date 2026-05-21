const { Resend } = require('resend');
const logger = require('../config/logger');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Fallback to SMTP if Resend not configured
const nodemailer = require('nodemailer');
const smtpTransporter = process.env.SMTP_HOST ? nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}) : null;

const FROM = process.env.EMAIL_FROM || 'Kosmos <hello@beautifullyordered.co.uk>';

const send = async (to, subject, html) => {
  try {
    if (resend) {
      await resend.emails.send({ from: FROM, to, subject, html });
      logger.info(`Email sent via Resend to ${to}: ${subject}`);
    } else if (smtpTransporter) {
      await smtpTransporter.sendMail({ from: FROM, to, subject, html });
      logger.info(`Email sent via SMTP to ${to}: ${subject}`);
    } else {
      logger.warn(`No email provider configured — skipping email to ${to}: ${subject}`);
    }
  } catch (err) {
    logger.error(`Email failed to ${to}: ${err.message}`);
    // Don't throw — allow API to continue even if email fails
  }
};

// Backwards compat alias
const sendEmail = send;

// ── Shared styles ─────────────────────────────────────────────
const baseStyle = `
  font-family: 'Georgia', serif; background: #faf8f5; padding: 40px 0; color: #0f0e0c;
`;
const card = (content) => `
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e8e4dd;border-radius:10px;overflow:hidden">
    <div style="background:#0f0e0c;padding:28px 32px;text-align:center">
      <div style="font-family:Georgia,serif;font-size:32px;color:#faf8f5;font-weight:300">Kosmos</div>
      <div style="font-size:10px;letter-spacing:2.5px;text-transform:uppercase;color:#b89a5a;margin-top:4px">Beautifully Ordered</div>
    </div>
    <div style="padding:36px 32px">${content}</div>
    <div style="background:#f4efe7;padding:18px 32px;font-size:11px;color:#7a7468;text-align:center;border-top:1px solid #e8e4dd">
      Beautifully Ordered Ltd<br/>
      <a href="https://beautifullyordered.co.uk" style="color:#b89a5a">beautifullyordered.co.uk</a>
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

// ── PASSWORD RESET ────────────────────────────────────────────────────────────
const sendPasswordResetEmail = (to, firstName, code) => sendEmail(
  to,
  `Your Kosmos password reset code is ${code}`,
  `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:40px 20px;background:#faf8f5">
    <div style="text-align:center;margin-bottom:32px">
      <h1 style="font-family:Georgia,serif;font-size:32px;color:#0f0e0c;font-weight:300;margin:0">Kosmos</h1>
      <p style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#b89a5a;margin-top:4px">Beautifully Ordered</p>
    </div>
    <div style="background:#fff;border:1px solid #e8e4dd;border-radius:10px;padding:32px;text-align:center">
      <h2 style="font-family:Georgia,serif;font-size:24px;color:#0f0e0c;font-weight:300;margin:0 0 16px">Reset your password</h2>
      <p style="color:#7a7468;font-size:14px;line-height:1.6;margin-bottom:24px">Hi ${firstName || 'there'},<br/>Enter this code in the Kosmos app to set a new password. It expires in 30 minutes.</p>
      <div style="background:#f4efe7;border:1px solid #d9d3c7;border-radius:10px;padding:24px;margin:24px 0">
        <div style="font-family:'Courier New',monospace;font-size:36px;letter-spacing:8px;color:#0f0e0c;font-weight:700">${code}</div>
      </div>
      <p style="color:#a39d8e;font-size:12px;line-height:1.6">Didn't request this? You can safely ignore this email — your password won't change.</p>
    </div>
    <p style="color:#a39d8e;font-size:11px;text-align:center;margin-top:24px">Need help? Reply to this email or contact support@beautifullyordered.co.uk</p>
  </div>`
);

// ── NEWSLETTER WELCOME ────────────────────────────────────────────────────────
const sendNewsletterWelcome = (to) => sendEmail(
  to,
  `Welcome to the Kosmos list ✨`,
  `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:40px 20px;background:#faf8f5">
    <div style="text-align:center;margin-bottom:32px">
      <h1 style="font-family:Georgia,serif;font-size:36px;color:#0f0e0c;font-weight:300;margin:0">Kosmos</h1>
      <p style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#b89a5a;margin-top:4px">Beautifully Ordered</p>
    </div>
    <div style="background:#fff;border:1px solid #e8e4dd;border-radius:10px;padding:32px;text-align:center">
      <div style="font-size:48px;margin-bottom:12px">✨</div>
      <h2 style="font-family:Georgia,serif;font-size:24px;color:#0f0e0c;font-weight:300;margin:0 0 16px">You're on the list</h2>
      <p style="color:#7a7468;font-size:14px;line-height:1.6;margin-bottom:24px">Thanks for joining the Kosmos community. You'll be among the first to hear about new arrivals, exclusive drops and early access to special collections.</p>
      <a href="https://beautifullyordered.co.uk" style="display:inline-block;background:#0f0e0c;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-size:13px;font-weight:700;letter-spacing:0.5px">Browse the Edit →</a>
    </div>
    <p style="color:#a39d8e;font-size:11px;text-align:center;margin-top:24px">No spam — just thoughtfully curated updates. <a href="https://beautifullyordered.co.uk/?unsub=${encodeURIComponent(to)}" style="color:#b89a5a">Unsubscribe anytime</a></p>
  </div>`
);

// ── LATE FEE CHARGED ──────────────────────────────────────────────────────────
const sendLateFeeChargedEmail = (to, firstName, details) => sendEmail(
  to,
  `Late return fee charged — £${details.amount.toFixed(2)}`,
  card(`
    <div style="text-align:center;margin-bottom:24px">
      <div style="font-size:32px;margin-bottom:8px">⏰</div>
      <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:300;margin:0">Late Return Fee</h2>
    </div>
    <p style="color:#7a7468;font-size:14px;line-height:1.6">Hi ${firstName || 'there'},</p>
    <p style="color:#7a7468;font-size:14px;line-height:1.6">Your rental of <strong style="color:#0f0e0c">${details.brand} ${details.model}</strong> (${details.reference}) is currently ${details.days} day(s) past its return date.</p>
    <p style="color:#7a7468;font-size:14px;line-height:1.6">In line with our terms, we've charged your card on file for the additional rental days.</p>
    <div style="background:#fdf8e8;border:1px solid #d9c890;border-radius:10px;padding:18px;margin:18px 0;text-align:center">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#a07010;font-weight:600;margin-bottom:6px">Amount Charged</div>
      <div style="font-family:Georgia,serif;font-size:32px;color:#0f0e0c;font-weight:300">£${details.amount.toFixed(2)}</div>
      <div style="font-size:12px;color:#7a7468;margin-top:4px">${details.days} day${details.days !== 1 ? 's' : ''} × daily rental rate</div>
    </div>
    <p style="color:#7a7468;font-size:13px;line-height:1.6">Please return the shoes as soon as possible to stop further charges. Daily charges will continue until the rental is returned, up to the replacement value of the shoes.</p>
    <p style="color:#7a7468;font-size:12px;line-height:1.6;margin-top:24px">Questions? Reply to this email or contact <a href="mailto:support@beautifullyordered.co.uk" style="color:#b89a5a">support@beautifullyordered.co.uk</a></p>
  `)
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
  sendPasswordResetEmail,
  sendNewsletterWelcome,
  sendLateFeeChargedEmail,
};
