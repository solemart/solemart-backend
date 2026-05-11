const db     = require('../config/db');
const logger = require('../config/logger');

/**
 * Write an entry to the activity_log table.
 * Non-blocking — errors are logged but don't crash the request.
 *
 * @param {string|null} actorId    - UUID of the user performing the action (null for system/webhooks)
 * @param {string}      action     - e.g. 'shoe.listed', 'order.dispatched'
 * @param {string}      entityType - e.g. 'shoe', 'order', 'user'
 * @param {string}      entityId   - UUID of the affected entity
 * @param {object}      meta       - any extra context (stored as JSONB)
 */
const logActivity = async (actorId, action, entityType, entityId, meta = {}) => {
  try {
    await db.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
       VALUES ($1, $2, $3, $4, $5)`,
      [actorId || null, action, entityType || null, entityId || null, JSON.stringify(meta)]
    );
  } catch (err) {
    logger.error(`Failed to log activity [${action}]: ${err.message}`);
    // Never throw — logging should not break the main request
  }
};

module.exports = { logActivity };
