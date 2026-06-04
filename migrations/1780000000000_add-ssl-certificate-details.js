exports.up = (pgm) => {
  pgm.addColumns('monitors', {
    ssl_issuer:      { type: 'varchar(500)', allowNull: true },
    ssl_subject:     { type: 'varchar(500)', allowNull: true },
    ssl_valid_from:  { type: 'timestamp', allowNull: true },
    ssl_protocol:    { type: 'varchar(20)', allowNull: true },
    ssl_cipher:      { type: 'varchar(100)', allowNull: true },
    ssl_fingerprint: { type: 'varchar(128)', allowNull: true },
    ssl_sans:        { type: 'text', allowNull: true },
    ssl_is_valid:    { type: 'boolean', allowNull: true, default: null },
    ssl_error:       { type: 'text', allowNull: true },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('monitors', [
    'ssl_issuer', 'ssl_subject', 'ssl_valid_from', 'ssl_protocol',
    'ssl_cipher', 'ssl_fingerprint', 'ssl_sans', 'ssl_is_valid', 'ssl_error'
  ]);
};
