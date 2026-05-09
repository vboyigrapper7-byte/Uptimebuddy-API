/**
 * Admin Controller
 */
const { generateAdminToken, revokeAdminToken, ADMIN_PASSWORD } = require('./middleware');

const login = async (request, reply) => {
    const { password } = request.body;
    
    if (password !== ADMIN_PASSWORD) {
        return reply.status(401).send({ error: 'Invalid admin credentials' });
    }
    
    const token = generateAdminToken();
    return reply.send({ success: true, token });
};

const logout = async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split('Bearer ')[1];
        revokeAdminToken(token);
    }
    return reply.send({ success: true });
};

const getOverview = async (request, reply) => {
    try {
        const db = request.server.db;
        
        // Users stats
        const usersRes = await db.query('SELECT COUNT(*) as total FROM users');
        const totalUsers = parseInt(usersRes.rows[0].total, 10);
        
        // Plans distribution
        const plansRes = await db.query('SELECT tier, COUNT(*) as count FROM users GROUP BY tier');
        const plans = plansRes.rows;
        
        // Monitors stats
        const uptimeMonitorsRes = await db.query("SELECT COUNT(*) as total FROM monitors WHERE category = 'uptime' OR category IS NULL");
        const apiMonitorsRes = await db.query("SELECT COUNT(*) as total FROM monitors WHERE category = 'api'");
        const serverMonitorsRes = await db.query('SELECT COUNT(*) as total FROM agents');
        
        // Incidents/Alerts stats
        const incidentsRes = await db.query('SELECT COUNT(*) as total FROM incidents WHERE resolved_at IS NULL');
        
        return reply.send({
            success: true,
            stats: {
                totalUsers,
                plans,
                monitors: {
                    uptime: parseInt(uptimeMonitorsRes.rows[0].total, 10),
                    api: parseInt(apiMonitorsRes.rows[0].total, 10),
                    servers: parseInt(serverMonitorsRes.rows[0].total, 10)
                },
                activeIncidents: parseInt(incidentsRes.rows[0].total, 10)
            }
        });
    } catch (err) {
        request.log.error('Admin Overview Error:', err);
        return reply.status(500).send({ error: 'Failed to fetch overview statistics' });
    }
};

const getUsers = async (request, reply) => {
    try {
        const db = request.server.db;
        const page = parseInt(request.query.page) || 1;
        const limit = parseInt(request.query.limit) || 50;
        const offset = (page - 1) * limit;
        const search = request.query.search || '';
        
        let query = 'SELECT id, email, name, role, tier, created_at, plan_expiry FROM users';
        let countQuery = 'SELECT COUNT(*) as total FROM users';
        let params = [];
        
        if (search) {
            query += ' WHERE email ILIKE $1 OR name ILIKE $1';
            countQuery += ' WHERE email ILIKE $1 OR name ILIKE $1';
            params.push(`%${search}%`);
        }
        
        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        const dataParams = [...params, limit, offset];
        
        const countRes = await db.query(countQuery, params);
        const usersRes = await db.query(query, dataParams);
        
        // Get monitor counts for these users
        const users = usersRes.rows;
        for (let user of users) {
            const mCount = await db.query('SELECT COUNT(*) as total FROM monitors WHERE user_id = $1', [user.id]);
            const aCount = await db.query('SELECT COUNT(*) as total FROM agents WHERE user_id = $1', [user.id]);
            user.monitorCount = parseInt(mCount.rows[0].total, 10) + parseInt(aCount.rows[0].total, 10);
        }
        
        return reply.send({
            success: true,
            users,
            total: parseInt(countRes.rows[0].total, 10),
            page,
            limit
        });
    } catch (err) {
        request.log.error('Admin Get Users Error:', err);
        return reply.status(500).send({ error: 'Failed to fetch users' });
    }
};

const getUserDetails = async (request, reply) => {
    try {
        const db = request.server.db;
        const { id } = request.params;
        
        const userRes = await db.query('SELECT id, email, name, role, tier, created_at, plan_expiry, status_slug FROM users WHERE id = $1', [id]);
        if (userRes.rows.length === 0) return reply.status(404).send({ error: 'User not found' });
        
        const user = userRes.rows[0];
        
        const mRes = await db.query('SELECT id, name, type, category, status, target, created_at FROM monitors WHERE user_id = $1', [id]);
        const aRes = await db.query('SELECT id, name, status, hostname, public_ip, created_at FROM agents WHERE user_id = $1', [id]);
        
        return reply.send({
            success: true,
            user,
            monitors: mRes.rows,
            agents: aRes.rows
        });
    } catch (err) {
        request.log.error('Admin Get User Details Error:', err);
        return reply.status(500).send({ error: 'Failed to fetch user details' });
    }
};

const updateUser = async (request, reply) => {
    try {
        const db = request.server.db;
        const { id } = request.params;
        const { tier, role } = request.body;
        
        await db.query(
            'UPDATE users SET tier = COALESCE($1, tier), role = COALESCE($2, role), updated_at = NOW() WHERE id = $3',
            [tier, role, id]
        );
        
        return reply.send({ success: true, message: 'User updated successfully' });
    } catch (err) {
        request.log.error('Admin Update User Error:', err);
        return reply.status(500).send({ error: 'Failed to update user' });
    }
};

const deleteUser = async (request, reply) => {
    try {
        const db = request.server.db;
        const { id } = request.params;
        
        // Due to foreign keys with CASCADE, deleting a user deletes their monitors, alerts, etc.
        await db.query('DELETE FROM users WHERE id = $1', [id]);
        
        return reply.send({ success: true, message: 'User deleted successfully' });
    } catch (err) {
        request.log.error('Admin Delete User Error:', err);
        return reply.status(500).send({ error: 'Failed to delete user' });
    }
};

const getMonitors = async (request, reply) => {
    try {
        const db = request.server.db;
        const page = parseInt(request.query.page) || 1;
        const limit = parseInt(request.query.limit) || 50;
        const offset = (page - 1) * limit;
        const search = request.query.search || '';
        
        let query = `
            SELECT m.id, m.name, m.type, m.category, m.status, m.target, m.created_at, u.email as user_email 
            FROM monitors m
            JOIN users u ON m.user_id = u.id
        `;
        let countQuery = `
            SELECT COUNT(*) as total 
            FROM monitors m
            JOIN users u ON m.user_id = u.id
        `;
        let params = [];
        
        if (search) {
            query += ' WHERE m.name ILIKE $1 OR m.target ILIKE $1 OR u.email ILIKE $1';
            countQuery += ' WHERE m.name ILIKE $1 OR m.target ILIKE $1 OR u.email ILIKE $1';
            params.push(`%${search}%`);
        }
        
        query += ` ORDER BY m.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        const dataParams = [...params, limit, offset];
        
        const countRes = await db.query(countQuery, params);
        const monitorsRes = await db.query(query, dataParams);
        
        return reply.send({
            success: true,
            monitors: monitorsRes.rows,
            total: parseInt(countRes.rows[0].total, 10),
            page,
            limit
        });
    } catch (err) {
        request.log.error('Admin Get Monitors Error:', err);
        return reply.status(500).send({ error: 'Failed to fetch monitors' });
    }
};

const getAgents = async (request, reply) => {
    try {
        const db = request.server.db;
        const page = parseInt(request.query.page) || 1;
        const limit = parseInt(request.query.limit) || 50;
        const offset = (page - 1) * limit;
        
        const query = `
            SELECT a.id, a.name, a.status, a.hostname, a.public_ip, a.os, a.last_seen, a.created_at, u.email as user_email 
            FROM agents a
            JOIN users u ON a.user_id = u.id
            ORDER BY a.created_at DESC LIMIT $1 OFFSET $2
        `;
        const countQuery = 'SELECT COUNT(*) as total FROM agents';
        
        const countRes = await db.query(countQuery);
        const agentsRes = await db.query(query, [limit, offset]);
        
        return reply.send({
            success: true,
            agents: agentsRes.rows,
            total: parseInt(countRes.rows[0].total, 10),
            page,
            limit
        });
    } catch (err) {
        request.log.error('Admin Get Agents Error:', err);
        return reply.status(500).send({ error: 'Failed to fetch agents' });
    }
};

const deleteMonitor = async (request, reply) => {
    try {
        const db = request.server.db;
        const { id } = request.params;
        await db.query('DELETE FROM monitors WHERE id = $1', [id]);
        return reply.send({ success: true, message: 'Monitor deleted successfully' });
    } catch (err) {
        request.log.error('Admin Delete Monitor Error:', err);
        return reply.status(500).send({ error: 'Failed to delete monitor' });
    }
};

const deleteAgent = async (request, reply) => {
    try {
        const db = request.server.db;
        const { id } = request.params;
        await db.query('DELETE FROM agents WHERE id = $1', [id]);
        return reply.send({ success: true, message: 'Agent deleted successfully' });
    } catch (err) {
        request.log.error('Admin Delete Agent Error:', err);
        return reply.status(500).send({ error: 'Failed to delete agent' });
    }
};

const getSystemLogs = async (request, reply) => {
    // A simplified system logs endpoint fetching recent incidents or alerts for the dashboard activity feed
    try {
        const db = request.server.db;
        const query = `
            SELECT i.id, i.status, i.started_at, i.resolved_at, m.name as monitor_name, u.email as user_email
            FROM incidents i
            LEFT JOIN monitors m ON i.monitor_id = m.id
            LEFT JOIN users u ON m.user_id = u.id
            ORDER BY i.started_at DESC LIMIT 50
        `;
        const res = await db.query(query);
        return reply.send({ success: true, logs: res.rows });
    } catch (err) {
        request.log.error('Admin Get Logs Error:', err);
        return reply.status(500).send({ error: 'Failed to fetch logs' });
    }
};


module.exports = {
    login,
    logout,
    getOverview,
    getUsers,
    getUserDetails,
    updateUser,
    deleteUser,
    getMonitors,
    getAgents,
    deleteMonitor,
    deleteAgent,
    getSystemLogs
};
