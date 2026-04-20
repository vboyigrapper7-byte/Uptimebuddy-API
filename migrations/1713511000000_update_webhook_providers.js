exports.up = (pgm) => {
  pgm.sql(`
    -- 1. Drop the existing check constraint
    -- Note: node-pg-migrate handles the naming of implicit check constraints 
    -- but usually it is webhooks_provider_check
    ALTER TABLE webhooks DROP CONSTRAINT IF EXISTS webhooks_provider_check;

    -- 2. Add the updated check constraint including 'email'
    ALTER TABLE webhooks ADD CONSTRAINT webhooks_provider_check 
    CHECK (provider IN ('slack', 'discord', 'telegram', 'email'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE webhooks DROP CONSTRAINT IF EXISTS webhooks_provider_check;
    ALTER TABLE webhooks ADD CONSTRAINT webhooks_provider_check 
    CHECK (provider IN ('slack', 'discord', 'telegram'));
  `);
};
