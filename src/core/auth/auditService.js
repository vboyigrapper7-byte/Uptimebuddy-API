const pool = require('../db/pool');
const logger = require('../utils/logger');

/**
 * Audit Log Service
 * Records critical user and system actions for accountability.
 */
class AuditService {
    /**
     * Record an action in the audit log.
     */
    async log(userId, teamId, action, metadata = {}) {
        try {
            await pool.query(
                'INSERT INTO audit_logs (user_id, team_id, action, metadata) VALUES ($1, $2, $3, $4)',
                [userId, teamId, action, JSON.stringify(metadata)]
            );
            logger.info(`[Audit] ${action} by user ${userId} in team ${teamId}`, { metadata });
        } catch (err) {
            logger.error(`[Audit] Failed to record action: ${err.message}`);
        }
    }

    /**
     * Fetch audit logs for a team.
     */
    async getTeamLogs(teamId, limit = 50) {
        const res = await pool.query(
            `SELECT a.*, u.email as user_email
             FROM audit_logs a
             LEFT JOIN users u ON a.user_id = u.id
             WHERE a.team_id = $1
             ORDER BY a.created_at DESC
             LIMIT $2`,
            [teamId, limit]
        );
        return res.rows;
    }
}

module.exports = new AuditService();
