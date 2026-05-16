exports.up = (pgm) => {
  pgm.addColumns('monitors', {
    ssl_expiry: { type: 'timestamp', allowNull: true },
    domain_expiry: { type: 'timestamp', allowNull: true },
    last_ssl_check: { type: 'timestamp', allowNull: true },
    last_domain_check: { type: 'timestamp', allowNull: true },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('monitors', ['ssl_expiry', 'domain_expiry', 'last_ssl_check', 'last_domain_check']);
};
