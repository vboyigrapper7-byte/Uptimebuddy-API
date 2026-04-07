require('dotenv').config();
const si    = require('systeminformation');
const axios = require('axios');

// ── Config validation ─────────────────────────────────────────────────────
const AGENT_TOKEN    = process.env.AGENT_TOKEN;
const INGEST_URL     = process.env.INGEST_URL;
const REPORT_INTERVAL = parseInt(process.env.REPORT_INTERVAL_MS || '30000', 10);

if (!AGENT_TOKEN || AGENT_TOKEN === 'YOUR_TOKEN_HERE') {
    console.error('[Agent] FATAL: AGENT_TOKEN is not configured in .env');
    process.exit(1);
}
if (!INGEST_URL) {
    console.error('[Agent] FATAL: INGEST_URL is not configured in .env');
    process.exit(1);
}

// ── Startup banner (token is intentionally NOT logged) ────────────────────
console.log('==========================================');
console.log(' UptimeBuddy Node Agent v2.1');
console.log(` Ingest URL     : ${INGEST_URL}`);
console.log(` Report Interval: ${REPORT_INTERVAL / 1000}s`);
console.log('==========================================\n');

// ── Metrics collection ────────────────────────────────────────────────────
async function collectMetrics() {
    const [memory, load, fsData] = await Promise.all([
        si.mem(),
        si.currentLoad(),
        si.fsSize(),
    ]);

    // Pick primary disk — prefer / on Linux, first drive on Windows
    const primaryDisk = fsData.find(d => d.mount === '/') || fsData.find(d => d.mount.match(/^[A-Z]:\\/)) || fsData[0];
    const diskPercent = primaryDisk ? parseFloat(primaryDisk.use.toFixed(2)) : 0;

    return {
        metrics: {
            cpu_percent:  parseFloat(load.currentLoad.toFixed(2)),
            ram_mb:       Math.floor(memory.active / (1024 * 1024)),
            ram_total_mb: Math.floor(memory.total / (1024 * 1024)),
            disk_percent: diskPercent,
        },
    };
}

// ── Send metrics with retry ───────────────────────────────────────────────
let failedAttempts = 0;

async function sendMetrics() {
    try {
        const data = await collectMetrics();
        const { cpu_percent, ram_mb, disk_percent } = data.metrics;

        const headers = { 
            'Content-Type': 'application/json', 
            'User-Agent': 'UptimeBuddy-Agent/2.2' 
        };

        // Priority 1: Specific Agent Token
        if (AGENT_TOKEN) headers['X-Agent-Token'] = AGENT_TOKEN;
        
        // Priority 2: Master API Key (if configured)
        if (process.env.API_KEY) headers['X-API-KEY'] = process.env.API_KEY;

        await axios.post(INGEST_URL, data, {
            timeout: 8000,
            headers
        });

        const ts = new Date().toISOString();
        console.log(`[${ts}] ✓ CPU: ${cpu_percent}% | RAM: ${ram_mb}MB | Disk: ${disk_percent}%`);
        failedAttempts = 0; // Reset on success
    } catch (err) {
        failedAttempts++;
        const ts = new Date().toISOString();
        
        if (err.response) {
            console.error(`[${ts}] ✗ CRITICAL: Platform rejected telemetry (Status: ${err.response.status})`);
            if (err.response.status === 401) {
                console.warn('[HINT] Status 401 suggests an invalid AGENT_TOKEN. Regenerate it from the dashboard.');
            }
        } else if (err.request) {
            console.error(`[${ts}] ✗ NETWORK ERROR: Platform at ${INGEST_URL} is unreachable.`);
            console.warn('[TROUBLESHOOT] Ensure the UptimeBuddy platform is running and port 3001 is open in your firewall.');
        } else {
            console.error(`[${ts}] ✗ UNEXPECTED ERROR: ${err.message}`);
        }

        if (failedAttempts >= 3) {
            console.log('[BACKOFF] Connection unstable. Retrying next cycle...');
        }
    }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────
let intervalHandle;

const shutdown = (signal) => {
    console.log(`\n[Agent] Received ${signal}. Shutting down cleanly...`);
    if (intervalHandle) clearInterval(intervalHandle);
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Start ─────────────────────────────────────────────────────────────────
sendMetrics(); // immediate first report
intervalHandle = setInterval(sendMetrics, REPORT_INTERVAL);
