const { monitorQueue } = require('../../core/queue/setup');
const { scheduleMonitor, unscheduleMonitor } = require('../../core/queue/scheduler');
const { z } = require('zod');
const axios = require('axios');
const usageService = require('../../core/auth/usageService');

// ── SSRF blocklist — private/loopback IP ranges ───────────────────────────
const PRIVATE_IP_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|0\.0\.0\.0)/i;
const ALLOWED_TYPES = ['http', 'https', 'keyword', 'port', 'ping'];

function validateTarget(type, target) {
    if (['http', 'https', 'keyword'].includes(type)) {
        let parsed;
        try { parsed = new URL(target); } catch { return 'Invalid URL format'; }
        if (!['http:', 'https:'].includes(parsed.protocol)) return 'URL must use http or https';
        if (PRIVATE_IP_RE.test(parsed.hostname)) return 'Private or loopback network targets are not permitted';
    } else if (['port', 'ping'].includes(type)) {
        if (target.includes(':')) {
            const [host, portStr] = target.split(':');
            const port = parseInt(portStr, 10);
            if (PRIVATE_IP_RE.test(host)) return 'Private or loopback network targets are not permitted';
            if (isNaN(port) || port < 1 || port > 65535) return 'Invalid port number (1–65535)';
        }
    }
    return null; // valid
}

const CreateMonitorSchema = z.object({
    name:             z.string().min(1).max(100),
    type:             z.enum(['http', 'https', 'keyword', 'port', 'ping']),
    category:         z.enum(['uptime', 'api']).default('uptime'),
    target:           z.string().min(1).max(500),
    keyword:          z.string().max(255).optional().nullable(),
    interval_seconds: z.number().int().min(30).max(86400).default(300),
    method:           z.string().max(10).optional().default('GET'),
    headers:          z.any().optional(), // Can be string or object
    body:             z.string().optional(),
    timeout_ms:       z.number().int().min(500).max(60000).optional().default(10000),
    max_retries:      z.number().int().min(0).max(10).optional().default(3),
    expected_status:  z.string().max(50).optional().default('200-399'),
    threshold_ms:     z.number().int().min(0).max(60000).optional().default(0),
    region:           z.string().max(50).optional().default('Global'),
    priority:         z.string().max(20).optional().default('medium'),
    assertion_config: z.any().optional()
});

const UpdateMonitorSchema = z.object({
    name:             z.string().min(1).max(100).optional(),
    target:           z.string().min(1).max(500).optional(),
    keyword:          z.string().max(255).optional().nullable(),
    interval_seconds: z.number().int().min(30).max(86400).optional(),
    method:           z.string().max(10).optional(),
    headers:          z.any().optional(),
    body:             z.string().optional(),
    timeout_ms:       z.number().int().min(500).max(60000).optional(),
    max_retries:      z.number().int().min(0).max(10).optional(),
    expected_status:  z.string().max(50).optional(),
    threshold_ms:     z.number().int().min(0).max(60000).optional(),
    region:           z.string().max(50).optional(),
    priority:         z.string().max(20).optional(),
    assertion_config: z.any().optional()
});

// ── Create ────────────────────────────────────────────────────────────────
const createMonitor = async (request, reply) => {
    const parsed = CreateMonitorSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0].message });
    }

    const { name, type, category, target, keyword, interval_seconds, method, headers, body, timeout_ms, max_retries, expected_status, threshold_ms, region, priority, assertion_config } = parsed.data;
    const userId = request.user.id;

    try {
        await usageService.checkLimit(request.server.db, request.user, category);
    } catch (limitErr) {
        request.log.info(`Blocking creation for User ${userId}: ${limitErr.message}`);
        return reply.code(403).send({ 
            error: limitErr.message, 
            limitReached: true,
            upgradeRequired: true,
            billingUrl: '/dashboard/billing'
        });
    }
    
    // Enforce tier-specific interval minimums
    const effectiveInterval = usageService.getEffectiveInterval(request.user, interval_seconds);

    const ssrfError = validateTarget(type, target);
    if (ssrfError) return reply.code(400).send({ error: ssrfError });

    try {
        let dbHeaders = null;
        if (headers) {
            try {
                dbHeaders = typeof headers === 'object' ? JSON.stringify(headers) : headers;
                if (typeof dbHeaders === 'string') JSON.parse(dbHeaders);
            } catch (e) {
                dbHeaders = null;
            }
        }

        const result = await request.server.db.query(
            `INSERT INTO monitors (user_id, name, type, category, target, keyword, interval_seconds, method, headers, body, timeout_ms, max_retries, expected_status, threshold_ms, region, priority, assertion_config)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) 
             RETURNING id, name, type, category, target, keyword, interval_seconds, method, headers, body, timeout_ms, max_retries, expected_status, threshold_ms, region, status, priority, assertion_config, created_at`,
            [userId, name, type, category, target, keyword ?? null, effectiveInterval, method || 'GET', dbHeaders, body || null, timeout_ms || 10000, max_retries || 3, expected_status || '200-399', threshold_ms || 0, region || 'Global', priority || 'medium', assertion_config ? JSON.stringify(assertion_config) : null]
        );
        const monitor = result.rows[0];

        try {
            await Promise.race([
                scheduleMonitor(monitor),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Queue timeout (Redis unresponsive)')), 5000))
            ]);
        } catch (queueError) {
            request.log.error(queueError, `Queue failed for monitor ${monitor.id}`);
        }
        
        return reply.code(201).send(monitor);
    } catch (error) {
        request.log.error(error, 'createMonitor error');
        return reply.code(500).send({ error: 'Failed to create monitor' });
    }
};

// ── List ──────────────────────────────────────────────────────────────────
const getMonitors = async (request, reply) => {
    const userId = request.user.id;
    const page   = Math.max(1, parseInt(request.query.page  || '1',  10));
    const limit  = Math.min(100, parseInt(request.query.limit || '50', 10));
    const offset = (page - 1) * limit;

    try {
        const result = await request.server.db.query(
            `SELECT m.*,
                    (SELECT recorded_at FROM monitor_metrics WHERE monitor_id = m.id ORDER BY recorded_at DESC LIMIT 1) as last_checked,
                    (SELECT ROUND(AVG(response_time_ms)) FROM monitor_metrics WHERE monitor_id = m.id AND recorded_at > NOW() - INTERVAL '24 hours') as avg_latency,
                    (SELECT ROUND(CAST(COUNT(*) FILTER (WHERE status = 'up') AS NUMERIC) / GREATEST(COUNT(*), 1) * 100, 2) 
                     FROM monitor_metrics WHERE monitor_id = m.id AND recorded_at > NOW() - INTERVAL '24 hours') as uptime
             FROM monitors m WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            [userId, limit, offset]
        );
        return reply.send(result.rows);
    } catch (error) {
        request.log.error(error, 'getMonitors error');
        return reply.code(500).send({ error: 'Failed to fetch monitors' });
    }
};

// ── Update ────────────────────────────────────────────────────────────────
const updateMonitor = async (request, reply) => {
    const { id } = request.params;
    const userId = request.user.id;
    const parsed = UpdateMonitorSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0].message });
    }

    try {
        const { name, target, keyword, interval_seconds, method, headers, body, timeout_ms, max_retries, expected_status, threshold_ms, region, priority, assertion_config } = parsed.data;
        
        let dbHeaders = undefined;
        if (headers !== undefined) {
            dbHeaders = typeof headers === 'object' ? JSON.stringify(headers) : headers;
        }

        const updates = [];
        const values = [id, userId];
        let idx = 3;

        if (name) { updates.push(`name = $${idx++}`); values.push(name); }
        if (target) { updates.push(`target = $${idx++}`); values.push(target); }
        if (keyword !== undefined) { updates.push(`keyword = $${idx++}`); values.push(keyword); }
        if (interval_seconds) { updates.push(`interval_seconds = $${idx++}`); values.push(usageService.getEffectiveInterval(request.user, interval_seconds)); }
        if (method) { updates.push(`method = $${idx++}`); values.push(method); }
        if (dbHeaders !== undefined) { updates.push(`headers = $${idx++}`); values.push(dbHeaders); }
        if (body !== undefined) { updates.push(`body = $${idx++}`); values.push(body); }
        if (timeout_ms !== undefined) { updates.push(`timeout_ms = $${idx++}`); values.push(timeout_ms); }
        if (max_retries !== undefined) { updates.push(`max_retries = $${idx++}`); values.push(max_retries); }
        if (expected_status !== undefined) { updates.push(`expected_status = $${idx++}`); values.push(expected_status); }
        if (threshold_ms !== undefined) { updates.push(`threshold_ms = $${idx++}`); values.push(threshold_ms); }
        if (region) { updates.push(`region = $${idx++}`); values.push(region); }
        if (priority) { updates.push(`priority = $${idx++}`); values.push(priority); }
        if (assertion_config !== undefined) { updates.push(`assertion_config = $${idx++}`); values.push(assertion_config ? JSON.stringify(assertion_config) : null); }

        if (updates.length === 0) return reply.send({ message: 'No changes provided' });

        const result = await request.server.db.query(
            `UPDATE monitors SET ${updates.join(', ')} WHERE id = $1 AND user_id = $2 
             RETURNING id, name, type, category, target, keyword, interval_seconds, method, headers, body, timeout_ms, max_retries, expected_status, threshold_ms, region, status, priority, assertion_config`,
            values
        );
        if (result.rowCount === 0) return reply.code(404).send({ error: 'Monitor not found' });
        
        const monitor = result.rows[0];

        if (interval_seconds) {
            try {
                await unscheduleMonitor(id);
                await scheduleMonitor(monitor);
            } catch (qErr) {
                request.log.warn(qErr, `Failed to reschedule monitor ${id}`);
            }
        }

        return reply.send(monitor);
    } catch (error) {
        request.log.error(error, 'updateMonitor error');
        return reply.code(500).send({ error: 'Failed to update monitor' });
    }
};

// ── Delete ────────────────────────────────────────────────────────────────
const deleteMonitor = async (request, reply) => {
    const { id } = request.params;
    const userId = request.user.id;

    try {
        const result = await request.server.db.query(
            'DELETE FROM monitors WHERE id = $1 AND user_id = $2 RETURNING id, interval_seconds',
            [id, userId]
        );
        if (result.rowCount === 0) {
            return reply.code(404).send({ error: 'Monitor not found or unauthorized' });
        }

        try {
            await unscheduleMonitor(id);
        } catch (qErr) {
            request.log.warn(qErr, `Could not remove queue job for monitor ${id}`);
        }

        return reply.send({ message: 'Monitor deleted successfully' });
    } catch (error) {
        request.log.error(error, 'deleteMonitor error');
        return reply.code(500).send({ error: 'Failed to delete monitor' });
    }
};

// ── Metrics ───────────────────────────────────────────────────────────────
const getMonitorMetrics = async (request, reply) => {
    const { id } = request.params;
    const userId = request.user.id;

    try {
        const verify = await request.server.db.query(
            'SELECT id, name, type, target, keyword, interval_seconds, method, headers, body, timeout_ms, max_retries, expected_status, threshold_ms, region, status, priority, assertion_config FROM monitors WHERE id = $1 AND user_id = $2',
            [id, userId]
        );
        if (verify.rows.length === 0) return reply.code(404).send({ error: 'Monitor not found' });

        const { range } = request.query;
        let limit = 60;
        if (range === '24h') limit = 288; // roughly 24h at 5min interval
        if (range === '7d') limit = 2016; // roughly 7d at 5min interval

        const res = await request.server.db.query(
            `SELECT TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'HH24:MI:SS') AS time,
                    response_time_ms, status
             FROM monitor_metrics
             WHERE monitor_id = $1
             ORDER BY recorded_at DESC
             LIMIT $2`,
            [id, limit]
        );

        const metrics = res.rows.reverse();
        
        // ── Uptime Calculation Logic ──────────────────────────────────────────
        let uptime = 100;
        let avgResponseTime = 0;
        if (metrics.length > 0) {
            const upCount = metrics.filter(m => m.status === 'up').length;
            uptime = parseFloat(((upCount / metrics.length) * 100).toFixed(2));
            
            const totalTime = metrics.reduce((acc, curr) => acc + (curr.response_time_ms || 0), 0);
            avgResponseTime = Math.round(totalTime / metrics.length);
        }

        return reply.send({ 
            monitor: verify.rows[0], 
            metrics,
            stats: { uptime, avgResponseTime }
        });
    } catch (error) {
        request.log.error(error, 'getMonitorMetrics error');
        return reply.code(500).send({ error: 'Failed to fetch monitor metrics' });
    }
};

const getMonitorLogs = async (request, reply) => {
    const { id } = request.params;
    const userId = request.user.id;
    const page   = Math.max(1, parseInt(request.query.page  || '1',  10));
    const limit  = Math.min(100, parseInt(request.query.limit || '20', 10));
    const offset = (page - 1) * limit;

    try {
        // Verify ownership
        const verify = await request.server.db.query('SELECT id FROM monitors WHERE id = $1 AND user_id = $2', [id, userId]);
        if (verify.rows.length === 0) return reply.code(404).send({ error: 'Monitor not found' });

        const res = await request.server.db.query(
            `SELECT recorded_at, status, response_time_ms, status_code, error_message
             FROM monitor_metrics
             WHERE monitor_id = $1
             ORDER BY recorded_at DESC
             LIMIT $2 OFFSET $3`,
            [id, limit, offset]
        );

        return reply.send(res.rows);
    } catch (error) {
        request.log.error(error, 'getMonitorLogs error');
        return reply.code(500).send({ error: 'Failed to fetch monitor logs' });
    }
};

// ── Incidents ─────────────────────────────────────────────────────────────
const getIncidents = async (request, reply) => {
    const userId = request.user.id;
    try {
        const res = await request.server.db.query(
            `SELECT i.id, i.monitor_id, m.name AS monitor_name, m.target,
                    i.started_at, i.resolved_at, i.error_message
             FROM incidents i
             JOIN monitors m ON m.id = i.monitor_id
             WHERE m.user_id = $1
             ORDER BY i.started_at DESC
             LIMIT 50`,
            [userId]
        );
        return reply.send(res.rows);
    } catch (error) {
        request.log.error(error, 'getIncidents error');
        return reply.code(500).send({ error: 'Failed to fetch incidents' });
    }
};

// ── Manual Tester ─────────────────────────────────────────────────────────
const testMonitor = async (request, reply) => {
    const { target, type, method, headers, body } = request.body;
    if (!target) return reply.code(400).send({ error: 'Target URL is required' });
    
    const ssrfError = validateTarget(type || 'http', target);
    if (ssrfError) return reply.code(400).send({ error: ssrfError });
    
    const startTime = Date.now();
    try {
        let parsedHeaders = {};
        if (headers) {
            try { 
                parsedHeaders = typeof headers === 'string' ? JSON.parse(headers) : headers; 
            } catch (e) {
                // If it's not JSON, it might be a malformed string from a partially configured UI
                request.log.warn(`Failed to parse headers: ${headers}`);
            }
        }

        const res = await axios({
            url: target,
            method: method || 'GET',
            headers: { 
                ...parsedHeaders, 
                'User-Agent': 'MonitorHub-Tester/2.0',
                'Accept': '*/*'
            },
            data: body,
            timeout: 15000, // Increased to 15s for slower APIs
            validateStatus: () => true, // Don't throw on any status code
            maxRedirects: 5,
            maxContentLength: 5 * 1024 * 1024, // 5MB limit
            responseType: 'text', // Get raw text to calculate size accurately
            transformResponse: [(data) => data] // Don't auto-parse JSON on backend so we can control it on frontend
        });
        
        const time = Date.now() - startTime;
        const size = Buffer.byteLength(res.data || '', 'utf8');

        // Try to determine if it's JSON for the frontend hint
        let isJson = false;
        try {
            if (res.headers['content-type']?.includes('application/json')) {
                isJson = true;
            } else {
                JSON.parse(res.data);
                isJson = true;
            }
        } catch (e) {}

        return reply.send({
            success: res.status >= 200 && res.status < 400,
            status: res.status,
            statusText: res.statusText || 'OK',
            time,
            size,
            isJson,
            headers: res.headers,
            data: res.data 
        });
    } catch (err) {
        const time = Date.now() - startTime;
        const isTimeout = err.code === 'ECONNABORTED';
        const isNetworkError = !err.response;

        return reply.send({ 
            success: false, 
            status: err.response ? err.response.status : 0, 
            statusText: err.response ? err.response.statusText : 'Network Error',
            time, 
            size: 0,
            error: isTimeout ? 'Request timeout (15s exceeded)' : (isNetworkError ? `Connection failed: ${err.message}` : err.message),
            data: err.response ? err.response.data : null,
            headers: err.response ? err.response.headers : {}
        });
    }
};

// ── Toggle Status (Pause/Resume) ──────────────────────────────────────────
const toggleMonitorStatus = async (request, reply) => {
    const { id } = request.params;
    const { action } = request.body; 
    const userId = request.user.id;
    if (!['pause', 'resume'].includes(action)) {
        return reply.code(400).send({ error: 'Invalid action. Use "pause" or "resume".' });
    }
    try {
        const newStatus = action === 'pause' ? 'paused' : 'pending';
        const result = await request.server.db.query(
            'UPDATE monitors SET status = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
            [newStatus, id, userId]
        );
        if (result.rowCount === 0) return reply.code(404).send({ error: 'Monitor not found' });
        const monitor = result.rows[0];
        if (action === 'pause') {
            await unscheduleMonitor(id);
        } else {
            try {
                await usageService.checkLimit(request.server.db, request.user, monitor.category);
                await scheduleMonitor(monitor);
            } catch (limitErr) {
                await request.server.db.query('UPDATE monitors SET status = $1 WHERE id = $2', ['paused', id]);
                return reply.code(403).send({ error: `Cannot resume: ${limitErr.message}`, upgradeRequired: true });
            }
        }
        return reply.send({ message: `Monitor ${action}d successfully`, monitor });
    } catch (error) {
        request.log.error(error, 'toggleMonitorStatus error');
        return reply.code(500).send({ error: `Failed to ${action} monitor` });
    }
};

module.exports = { createMonitor, getMonitors, updateMonitor, deleteMonitor, getMonitorMetrics, getMonitorLogs, getIncidents, testMonitor, toggleMonitorStatus };
