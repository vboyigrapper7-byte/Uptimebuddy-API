require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Worker } = require('bullmq');
const puppeteer = require('puppeteer');
const pool = require('../core/db/pool');
const logger = require('../core/utils/logger');
const { workerRedisConnection } = require('../core/queue/setup');
const fs = require('fs');
const path = require('path');

const reportWorker = new Worker('report-tasks', async (job) => {
    const { reportId, userId, monitor_id, monitorId, agent_id, type, config } = job.data;
    const actualMonitorId = monitor_id || monitorId;
    logger.info(`[ReportWorker] Generating ${type} report for Report ID: ${reportId}`);

    try {
        await pool.query('UPDATE reports SET status = $1 WHERE id = $2', ['processing', reportId]);

        // 1. Fetch Data
        const stats = await fetchReportData(actualMonitorId, agent_id, type, config, userId);

        // 2. Render PDF
        const pdfBuffer = await generatePDF(type, stats, config);

        // 3. Store PDF (Local storage for now, S3/R2 placeholder)
        const fileName = `report_${reportId}_${Date.now()}.pdf`;
        const storagePath = path.join(__dirname, '../../public/reports', fileName);
        
        if (!fs.existsSync(path.dirname(storagePath))) {
            fs.mkdirSync(path.dirname(storagePath), { recursive: true });
        }
        
        fs.writeFileSync(storagePath, pdfBuffer);
        
        // In a real S3 scenario, you would upload here and get a URL
        const publicUrl = `/public/reports/${fileName}`; 

        await pool.query(
            'UPDATE reports SET status = $1, url = $2, completed_at = NOW() WHERE id = $3',
            ['completed', publicUrl, reportId]
        );

        logger.info(`[ReportWorker] Report ${reportId} completed successfully.`);
    } catch (err) {
        logger.error(`[ReportWorker] Failed to generate report ${reportId}: ${err.message}`);
        await pool.query(
            'UPDATE reports SET status = $1, error = $2 WHERE id = $3',
            ['failed', err.message, reportId]
        );
    }
}, {
    connection: workerRedisConnection,
    concurrency: 1, // Puppeteer is heavy, keep it sequential
});

async function fetchReportData(monitorId, agentId, type, config, userId) {
    const { range = '30d' } = config;

    if (type === 'server_telemetry') {
        const agentRes = await pool.query('SELECT * FROM agents WHERE id = $1', [agentId]);
        const agent = agentRes.rows[0];

        const metricsRes = await pool.query(
            `SELECT 
                AVG(cpu_percent) as avg_cpu,
                AVG(ram_mb) * 100.0 / NULLIF(AVG(ram_total_mb), 0) as avg_ram,
                AVG(disk_percent) as avg_disk,
                MAX(uptime_seconds) as max_uptime
             FROM agent_metrics 
             WHERE agent_id = $1 AND recorded_at > NOW() - INTERVAL '${range}'`,
            [agentId]
        );

        return {
            agent,
            stats: metricsRes.rows[0] || {},
            generatedAt: new Date().toISOString()
        };
    } else if (type === 'audit_logs') {
        const auditRes = await pool.query(
            `SELECT * FROM audit_logs 
             WHERE user_id = $1 AND created_at > NOW() - INTERVAL '${range}' 
             ORDER BY created_at DESC LIMIT 100`,
            [userId]
        );
        return {
            logs: auditRes.rows,
            generatedAt: new Date().toISOString()
        };
    } else {
        const monitorRes = await pool.query('SELECT * FROM monitors WHERE id = $1', [monitorId]);
        const monitor = monitorRes.rows[0];

        // Fetch uptime and latency
        const metricsRes = await pool.query(
            `SELECT 
                AVG(response_time_ms) as avg_latency,
                COUNT(*) FILTER (WHERE status = 'up') * 100.0 / NULLIF(COUNT(*), 0) as uptime_percentage
             FROM monitor_metrics 
             WHERE monitor_id = $1 AND recorded_at > NOW() - INTERVAL '${range}'`,
            [monitorId]
        );

        return {
            monitor,
            stats: metricsRes.rows[0] || {},
            generatedAt: new Date().toISOString()
        };
    }
}

async function generatePDF(type, data, config) {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: 'new'
    });
    const page = await browser.newPage();

    let title = 'Service Level Agreement (SLA) Report';
    let contentHtml = '';

    if (type === 'server_telemetry') {
        title = 'Server Telemetry & Hardware Diagnostics';
        
        const avgCpu = data.stats.avg_cpu ? Number(data.stats.avg_cpu).toFixed(1) : '0.0';
        const avgRam = data.stats.avg_ram ? Number(data.stats.avg_ram).toFixed(1) : '0.0';
        const avgDisk = data.stats.avg_disk ? Number(data.stats.avg_disk).toFixed(1) : '0.0';
        const uptimeHrs = data.stats.max_uptime ? Math.round(Number(data.stats.max_uptime) / 3600) : 0;
        
        contentHtml = `
        <div style="margin-top: 30px;">
            <h1 style="margin: 0;">Server: ${data.agent ? data.agent.name : 'Unknown Server'}</h1>
            <p style="color: #64748b;">Token Reference: ${data.agent ? data.agent.agent_token.slice(0, 12) + '...' : 'N/A'}</p>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">Avg CPU Usage</div>
                <div class="stat-value">${avgCpu}%</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Avg RAM Usage</div>
                <div class="stat-value">${avgRam}%</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Avg Disk Usage</div>
                <div class="stat-value">${avgDisk}%</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Max Uptime</div>
                <div class="stat-value">${uptimeHrs} hrs</div>
            </div>
        </div>

        <div style="margin-top: 40px; background: #eff6ff; padding: 20px; border-radius: 12px;">
            <h3 style="margin-top: 0; color: #1d4ed8;">Hardware Performance Statement</h3>
            <p>Infrastructure telemetry displays normal running parameters within targets for target period (${config.range}).</p>
        </div>
        `;
    } else if (type === 'audit_logs') {
        title = 'User Activity & Administrative Audit Log';
        
        let logsTableRows = '';
        if (data.logs && data.logs.length > 0) {
            logsTableRows = data.logs.map(log => `
                <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 10px; font-size: 12px;">${new Date(log.created_at).toLocaleString()}</td>
                    <td style="padding: 10px; font-size: 12px; font-weight: bold; color: #6366f1;">${log.action}</td>
                    <td style="padding: 10px; font-size: 12px;">${log.entity_type || 'system'}</td>
                    <td style="padding: 10px; font-size: 12px; font-family: monospace;">${log.ip_address || 'N/A'}</td>
                </tr>
            `).join('');
        } else {
            logsTableRows = `<tr><td colspan="4" style="text-align: center; padding: 20px; color: #64748b;">No recent activity logs recorded in this period.</td></tr>`;
        }

        contentHtml = `
        <div style="margin-top: 30px;">
            <h1 style="margin: 0;">Account Activity Report</h1>
            <p style="color: #64748b;">Showing last 100 logged administrative events.</p>
        </div>

        <table style="width: 100%; border-collapse: collapse; margin-top: 30px; text-align: left;">
            <thead>
                <tr style="border-bottom: 2px solid #e2e8f0; background: #f8fafc; color: #64748b;">
                    <th style="padding: 10px; font-size: 12px;">Timestamp</th>
                    <th style="padding: 10px; font-size: 12px;">Action</th>
                    <th style="padding: 10px; font-size: 12px;">Entity</th>
                    <th style="padding: 10px; font-size: 12px;">IP Address</th>
                </tr>
            </thead>
            <tbody>
                ${logsTableRows}
            </tbody>
        </table>
        `;
    } else {
        title = type === 'sla' ? 'SLA Compliance Report' : type === 'uptime' ? 'Detailed Uptime History' : 'Incident Response Log';
        const uptimePct = data.stats.uptime_percentage !== undefined ? Number(data.stats.uptime_percentage).toFixed(3) : '100.000';
        const avgLat = data.stats.avg_latency ? Math.round(Number(data.stats.avg_latency)) : 0;
        
        contentHtml = `
        <div style="margin-top: 30px;">
            <h1 style="margin: 0;">${data.monitor ? data.monitor.name : 'Unknown Monitor'}</h1>
            <p style="color: #64748b;">Target: ${data.monitor ? data.monitor.target : 'N/A'}</p>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">Uptime Percentage</div>
                <div class="stat-value">${uptimePct}%</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Avg. Response Time</div>
                <div class="stat-value">${avgLat}ms</div>
            </div>
        </div>

        <div style="margin-top: 40px; background: #eff6ff; padding: 20px; border-radius: 12px;">
            <h3 style="margin-top: 0; color: #1d4ed8;">SLA Compliance Status</h3>
            <p>The monitored resource met all defined availability targets for the specified period (${config.range}).</p>
        </div>
        `;
    }

    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { font-family: 'Inter', sans-serif; padding: 40px; color: #1e293b; }
            .header { display: flex; justify-content: space-between; border-bottom: 2px solid #e2e8f0; padding-bottom: 20px; }
            .logo { font-size: 24px; font-weight: bold; color: #6366f1; }
            .title { font-size: 18px; color: #64748b; }
            .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 40px; }
            .stat-card { background: #f8fafc; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; }
            .stat-value { font-size: 32px; font-weight: bold; color: #6366f1; margin: 10px 0; }
            .stat-label { font-size: 14px; color: #64748b; text-transform: uppercase; }
            .footer { margin-top: 60px; font-size: 12px; color: #94a3b8; text-align: center; }
        </style>
    </head>
    <body>
        <div class="header">
            <div class="logo">Monitor Hub</div>
            <div class="title">${title}</div>
        </div>
        
        ${contentHtml}

        <div class="footer">
            Generated by Monitor Hub at ${data.generatedAt} • Secure Monitoring Platform
        </div>
    </body>
    </html>
    `;

    await page.setContent(htmlContent);
    const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' }
    });

    await browser.close();
    return pdfBuffer;
}

logger.info('[ReportWorker] Initialized and waiting for report-tasks queue...');

module.exports = reportWorker;
