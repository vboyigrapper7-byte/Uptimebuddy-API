/**
 * Audit Service
 * Handles recording of administrative and critical user actions.
 */

async function logAction(db, {
    userId = null,
    adminId = null,
    action,
    entityType = null,
    entityId = null,
    oldValue = null,
    newValue = null,
    ipAddress = null,
    userAgent = null
}) {
    try {
        await db.query(`
            INSERT INTO audit_logs (
                user_id, admin_id, action, entity_type, entity_id, 
                old_value, new_value, ip_address, user_agent
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
            userId, 
            adminId, 
            action, 
            entityType, 
            entityId, 
            oldValue ? JSON.stringify(oldValue) : null, 
            newValue ? JSON.stringify(newValue) : null, 
            ipAddress, 
            userAgent
        ]);
    } catch (err) {
        console.error('[AuditService] Failed to record audit log:', err.message);
        // We don't throw here to avoid breaking the main request flow
    }
}

module.exports = { logAction };
