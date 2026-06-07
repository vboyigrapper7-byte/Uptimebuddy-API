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
    const rangeDays = range === '7d' ? 7 : range === '90d' ? 90 : 30;

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
             WHERE agent_id = $1 AND recorded_at > NOW() - ($2 * INTERVAL '1 day')`,
            [agentId, rangeDays]
        );

        const historyRes = await pool.query(
            `SELECT 
                DATE_TRUNC('day', recorded_at) as date,
                AVG(cpu_percent) as avg_cpu,
                AVG(ram_mb) * 100.0 / NULLIF(AVG(ram_total_mb), 0) as avg_ram,
                AVG(disk_percent) as avg_disk
             FROM agent_metrics
             WHERE agent_id = $1 AND recorded_at > NOW() - ($2 * INTERVAL '1 day')
             GROUP BY DATE_TRUNC('day', recorded_at)
             ORDER BY DATE_TRUNC('day', recorded_at) ASC`,
            [agentId, rangeDays]
        );

        return {
            agent,
            stats: metricsRes.rows[0] || {},
            history: historyRes.rows,
            generatedAt: new Date().toISOString()
        };
    } else if (type === 'audit_logs') {
        const auditRes = await pool.query(
            `SELECT * FROM audit_logs 
             WHERE user_id = $1 AND created_at > NOW() - ($2 * INTERVAL '1 day') 
             ORDER BY created_at DESC LIMIT 100`,
            [userId, rangeDays]
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
             WHERE monitor_id = $1 AND recorded_at > NOW() - ($2 * INTERVAL '1 day')`,
            [monitorId, rangeDays]
        );

        const trendRes = await pool.query(
            `SELECT 
                DATE_TRUNC('day', recorded_at) as date,
                AVG(response_time_ms) as avg_latency,
                COUNT(*) FILTER (WHERE status = 'up') * 100.0 / NULLIF(COUNT(*), 0) as uptime_percentage
             FROM monitor_metrics
             WHERE monitor_id = $1 AND recorded_at > NOW() - ($2 * INTERVAL '1 day')
             GROUP BY DATE_TRUNC('day', recorded_at)
             ORDER BY DATE_TRUNC('day', recorded_at) ASC`,
            [monitorId, rangeDays]
        );

        const incidentRes = await pool.query(
            `SELECT id, started_at, resolved_at, error_message
             FROM incidents
             WHERE monitor_id = $1 AND started_at > NOW() - ($2 * INTERVAL '1 day')
             ORDER BY started_at DESC`,
            [monitorId, rangeDays]
        );

        return {
            monitor,
            stats: metricsRes.rows[0] || {},
            trend: trendRes.rows,
            incidents: incidentRes.rows,
            generatedAt: new Date().toISOString()
        };
    }
}

function renderSvgChart(pointsData, width = 600, height = 180, strokeColor = '#4f46e5', fillColor = 'rgba(79, 70, 229, 0.08)') {
    if (!pointsData || pointsData.length === 0) {
        return `
        <svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" style="background: #f8fafc; border-radius: 8px;">
            <text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="12" fill="#94a3b8">No trend data available for this range</text>
        </svg>`;
    }

    const padding = { top: 15, right: 15, bottom: 25, left: 45 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const values = pointsData.map(d => Number(d.value || 0));
    const minVal = 0;
    let maxVal = Math.max(...values, 10);
    maxVal = maxVal * 1.15; // 15% headroom

    const points = pointsData.map((d, index) => {
        const x = padding.left + (index / (pointsData.length - 1 || 1)) * chartWidth;
        const y = padding.top + chartHeight - ((Number(d.value || 0) - minVal) / (maxVal - minVal)) * chartHeight;
        return { x, y };
    });

    let pathD = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
        pathD += ` L ${points[i].x} ${points[i].y}`;
    }

    let areaD = `${pathD} L ${points[points.length - 1].x} ${padding.top + chartHeight} L ${points[0].x} ${padding.top + chartHeight} Z`;

    // Horizontal grid lines
    const gridLines = [];
    const gridCount = 3;
    for (let i = 0; i <= gridCount; i++) {
        const yVal = minVal + (maxVal - minVal) * (i / gridCount);
        const y = padding.top + chartHeight - (i / gridCount) * chartHeight;
        gridLines.push({ y, label: Math.round(yVal) });
    }

    // X Axis labels (max 5 labels)
    const labelStep = Math.max(1, Math.floor(pointsData.length / 5));
    const xLabels = [];
    for (let i = 0; i < pointsData.length; i += labelStep) {
        xLabels.push({ x: points[i].x, label: pointsData[i].label });
    }
    if (pointsData.length > 1 && (pointsData.length - 1) % labelStep !== 0) {
        xLabels.push({ x: points[points.length - 1].x, label: pointsData[pointsData.length - 1].label });
    }

    const gridLinesSvg = gridLines.map(g => `
        <line x1="${padding.left}" y1="${g.y}" x2="${width - padding.right}" y2="${g.y}" stroke="#f1f5f9" stroke-dasharray="3" />
        <text x="${padding.left - 10}" y="${g.y + 3}" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="9" fill="#94a3b8">${g.label}</text>
    `).join('');

    const xLabelsSvg = xLabels.map(l => `
        <text x="${l.x}" y="${height - 6}" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="9" fill="#94a3b8">${l.label}</text>
    `).join('');

    return `
        <svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}">
            ${gridLinesSvg}
            <path d="${areaD}" fill="${fillColor}" />
            <path d="${pathD}" fill="none" stroke="${strokeColor}" stroke-width="2" />
            ${xLabelsSvg}
        </svg>
    `;
}

function formatDuration(startedAt, resolvedAt) {
    if (!resolvedAt) return 'Ongoing';
    const diffMs = new Date(resolvedAt) - new Date(startedAt);
    const diffMins = Math.round(diffMs / 60000);
    if (diffMins < 60) return `${diffMins} min${diffMins !== 1 ? 's' : ''}`;
    const diffHours = Math.floor(diffMins / 60);
    const remainingMins = diffMins % 60;
    if (remainingMins === 0) return `${diffHours} hr${diffHours !== 1 ? 's' : ''}`;
    return `${diffHours} hr${diffHours !== 1 ? 's' : ''} ${remainingMins} min${remainingMins !== 1 ? 's' : ''}`;
}

async function generatePDF(type, data, config) {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: 'new'
    });
    const page = await browser.newPage();

    let title = 'SLA Compliance Report';
    let contentHtml = '';

    if (type === 'server_telemetry') {
        title = 'Server Telemetry & Diagnostics';
        
        const avgCpu = data.stats.avg_cpu ? Number(data.stats.avg_cpu).toFixed(1) : '0.0';
        const avgRam = data.stats.avg_ram ? Number(data.stats.avg_ram).toFixed(1) : '0.0';
        const avgDisk = data.stats.avg_disk ? Number(data.stats.avg_disk).toFixed(1) : '0.0';
        const uptimeHrs = data.stats.max_uptime ? Math.round(Number(data.stats.max_uptime) / 3600) : 0;
        
        // Generate CPU & Memory Charts
        const cpuData = data.history.map(h => ({
            value: h.avg_cpu,
            label: new Date(h.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        }));
        const ramData = data.history.map(h => ({
            value: h.avg_ram,
            label: new Date(h.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        }));

        const cpuChart = renderSvgChart(cpuData, 600, 150, '#3b82f6', 'rgba(59, 130, 246, 0.05)');
        const ramChart = renderSvgChart(ramData, 600, 150, '#10b981', 'rgba(16, 185, 129, 0.05)');

        // History Table rows
        const historyRows = data.history.slice(-10).reverse().map(h => `
            <tr>
                <td>${new Date(h.date).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</td>
                <td>${Number(h.avg_cpu).toFixed(1)}%</td>
                <td>${Number(h.avg_ram).toFixed(1)}%</td>
                <td>${Number(h.avg_disk).toFixed(1)}%</td>
            </tr>
        `).join('');

        contentHtml = `
        <div class="target-section">
            <h1 class="target-title">Server: ${data.agent ? data.agent.name : 'Unknown Server'}</h1>
            <p class="target-desc">Group: ${data.agent ? data.agent.server_group : 'Ungrouped'} • Token: ${data.agent ? data.agent.agent_token.slice(0, 12) + '...' : 'N/A'}</p>
        </div>

        <div class="stats-grid">
            <div class="stat-card blue">
                <div class="stat-label">Avg CPU Load</div>
                <div class="stat-value">${avgCpu}%</div>
            </div>
            <div class="stat-card green">
                <div class="stat-label">Avg RAM Usage</div>
                <div class="stat-value">${avgRam}%</div>
            </div>
            <div class="stat-card purple">
                <div class="stat-label">Avg Disk Space</div>
                <div class="stat-value">${avgDisk}%</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Max Uptime</div>
                <div class="stat-value">${uptimeHrs} hrs</div>
            </div>
        </div>

        <div class="section-card">
            <div class="section-title">CPU Utilization Trend (%)</div>
            <div class="chart-container">${cpuChart}</div>
        </div>

        <div class="section-card" style="page-break-before: always;">
            <div class="section-title">Memory Allocation Trend (%)</div>
            <div class="chart-container">${ramChart}</div>
        </div>

        <div class="section-card">
            <div class="section-title">Recent Telemetry Records</div>
            <table>
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>CPU Average</th>
                        <th>RAM Average</th>
                        <th>Disk Space Used</th>
                    </tr>
                </thead>
                <tbody>
                    ${historyRows || '<tr><td colspan="4" style="text-align: center;">No diagnostic logs recorded.</td></tr>'}
                </tbody>
            </table>
        </div>
        `;
    } else if (type === 'audit_logs') {
        title = 'User Activity & Audit Trail';
        
        let logsTableRows = '';
        if (data.logs && data.logs.length > 0) {
            logsTableRows = data.logs.map(log => `
                <tr>
                    <td style="font-weight: 500;">${new Date(log.created_at).toLocaleString()}</td>
                    <td><span class="badge success" style="background: rgba(79, 70, 229, 0.05); color: #4f46e5;">${log.action}</span></td>
                    <td>${log.entity_type || 'system'}</td>
                    <td style="font-family: monospace; font-size: 11px; color: #475569;">${log.ip_address || 'N/A'}</td>
                </tr>
            `).join('');
        } else {
            logsTableRows = `<tr><td colspan="4" style="text-align: center; color: #94a3b8;">No account events logged in this period.</td></tr>`;
        }

        const uniqueIps = new Set(data.logs.map(l => l.ip_address).filter(Boolean)).size;

        contentHtml = `
        <div class="target-section">
            <h1 class="target-title">Account Operations Log</h1>
            <p class="target-desc">Audit trail for monitoring configuration changes, API access, and user profile operations.</p>
        </div>

        <div class="stats-grid">
            <div class="stat-card blue">
                <div class="stat-label">Total Audit Events</div>
                <div class="stat-value">${data.logs.length}</div>
            </div>
            <div class="stat-card purple">
                <div class="stat-label">Unique Access IPs</div>
                <div class="stat-value">${uniqueIps}</div>
            </div>
        </div>

        <div class="section-card">
            <div class="section-title">Administrative Operations History</div>
            <table>
                <thead>
                    <tr>
                        <th>Timestamp</th>
                        <th>Action Performed</th>
                        <th>Affected Module</th>
                        <th>Source IP</th>
                    </tr>
                </thead>
                <tbody>
                    ${logsTableRows}
                </tbody>
            </table>
        </div>
        `;
    } else {
        const uptimePct = data.stats.uptime_percentage !== undefined ? Number(data.stats.uptime_percentage).toFixed(3) : '100.000';
        const avgLat = data.stats.avg_latency ? Math.round(Number(data.stats.avg_latency)) : 0;
        const isCompliant = Number(uptimePct) >= 99.0;

        if (type === 'sla') {
            title = 'SLA Compliance Statement';

            const complianceBadge = isCompliant 
                ? '<span class="badge success" style="padding: 6px 12px; font-size: 12px;">SLA Compliant</span>' 
                : '<span class="badge danger" style="padding: 6px 12px; font-size: 12px;">SLA Breached</span>';

            const chartData = data.trend.map(t => ({
                value: t.avg_latency,
                label: new Date(t.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
            }));

            const trendChart = renderSvgChart(chartData, 600, 180, '#4f46e5', 'rgba(79, 70, 229, 0.05)');

            contentHtml = `
            <div class="target-section">
                <h1 class="target-title">${data.monitor ? data.monitor.name : 'Unknown Monitor'}</h1>
                <p class="target-desc">Resource Address: ${data.monitor ? data.monitor.target : 'N/A'} • Type: ${data.monitor ? data.monitor.type.toUpperCase() : 'N/A'}</p>
            </div>

            <div class="stats-grid">
                <div class="stat-card green">
                    <div class="stat-label">Uptime Achievement</div>
                    <div class="stat-value">${uptimePct}%</div>
                </div>
                <div class="stat-card blue">
                    <div class="stat-label">Avg. Latency</div>
                    <div class="stat-value">${avgLat}ms</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">SLA Threshold</div>
                    <div class="stat-value">99.000%</div>
                </div>
                <div class="stat-card" style="display: flex; flex-direction: column; justify-content: center; align-items: flex-start;">
                    <div class="stat-label" style="margin-bottom: 8px;">Compliance Status</div>
                    ${complianceBadge}
                </div>
            </div>

            <div class="section-card">
                <div class="section-title">Resource Average Latency Trend (ms)</div>
                <div class="chart-container">${trendChart}</div>
            </div>

            <div class="section-card" style="background: ${isCompliant ? '#f0fdf4' : '#fef2f2'}; border-color: ${isCompliant ? '#bbf7d0' : '#fecaca'};">
                <h3 style="margin-top: 0; color: ${isCompliant ? '#166534' : '#991b1b'};">Compliance Declaration</h3>
                <p style="margin: 0; font-size: 13px; color: ${isCompliant ? '#14532d' : '#7f1d1d'};">
                    ${isCompliant 
                        ? `The monitored service maintained an uptime ratio of ${uptimePct}%, which exceeds the target SLA compliance threshold of 99.000% defined for this resource.`
                        : `The monitored service suffered availability degradation, with an uptime ratio of ${uptimePct}%, dropping below the target SLA compliance threshold of 99.000%.`
                    }
                </p>
            </div>
            `;
        } else if (type === 'uptime') {
            title = 'Uptime & Latency History';

            const chartData = data.trend.map(t => ({
                value: t.avg_latency,
                label: new Date(t.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
            }));

            const trendChart = renderSvgChart(chartData, 600, 180, '#4f46e5', 'rgba(79, 70, 229, 0.05)');

            const dailyRows = data.trend.slice(-15).reverse().map(t => `
                <tr>
                    <td>${new Date(t.date).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</td>
                    <td style="font-weight: bold; color: ${Number(t.uptime_percentage) >= 99.0 ? '#10b981' : '#f59e0b'};">${Number(t.uptime_percentage).toFixed(3)}%</td>
                    <td>${Math.round(Number(t.avg_latency))} ms</td>
                    <td>
                        <span class="badge ${Number(t.uptime_percentage) >= 99.9 ? 'success' : 'warning'}">
                            ${Number(t.uptime_percentage) >= 99.9 ? 'Optimal' : 'Warnings'}
                        </span>
                    </td>
                </tr>
            `).join('');

            contentHtml = `
            <div class="target-section">
                <h1 class="target-title">${data.monitor ? data.monitor.name : 'Unknown Monitor'}</h1>
                <p class="target-desc">Resource Address: ${data.monitor ? data.monitor.target : 'N/A'} • Daily breakdown list</p>
            </div>

            <div class="stats-grid">
                <div class="stat-card green">
                    <div class="stat-label">Total Range Uptime</div>
                    <div class="stat-value">${uptimePct}%</div>
                </div>
                <div class="stat-card blue">
                    <div class="stat-label">Range Average Latency</div>
                    <div class="stat-value">${avgLat}ms</div>
                </div>
            </div>

            <div class="section-card">
                <div class="section-title">Daily Response Time Progression (ms)</div>
                <div class="chart-container">${trendChart}</div>
            </div>

            <div class="section-card">
                <div class="section-title">Daily Availability & Latency Log</div>
                <table>
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Uptime Percentage</th>
                            <th>Avg Response Time</th>
                            <th>Status Condition</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${dailyRows || '<tr><td colspan="4" style="text-align: center;">No metrics history found.</td></tr>'}
                    </tbody>
                </table>
            </div>
            `;
        } else if (type === 'incident') {
            title = 'Incident Response Log';

            const activeIncidents = data.incidents.filter(i => !i.resolved_at).length;
            const totalIncidents = data.incidents.length;

            const incidentRows = data.incidents.map(i => {
                const dur = formatDuration(i.started_at, i.resolved_at);
                const statusBadge = i.resolved_at 
                    ? '<span class="badge success">Resolved</span>' 
                    : '<span class="badge danger">Ongoing</span>';
                return `
                    <tr>
                        <td style="font-weight: 500;">${new Date(i.started_at).toLocaleString()}</td>
                        <td>${i.resolved_at ? new Date(i.resolved_at).toLocaleString() : statusBadge}</td>
                        <td style="font-weight: 600;">${dur}</td>
                        <td style="font-family: monospace; font-size: 12px; color: #ef4444;">${i.error_message || 'Connection Refused/Unknown Error'}</td>
                    </tr>
                `;
            }).join('');

            contentHtml = `
            <div class="target-section">
                <h1 class="target-title">${data.monitor ? data.monitor.name : 'Unknown Monitor'}</h1>
                <p class="target-desc">Resource Address: ${data.monitor ? data.monitor.target : 'N/A'} • Service incident logbook</p>
            </div>

            <div class="stats-grid">
                <div class="stat-card red">
                    <div class="stat-label">Total Outages</div>
                    <div class="stat-value">${totalIncidents}</div>
                </div>
                <div class="stat-card orange" style="border-color: #fdba74;">
                    <div class="stat-label">Active Outages</div>
                    <div class="stat-value">${activeIncidents}</div>
                </div>
                <div class="stat-card green">
                    <div class="stat-label">Overall Uptime</div>
                    <div class="stat-value">${uptimePct}%</div>
                </div>
            </div>

            <div class="section-card">
                <div class="section-title">Incident Outages List</div>
                <table>
                    <thead>
                        <tr>
                            <th>Incident Start</th>
                            <th>Resolution Time</th>
                            <th>Downtime Duration</th>
                            <th>Error Response Detail</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${incidentRows || '<tr><td colspan="4" style="text-align: center; color: #10b981; font-weight: 600; padding: 30px;">✔ No service outages logged during this period.</td></tr>'}
                    </tbody>
                </table>
            </div>
            `;
        }
    }

    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
            body {
                font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
                padding: 30px;
                color: #0f172a;
                background: #ffffff;
                line-height: 1.5;
            }
            .header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                border-bottom: 2px solid #f1f5f9;
                padding-bottom: 20px;
                margin-bottom: 30px;
            }
            .logo {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 20px;
                font-weight: 800;
                color: #4f46e5;
            }
            .logo-icon {
                width: 28px;
                height: 28px;
                background: linear-gradient(135deg, #4f46e5, #818cf8);
                border-radius: 8px;
                display: flex;
                align-items: center;
                justify-content: center;
                color: white;
                font-size: 14px;
                font-weight: bold;
            }
            .report-title-container {
                text-align: right;
            }
            .report-title {
                font-size: 16px;
                font-weight: 800;
                color: #0f172a;
                margin: 0;
            }
            .report-meta {
                font-size: 10px;
                color: #64748b;
                margin-top: 4px;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                font-weight: 600;
            }
            .target-section {
                margin-bottom: 30px;
            }
            .target-title {
                font-size: 22px;
                font-weight: 800;
                color: #0f172a;
                margin: 0 0 6px 0;
            }
            .target-desc {
                font-size: 12px;
                color: #64748b;
                margin: 0;
            }
            .stats-grid {
                display: grid;
                grid-template-columns: repeat(4, 1fr);
                gap: 15px;
                margin-bottom: 30px;
            }
            .stat-card {
                background: #f8fafc;
                border: 1px solid #f1f5f9;
                border-radius: 12px;
                padding: 14px 18px;
                position: relative;
                overflow: hidden;
            }
            .stat-card::before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                width: 4px;
                height: 100%;
                background: #4f46e5;
            }
            .stat-card.blue::before { background: #3b82f6; }
            .stat-card.green::before { background: #10b981; }
            .stat-card.purple::before { background: #8b5cf6; }
            .stat-card.red::before { background: #ef4444; }
            .stat-card.orange::before { background: #f97316; }

            .stat-label {
                font-size: 10px;
                font-weight: 700;
                color: #64748b;
                text-transform: uppercase;
                letter-spacing: 0.05em;
            }
            .stat-value {
                font-size: 24px;
                font-weight: 800;
                color: #0f172a;
                margin: 6px 0 0 0;
            }
            .section-card {
                border: 1px solid #f1f5f9;
                border-radius: 16px;
                padding: 20px;
                margin-bottom: 25px;
            }
            .section-title {
                font-size: 14px;
                font-weight: 700;
                color: #0f172a;
                margin: 0 0 14px 0;
            }
            .chart-container {
                margin-top: 10px;
                background: #ffffff;
                border: 1px solid #f8fafc;
                border-radius: 8px;
                padding: 10px;
            }
            table {
                width: 100%;
                border-collapse: collapse;
                font-size: 12px;
            }
            th {
                background: #f8fafc;
                padding: 8px 12px;
                font-weight: 700;
                color: #475569;
                text-align: left;
                border-bottom: 2px solid #e2e8f0;
            }
            td {
                padding: 10px 12px;
                border-bottom: 1px solid #f1f5f9;
                color: #334155;
            }
            tr:last-child td {
                border-bottom: none;
            }
            .badge {
                display: inline-flex;
                align-items: center;
                padding: 2px 6px;
                border-radius: 4px;
                font-size: 10px;
                font-weight: 700;
                text-transform: uppercase;
            }
            .badge.success { background: #d1fae5; color: #065f46; }
            .badge.danger { background: #fee2e2; color: #991b1b; }
            .badge.warning { background: #fef3c7; color: #92400e; }
            .footer {
                margin-top: 50px;
                border-top: 1px solid #f1f5f9;
                padding-top: 15px;
                font-size: 10px;
                color: #94a3b8;
                text-align: center;
            }
        </style>
    </head>
    <body>
        <div class="header">
            <div class="logo">
                <div class="logo-icon">M</div>
                Monitor Hub
            </div>
            <div class="report-title-container">
                <div class="report-title">${title}</div>
                <div class="report-meta">RANGE: ${config.range.toUpperCase()} • AGGREGATED HISTORICAL REPORT</div>
            </div>
        </div>
        
        ${contentHtml}

        <div class="footer">
            Generated by Monitor Hub at ${new Date(data.generatedAt).toLocaleString()} • Secure Monitoring Infrastructure Statement
        </div>
    </body>
    </html>
    `;

    await page.setContent(htmlContent);
    const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '30px', bottom: '30px', left: '30px', right: '30px' }
    });

    await browser.close();
    return pdfBuffer;
}

logger.info('[ReportWorker] Initialized and waiting for report-tasks queue...');

module.exports = reportWorker;
