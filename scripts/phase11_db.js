const { Client } = require('pg');

async function migrate() {
    console.log("Applying Phase 11 Migrations...");
    const client = new Client({
        connectionString: 'postgresql://postgres:postgres@localhost:5433/uptimebuddy'
    });

    try {
        await client.connect();
        await client.query("ALTER TABLE agents ADD COLUMN IF NOT EXISTS server_group VARCHAR(255) DEFAULT 'Ungrouped';");
        console.log("-> Added 'server_group' to agents table.");
        
        await client.query("ALTER TABLE agent_metrics DROP CONSTRAINT IF EXISTS agent_metrics_agent_id_fkey;");
        await client.query("ALTER TABLE agent_metrics ADD CONSTRAINT agent_metrics_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;");
        console.log("-> Added 'ON DELETE CASCADE' to agent_metrics foreign key.");
    } catch (e) {
        console.error("Migration failed:", e);
    } finally {
        await client.end();
        process.exit(0);
    }
}
migrate();
