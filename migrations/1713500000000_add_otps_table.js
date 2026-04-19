/**
 * Migration: Create OTPS table for verification codes
 */

exports.shorthands = undefined;

exports.up = pgm => {
  pgm.createTable('otps', {
    email: { type: 'varchar(255)', notNull: true, primaryKey: true },
    otp: { type: 'varchar(6)', notNull: true },
    hashed_password: { type: 'text', notNull: true },
    expires_at: { type: 'timestamp', notNull: true },
    attempts: { type: 'integer', default: 0, notNull: true },
    last_sent_at: { type: 'timestamp', default: pgm.func('current_timestamp'), notNull: true }
  });

  pgm.createIndex('otps', 'expires_at');
};

exports.down = pgm => {
  pgm.dropTable('otps');
};
