const { monitorQueue } = require('../../core/queue/setup');
const { scheduleMonitor, unscheduleMonitor } = require('../../core/queue/scheduler');
const { z } = require('zod');
const axios = require('axios');
const tls = require('tls');
const usageService = require('../../core/auth/usageService');
const planService = require('../../core/billing/planService');
const { getSafeAxiosConfig } = require('../../core/utils/ssrf');

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
                    m.last_checked,
                    ms.avg_latency_24h as avg_latency,
                    ms.uptime_24h as uptime
             FROM monitors m 
             LEFT JOIN monitor_stats ms ON m.id = ms.monitor_id
             WHERE user_id = $1
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
            `SELECT m.*,
                    ms.uptime_24h as uptime_24h,
                    ms.avg_latency_24h as avg_latency_24h
             FROM monitors m 
             LEFT JOIN monitor_stats ms ON m.id = ms.monitor_id
             WHERE id = $1 AND user_id = $2`,
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

        return reply.send({ 
            monitor: verify.rows[0], 
            metrics,
            stats: { 
                uptime: verify.rows[0].uptime_24h || 100, 
                avgResponseTime: verify.rows[0].avg_latency_24h || 0 
            }
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
            `SELECT i.id, i.monitor_id, i.agent_id, 
                    COALESCE(m.name, a.name) AS monitor_name, 
                    COALESCE(m.target, a.hostname) AS target,
                    i.started_at, i.resolved_at, i.error_message
             FROM incidents i
             LEFT JOIN monitors m ON m.id = i.monitor_id
             LEFT JOIN agents a ON a.id = i.agent_id
             WHERE m.user_id = $1 OR a.user_id = $1
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

        const testMethod = (method || 'GET').toUpperCase();
        const hasBody = body && !['GET', 'HEAD', 'OPTIONS'].includes(testMethod);

        const finalHeaders = { 
            ...parsedHeaders, 
            'User-Agent': 'MonitorHub-Tester/2.0',
            'Accept': '*/*'
        };

        // Auto-set Content-Type if JSON body is detected and not already set
        if (hasBody && !finalHeaders['Content-Type'] && !finalHeaders['content-type']) {
            try {
                JSON.parse(body);
                finalHeaders['Content-Type'] = 'application/json';
            } catch (e) {
                // Not valid JSON, leave as is or default to text
                finalHeaders['Content-Type'] = 'text/plain';
            }
        }

        const res = await axios({
            url: target,
            method: testMethod,
            headers: finalHeaders,
            data: hasBody ? body : undefined,
            timeout: 15000, 
            validateStatus: () => true, 
            maxRedirects: 5,
            maxContentLength: 5 * 1024 * 1024, 
            responseType: 'text', 
            transformResponse: [(data) => data], 
            ...getSafeAxiosConfig() 
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

// ── SSL Certificate Details ───────────────────────────────────────────────
const getSSLDetails = async (request, reply) => {
    const { id } = request.params;
    const userId = request.user.id;

    // Plan gating: SSL monitoring is a paid feature
    if (!planService.canUseFeature(request.user, 'ssl_monitoring')) {
        return reply.code(403).send({
            error: 'SSL Monitoring is available on Starter, Pro, and Business plans.',
            upgradeRequired: true,
            billingUrl: '/dashboard/billing'
        });
    }

    try {
        const result = await request.server.db.query(
            `SELECT id, name, target, type, status,
                    ssl_expiry, ssl_valid_from, ssl_issuer, ssl_subject,
                    ssl_fingerprint, ssl_sans, ssl_protocol, ssl_cipher,
                    ssl_is_valid, ssl_error, last_ssl_check,
                    domain_expiry, last_domain_check
             FROM monitors
             WHERE id = $1 AND user_id = $2`,
            [id, userId]
        );

        if (result.rows.length === 0) {
            return reply.code(404).send({ error: 'Monitor not found' });
        }

        const monitor = result.rows[0];

        // Calculate days remaining
        let daysRemaining = null;
        let domainDaysRemaining = null;
        if (monitor.ssl_expiry) {
            daysRemaining = Math.floor((new Date(monitor.ssl_expiry) - new Date()) / (1000 * 60 * 60 * 24));
        }
        if (monitor.domain_expiry) {
            domainDaysRemaining = Math.floor((new Date(monitor.domain_expiry) - new Date()) / (1000 * 60 * 60 * 24));
        }

        // Parse SANs from JSON string
        let sans = [];
        if (monitor.ssl_sans) {
            try { sans = JSON.parse(monitor.ssl_sans); } catch (e) { sans = []; }
        }

        return reply.send({
            monitor_id: monitor.id,
            monitor_name: monitor.name,
            target: monitor.target,
            certificate: {
                is_valid: monitor.ssl_is_valid,
                error: monitor.ssl_error,
                issuer: monitor.ssl_issuer,
                subject: monitor.ssl_subject,
                valid_from: monitor.ssl_valid_from,
                valid_to: monitor.ssl_expiry,
                days_remaining: daysRemaining,
                fingerprint: monitor.ssl_fingerprint,
                sans: sans,
                protocol: monitor.ssl_protocol,
                cipher: monitor.ssl_cipher,
            },
            domain: {
                expiry: monitor.domain_expiry,
                days_remaining: domainDaysRemaining,
            },
            last_checked: monitor.last_ssl_check,
        });
    } catch (error) {
        request.log.error(error, 'getSSLDetails error');
        return reply.code(500).send({ error: 'Failed to fetch SSL details' });
    }
};

// ── On-Demand SSL Check ───────────────────────────────────────────────────
const triggerSSLCheck = async (request, reply) => {
    const { id } = request.params;
    const userId = request.user.id;

    // Plan gating: SSL monitoring is a paid feature
    if (!planService.canUseFeature(request.user, 'ssl_monitoring')) {
        return reply.code(403).send({
            error: 'SSL Monitoring is available on Starter, Pro, and Business plans.',
            upgradeRequired: true,
            billingUrl: '/dashboard/billing'
        });
    }

    try {
        const verify = await request.server.db.query(
            'SELECT id, name, target, type FROM monitors WHERE id = $1 AND user_id = $2',
            [id, userId]
        );
        if (verify.rows.length === 0) {
            return reply.code(404).send({ error: 'Monitor not found' });
        }

        const monitor = verify.rows[0];
        if (!monitor.target.startsWith('http')) {
            return reply.code(400).send({ error: 'Monitor target must be an HTTP/HTTPS URL for SSL checks' });
        }

        const url = new URL(monitor.target);
        const hostname = url.hostname;
        const port = url.port || 443;

        // Perform immediate SSL check
        const sslResult = await new Promise((resolve) => {
            try {
                const socket = tls.connect(port, hostname, { servername: hostname, rejectUnauthorized: false }, () => {
                    try {
                        const cert = socket.getPeerCertificate(true);
                        const authorized = socket.authorized;

                        if (cert && cert.valid_to) {
                            const expiryDate = new Date(cert.valid_to);
                            const validFrom = cert.valid_from ? new Date(cert.valid_from) : null;

                            // Format issuer/subject
                            const formatField = (f) => {
                                if (!f) return null;
                                if (typeof f === 'string') return f;
                                const parts = [];
                                if (f.CN) parts.push(`CN=${f.CN}`);
                                if (f.O) parts.push(`O=${f.O}`);
                                if (f.OU) parts.push(`OU=${f.OU}`);
                                if (f.C) parts.push(`C=${f.C}`);
                                return parts.length > 0 ? parts.join(', ') : JSON.stringify(f);
                            };

                            // Extract SANs
                            let sans = [];
                            if (cert.subjectaltname) {
                                sans = cert.subjectaltname.split(',').map(s => s.trim().replace(/^DNS:/i, '')).filter(Boolean);
                            }

                            const details = {
                                ssl_expiry: expiryDate,
                                ssl_valid_from: validFrom,
                                ssl_issuer: formatField(cert.issuer),
                                ssl_subject: formatField(cert.subject),
                                ssl_fingerprint: cert.fingerprint256 || cert.fingerprint || null,
                                ssl_sans: JSON.stringify(sans),
                                ssl_protocol: socket.getProtocol ? socket.getProtocol() : null,
                                ssl_cipher: socket.getCipher ? socket.getCipher().name : null,
                                ssl_is_valid: authorized && expiryDate > new Date(),
                                ssl_error: authorized ? null : (socket.authorizationError || 'Certificate validation failed'),
                            };

                            // Update DB
                            request.server.db.query(
                                `UPDATE monitors SET 
                                    ssl_expiry = $1, ssl_valid_from = $2, ssl_issuer = $3, ssl_subject = $4,
                                    ssl_fingerprint = $5, ssl_sans = $6, ssl_protocol = $7, ssl_cipher = $8,
                                    ssl_is_valid = $9, ssl_error = $10, last_ssl_check = NOW()
                                 WHERE id = $11`,
                                [
                                    details.ssl_expiry, details.ssl_valid_from, details.ssl_issuer, details.ssl_subject,
                                    details.ssl_fingerprint, details.ssl_sans, details.ssl_protocol, details.ssl_cipher,
                                    details.ssl_is_valid, details.ssl_error, monitor.id
                                ]
                            );

                            const daysRemaining = Math.floor((expiryDate - new Date()) / (1000 * 60 * 60 * 24));

                            resolve({
                                success: true,
                                certificate: {
                                    is_valid: details.ssl_is_valid,
                                    error: details.ssl_error,
                                    issuer: details.ssl_issuer,
                                    subject: details.ssl_subject,
                                    valid_from: details.ssl_valid_from,
                                    valid_to: details.ssl_expiry,
                                    days_remaining: daysRemaining,
                                    fingerprint: details.ssl_fingerprint,
                                    sans: sans,
                                    protocol: details.ssl_protocol,
                                    cipher: details.ssl_cipher,
                                },
                                checked_at: new Date().toISOString()
                            });
                        } else {
                            resolve({ success: false, error: 'No certificate found' });
                        }
                    } catch (parseErr) {
                        resolve({ success: false, error: `Certificate parse error: ${parseErr.message}` });
                    }
                    socket.end();
                });

                socket.on('error', (err) => {
                    request.server.db.query(
                        `UPDATE monitors SET ssl_is_valid = false, ssl_error = $1, last_ssl_check = NOW() WHERE id = $2`,
                        [err.message, monitor.id]
                    );
                    socket.destroy();
                    resolve({ success: false, error: `SSL connection failed: ${err.message}` });
                });

                socket.setTimeout(10000, () => {
                    socket.destroy();
                    resolve({ success: false, error: 'SSL connection timed out (10s)' });
                });
            } catch (e) {
                resolve({ success: false, error: e.message });
            }
        });

        return reply.send(sslResult);
    } catch (error) {
        request.log.error(error, 'triggerSSLCheck error');
        return reply.code(500).send({ error: 'Failed to perform SSL check' });
    }
};

module.exports = { createMonitor, getMonitors, updateMonitor, deleteMonitor, getMonitorMetrics, getMonitorLogs, getIncidents, testMonitor, toggleMonitorStatus, getSSLDetails, triggerSSLCheck };
