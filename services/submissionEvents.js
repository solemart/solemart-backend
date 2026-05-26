// services/submissionEvents.js — Log every action on a submission/shoe
const db = require('../config/db');
const logger = require('../config/logger');

async function logEvent({ shoeId, eventType, statusBefore, statusAfter, actorId, actorRole, notes, meta }) {
  try {
    await db.query(
      `INSERT INTO submission_events
        (shoe_id, event_type, status_before, status_after, actor_id, actor_role, notes, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [shoeId, eventType, statusBefore || null, statusAfter || null, actorId || null,
       actorRole || 'kosmos', notes || null, meta ? JSON.stringify(meta) : null]
    );
  } catch (e) {
    logger.warn('Submission event log failed:', e.message);
  }
}

async function getTimeline(shoeId) {
  const { rows } = await db.query(
    `SELECT se.*, u.first_name, u.last_name
     FROM submission_events se
     LEFT JOIN users u ON u.id = se.actor_id
     WHERE se.shoe_id = $1
     ORDER BY se.created_at ASC`,
    [shoeId]
  );
  return rows.map(r => ({
    ...r,
    actor_name: r.first_name ? `${r.first_name} ${r.last_name || ''}`.trim() : (r.actor_role === 'owner' ? 'You' : 'Kosmos'),
  }));
}

module.exports = { logEvent, getTimeline };
