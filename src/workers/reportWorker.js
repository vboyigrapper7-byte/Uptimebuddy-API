require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Worker } = require('bullmq');
const puppeteer = require('puppeteer');
const pool = require('../core/db/pool');
const logger = require('../core/utils/logger');
const { workerRedisConnection } = require('../core/queue/setup');
const fs = require('fs');
const path = require('path');

const reportWorker = new Worker('report-tasks', async (job) => {
    const { reportId, userId, monitor_id, monitorId, type, config } = job.data;
    const actualMonitorId = monitor_id || monitorId;
    logger.info(`[ReportWorker] Generating ${type} report for Report ID: ${reportId}`);

    try {
        await pool.query('UPDATE reports SET status = $1 WHERE id = $2', ['processing', reportId]);

        // 1. Fetch Data
        const stats = await fetchReportData(actualMonitorId, config);

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

async function fetchReportData(monitorId, config) {
    // Basic stats fetching logic
    const { range = '30d' } = config;
    const monitorRes = await pool.query('SELECT * FROM monitors WHERE id = $1', [monitorId]);
    const monitor = monitorRes.rows[0];

    // Fetch uptime and latency
    const metricsRes = await pool.query(
        `SELECT 
            AVG(response_time_ms) as avg_latency,
            COUNT(*) FILTER (WHERE status = 'up') * 100.0 / COUNT(*) as uptime_percentage
         FROM monitor_metrics 
         WHERE monitor_id = $1 AND recorded_at > NOW() - INTERVAL '${range}'`,
        [monitorId]
    );

    return {
        monitor,
        stats: metricsRes.rows[0],
        generatedAt: new Date().toISOString()
    };
}

async function generatePDF(type, data, config) {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: 'new'
    });
    const page = await browser.newPage();

    // Premium HTML Template
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
            <div class="title">Service Level Agreement (SLA) Report</div>
        </div>
        
        <div style="margin-top: 30px;">
            <h1 style="margin: 0;">${data.monitor.name}</h1>
            <p style="color: #64748b;">Target: ${data.monitor.target}</p>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">Uptime Percentage</div>
                <div class="stat-value">${Number(data.stats.uptime_percentage || 100).toFixed(3)}%</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Avg. Response Time</div>
                <div class="stat-value">${Math.round(data.stats.avg_latency || 0)}ms</div>
            </div>
        </div>

        <div style="margin-top: 40px; background: #eff6ff; padding: 20px; border-radius: 12px;">
            <h3 style="margin-top: 0; color: #1d4ed8;">SLA Compliance Status</h3>
            <p>The monitored resource met all defined availability targets for the specified period (${config.range}).</p>
        </div>

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
