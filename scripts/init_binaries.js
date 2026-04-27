require('dotenv').config();
const { Client } = require('pg');

async function run() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL.replace('5433', '5432')
    });

    try {
        await client.connect();
        console.log('Connected to Database');

        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_releases (
                id           SERIAL PRIMARY KEY,
                version      VARCHAR(50) UNIQUE NOT NULL,
                is_stable    BOOLEAN DEFAULT FALSE,
                created_at   TIMESTAMP DEFAULT NOW()
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS agent_binaries (
                id           SERIAL PRIMARY KEY,
                release_id   INT REFERENCES agent_releases(id) ON DELETE CASCADE,
                os           VARCHAR(20),
                arch         VARCHAR(20),
                file_path    TEXT NOT NULL,
                sha256       VARCHAR(64),
                created_at   TIMESTAMP DEFAULT NOW()
            )
        `);

        await client.query(`
            INSERT INTO agent_releases (version, is_stable) 
            VALUES ('1.1.0', true) 
            ON CONFLICT (version) DO UPDATE SET is_stable = true
        `);

        const rel = await client.query("SELECT id FROM agent_releases WHERE version = '1.1.0'");
        const relId = rel.rows[0].id;

        await client.query("DELETE FROM agent_binaries WHERE os = 'windows' AND arch = 'amd64'");
        await client.query(`
            INSERT INTO agent_binaries (release_id, os, arch, file_path) 
            VALUES ($1, $2, $3, $4)
        `, [relId, 'windows', 'amd64', '../uptimebuddy-go-agent/bin/monitorhub-agent-windows-amd64.exe']);

        console.log('SUCCESS: Agent binary distribution tables initialized.');
    } catch (err) {
        console.error('FAILED:', err.message);
    } finally {
        await client.end();
    }
}

run();
