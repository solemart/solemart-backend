const logger = require('../config/logger');

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  logger.error({
    message: err.message,
    stack:   err.stack,
    path:    req.path,
    method:  req.method,
  });

  // Validation errors from express-validator
  if (err.type === 'validation') {
    return res.status(422).json({ error: 'Validation failed', details: err.details });
  }

  // PostgreSQL unique constraint violation
  if (err.code === '23505') {
    const field = err.detail?.match(/Key \((.+)\)/)?.[1] || 'field';
    return res.status(409).json({ error: `${field} already exists` });
  }

  // PostgreSQL foreign key violation
  if (err.code === '23503') {
    return res.status(400).json({ error: 'Referenced record does not exist' });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Multer file size error
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Maximum size is 10MB.' });
  }

  const status = err.status || err.statusCode || 500;
  const message = status < 500 ? err.message : 'An unexpected error occurred';

  res.status(status).json({ error: message });
};

module.exports = errorHandler;
