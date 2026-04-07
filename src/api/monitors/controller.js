const { monitorQueue } = require('../../core/queue/setup');
const { z } = require('zod');

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
    target:           z.string().min(1).max(500),
    keyword:          z.string().max(255).optional().nullable(),
    interval_seconds: z.number().int().min(30).max(86400).default(300),
});

// ── Create ────────────────────────────────────────────────────────────────
const createMonitor = async (request, reply) => {
    const parsed = CreateMonitorSchema.safeParse(request.body);
    if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0].message });
    }

    const { name, type, target, keyword, interval_seconds } = parsed.data;
    const userId = request.user.id;

    // SSRF check
    const ssrfError = validateTarget(type, target);
    if (ssrfError) return reply.code(400).send({ error: ssrfError });

    try {
        const result = await request.server.db.query(
            `INSERT INTO monitors (user_id, name, type, target, keyword, interval_seconds)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, type, target, keyword, interval_seconds, status, created_at`,
            [userId, name, type, target, keyword ?? null, interval_seconds]
        );
        const monitor = result.rows[0];

        // Add repeatable BullMQ job
        await monitorQueue.add(
            `check-${monitor.id}`,
            { monitorId: monitor.id, type: monitor.type, target: monitor.target },
            {
                repeat:  { every: interval_seconds * 1000 },
                jobId:   `monitor-${monitor.id}`,
                removeOnComplete: { count: 10 },
                removeOnFail:     { count: 50 },
            }
        );

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
            `SELECT id, name, type, target, keyword, interval_seconds, status, created_at
             FROM monitors WHERE user_id = $1
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
    const { name, interval_seconds } = request.body || {};

    if (!name && !interval_seconds) {
        return reply.code(400).send({ error: 'Nothing to update' });
    }
    if (interval_seconds && (interval_seconds < 30 || interval_seconds > 86400)) {
        return reply.code(400).send({ error: 'Interval must be between 30 and 86400 seconds' });
    }

    try {
        const result = await request.server.db.query(
            `UPDATE monitors SET
               name             = COALESCE($1, name),
               interval_seconds = COALESCE($2, interval_seconds)
             WHERE id = $3 AND user_id = $4
             RETURNING id, name, type, target, keyword, interval_seconds, status`,
            [name || null, interval_seconds || null, id, userId]
        );
        if (result.rowCount === 0) return reply.code(404).send({ error: 'Monitor not found' });
        return reply.send(result.rows[0]);
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

        // Remove the repeatable BullMQ job — use the jobId we set during creation
        try {
            const repeatableJobs = await monitorQueue.getRepeatableJobs();
            const job = repeatableJobs.find(j => j.id === `monitor-${id}`);
            if (job) await monitorQueue.removeRepeatableByKey(job.key);
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
        // Ownership check (cheap — only select id)
        const verify = await request.server.db.query(
            'SELECT id, name, type, target, keyword, interval_seconds, status FROM monitors WHERE id = $1 AND user_id = $2',
            [id, userId]
        );
        if (verify.rows.length === 0) return reply.code(404).send({ error: 'Monitor not found' });

        const res = await request.server.db.query(
            `SELECT TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'HH24:MI:SS') AS time,
                    response_time_ms, status
             FROM monitor_metrics
             WHERE monitor_id = $1
             ORDER BY recorded_at DESC
             LIMIT 60`,
            [id]
        );

        return reply.send({ monitor: verify.rows[0], metrics: res.rows.reverse() });
    } catch (error) {
        request.log.error(error, 'getMonitorMetrics error');
        return reply.code(500).send({ error: 'Failed to fetch monitor metrics' });
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

module.exports = { createMonitor, getMonitors, updateMonitor, deleteMonitor, getMonitorMetrics, getIncidents };
