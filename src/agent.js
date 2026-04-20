require('dotenv').config();
const si    = require('systeminformation');
const axios = require('axios');
const os    = require('os');

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
console.log(' Monitor Hub Node Agent v3.0');
console.log(` Ingest URL     : ${INGEST_URL}`);
console.log(` Report Interval: ${REPORT_INTERVAL / 1000}s`);
console.log('==========================================\n');

// ── Network & IP Cache ───────────────────────────────────────────────────
let prevNetStats    = null;
let prevNetTime     = null;
let cachedPublicIP  = null;
let cachedPrivateIP = null;
let lastFullReport  = 0;
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // Sync metadata every 5 mins

async function getPublicIP() {
    try {
        const response = await axios.get('https://api.ipify.org?format=json', { timeout: 3000 });
        cachedPublicIP = response.data.ip;
        return cachedPublicIP;
    } catch (err) {
        return cachedPublicIP; // Return previous known IP if fetch fails
    }
}

function getPrivateIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                cachedPrivateIP = iface.address;
                return iface.address;
            }
        }
    }
    return cachedPrivateIP;
}

// ── Metrics collection ────────────────────────────────────────────────────
async function collectMetrics() {
    const [memory, load, fsData, netStats, processes] = await Promise.all([
        si.mem(),
        si.currentLoad(),
        si.fsSize(),
        si.networkStats(),
        si.processes(),
    ]);

    // Pick primary disk — prefer / on Linux, first drive on Windows
    const primaryDisk = fsData.find(d => d.mount === '/') || fsData.find(d => d.mount.match(/^[A-Z]:\\/)) || fsData[0];
    const diskPercent = primaryDisk ? parseFloat(primaryDisk.use.toFixed(2)) : 0;

    // RAM
    const ramMb      = Math.floor(memory.active / (1024 * 1024));
    const ramTotalMb = Math.floor(memory.total  / (1024 * 1024));

    // Disk detailed
    const totalDiskGb = primaryDisk ? parseFloat((primaryDisk.size / (1024**3)).toFixed(2)) : 0;
    const freeDiskGb  = primaryDisk ? parseFloat(((primaryDisk.size - primaryDisk.used) / (1024**3)).toFixed(2)) : 0;

    // Network I/O delta
    const now        = Date.now();
    let netRxMb = 0;
    let netTxMb = 0;

    if (prevNetStats && prevNetTime) {
        const totalRxBytes = netStats.reduce((s, i) => s + (i.rx_bytes || 0), 0);
        const totalTxBytes = netStats.reduce((s, i) => s + (i.tx_bytes || 0), 0);
        const prevRxBytes  = prevNetStats.reduce((s, i) => s + (i.rx_bytes || 0), 0);
        const prevTxBytes  = prevNetStats.reduce((s, i) => s + (i.tx_bytes || 0), 0);
        netRxMb = parseFloat(((totalRxBytes - prevRxBytes) / (1024 * 1024)).toFixed(3));
        netTxMb = parseFloat(((totalTxBytes - prevTxBytes) / (1024 * 1024)).toFixed(3));
        if (netRxMb < 0) netRxMb = 0;
        if (netTxMb < 0) netTxMb = 0;
    }
    prevNetStats = netStats;
    prevNetTime  = now;

    const payload = {
        metrics: {
            cpu_percent:    parseFloat(load.currentLoad.toFixed(2)),
            ram_mb:         ramMb,
            ram_total_mb:   ramTotalMb,
            disk_percent:   diskPercent,
            disk_total_gb:  totalDiskGb,
            disk_free_gb:   freeDiskGb,
            net_rx_mb:      netRxMb,
            net_tx_mb:      netTxMb,
            uptime_seconds: Math.floor(os.uptime()),
            process_count:  processes.all || 0,
        }
    };

    // Periodically sync metadata (IPs, Hostname, etc) or if first report
    if (now - lastFullReport > SYNC_INTERVAL_MS) {
        const [pubIp, privIp] = await Promise.all([getPublicIP(), getPrivateIP()]);
        payload.public_ip  = pubIp;
        payload.private_ip = privIp;
        payload.hostname   = os.hostname();
        payload.os_type    = `${os.type()} ${os.release()}`;
        lastFullReport     = now;
    }

    return payload;
}
}

// ── Send metrics with retry ───────────────────────────────────────────────
let failedAttempts = 0;

async function sendMetrics() {
    try {
        const data = await collectMetrics();
        const { cpu_percent, ram_mb, disk_percent, net_rx_mb, net_tx_mb, uptime_seconds } = data.metrics;

        const headers = { 
            'Content-Type': 'application/json', 
            'User-Agent':   'MonitorHub-Agent/3.0',
            'X-Agent-Token': AGENT_TOKEN,
        };

        await axios.post(INGEST_URL, data, { timeout: 8000, headers });

        const ts = new Date().toISOString();
        console.log(`[${ts}] ✓ CPU: ${cpu_percent}% | RAM: ${ram_mb}MB | Disk: ${disk_percent}% | Net↓${net_rx_mb}MB ↑${net_tx_mb}MB | Up: ${Math.floor(uptime_seconds/3600)}h`);
        failedAttempts = 0;
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
            console.warn('[TROUBLESHOOT] Ensure the Monitor Hub platform is running and port 3001 is open in your firewall.');
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
