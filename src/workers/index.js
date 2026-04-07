/**
 * UptimeBuddy Worker Entry Point
 * Loads all backend background workers.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

console.log('--- Starting UptimeBuddy Workers ---');

require('./checkWorker');
require('./alertWorker');
require('./retentionWorker');

console.log('--- All Workers Initialized ---');
