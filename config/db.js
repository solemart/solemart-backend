const { Pool } = require('pg');

// ── Database connection ──────────────────────────────────────────────
// All traffic to Postgres is encrypted in transit via TLS in production.
//
// If a CA certificate is supplied (DATABASE_CA_CERT — the managed provider's
// root cert, PEM, newlines as \n), we VERIFY the server certificate, giving
// full protection against man-in-the-middle attacks. If no CA cert is set we
// still encrypt the connection but skip verification (Railway/Heroku-style
// self-signed certs). Setting the CA cert is the recommended hardening step.
function buildSsl() {
  if (process.env.NODE_ENV !== 'production') return false; // local dev: no SSL
  const ca = process.env.DATABASE_CA_CERT;
  if (ca) {
    return {
      ca: ca.replace(/\\n/g, '\n'),
      rejectUnauthorized: true,   // verify the server is who it claims to be
    };
  }
  // Encrypted but unverified — acceptable for managed self-signed certs.
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: buildSsl(),
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
  process.exit(-1);
});

/**
 * Run a query against the pool.
 * @param {string} text  - SQL query
 * @param {Array}  params - Parameterised values
 */
const query = (text, params) => pool.query(text, params);

/**
 * Get a client from the pool for transactions.
 * Always call client.release() in a finally block.
 */
const getClient = () => pool.connect();

module.exports = { query, getClient, pool };
