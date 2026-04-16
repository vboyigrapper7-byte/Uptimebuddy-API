const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { buildServer } = require('../src/server');

describe('Server Initialization', () => {
    let server;

    before(async () => {
        process.env.NODE_ENV = 'test';
        server = await buildServer();
        await server.ready();
    });

    after(async () => {
        if (server) {
            await server.close();
        }
    });

    it('should boot up and register /health endpoint', async () => {
        const response = await server.inject({
            method: 'GET',
            url: '/health'
        });

        assert.ok(response.statusCode === 200 || response.statusCode === 503);
        const json = JSON.parse(response.payload);
        assert.ok(json.status);
        assert.strictEqual(json.service, 'uptimebuddy-api');
    });

    it('should register root endpoint', async () => {
        const response = await server.inject({
            method: 'GET',
            url: '/'
        });
        
        assert.strictEqual(response.statusCode, 200);
        const json = JSON.parse(response.payload);
        assert.strictEqual(json.status, 'ok');
    });
});
