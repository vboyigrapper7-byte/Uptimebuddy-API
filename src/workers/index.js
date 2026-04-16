/**
 * Monitor Hub Worker Entry Point
 * Loads all backend background workers.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

console.log('--- Starting Monitor Hub Workers ---');

require('./checkWorker');
require('./alertWorker');
require('./retentionWorker');

console.log('--- All Workers Initialized ---');
