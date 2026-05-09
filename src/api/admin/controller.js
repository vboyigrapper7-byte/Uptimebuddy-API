/**
 * Admin Controller
 */
const { revokeAdminToken, ADMIN_PASSWORD } = require('./middleware');
const { PLAN_TIERS } = require('../../core/billing/tiers');
const auditService = require('../../core/admin/auditService');



const login = async (request, reply) => {
    const { password } = request.body;
    
    if (password !== ADMIN_PASSWORD) {
        return reply.status(401).send({ error: 'Invalid admin credentials' });
    }
    
    // Issue a JWT token valid for 12 hours
    const token = await reply.jwtSign({ 
        isAdmin: true, 
        email: ADMIN_PASSWORD, // Using the email/identifier from config
        role: 'superadmin'
    }, { 
        expiresIn: '12h' 
    });

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
        
        const oldUserRes = await db.query('SELECT tier, role FROM users WHERE id = $1', [id]);
        const oldUser = oldUserRes.rows[0];

        await db.query(
            'UPDATE users SET tier = COALESCE($1, tier), role = COALESCE($2, role) WHERE id = $3',
            [tier, role, id]
        );

        // Audit Log
        await auditService.logAction(db, {
            adminId: request.user?.id, // Assuming request.user is populated if admin is a user too
            action: 'USER_UPDATE',
            entityType: 'user',
            entityId: id,
            oldValue: oldUser,
            newValue: { tier, role },
            ipAddress: request.ip,
            userAgent: request.headers['user-agent']
        });

        
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
        
        const userRes = await db.query('SELECT email FROM users WHERE id = $1', [id]);
        const userEmail = userRes.rows[0]?.email;

        // Due to foreign keys with CASCADE, deleting a user deletes their monitors, alerts, etc.
        await db.query('DELETE FROM users WHERE id = $1', [id]);
        
        // Audit Log
        await auditService.logAction(db, {
            adminId: request.user?.id,
            action: 'USER_DELETE',
            entityType: 'user',
            entityId: id,
            oldValue: { email: userEmail },
            ipAddress: request.ip,
            userAgent: request.headers['user-agent']
        });

        
        return reply.send({ success: true, message: 'User deleted successfully' });
    } catch (err) {
        request.log.error('Admin Delete User Error:', err);
        return reply.status(500).send({ error: 'Failed to delete user' });
    }
};

const impersonate = async (request, reply) => {
    try {
        const db = request.server.db;
        const { id } = request.params;

        // 1. Verify target user exists
        const userRes = await db.query('SELECT id, email FROM users WHERE id = $1', [id]);
        if (userRes.rows.length === 0) {
            return reply.status(404).send({ error: 'Target user not found' });
        }
        const user = userRes.rows[0];

        // 2. Generate Impersonation Token (1 hour expiry)
        const token = await reply.jwtSign({
            impersonation: true,
            targetUserId: user.id,
            adminId: request.user?.id || 'admin',
            role: 'customer' // The role they will act as
        }, {
            expiresIn: '1h'
        });

        // 3. Audit Log
        await auditService.logAction(db, {
            adminId: request.user?.id || 'admin',
            userId: user.id,
            action: 'USER_IMPERSONATION_START',
            entityType: 'user',
            entityId: user.id,
            ipAddress: request.ip,
            userAgent: request.headers['user-agent']
        });

        return reply.send({
            success: true,
            token,
            redirect: '/dashboard'
        });
    } catch (err) {
        request.log.error('Admin Impersonate Error:', err);
        return reply.status(500).send({ error: 'Failed to generate impersonation session' });
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
            SELECT a.id, a.name, a.status, a.last_seen, u.email as user_email 
            FROM agents a
            JOIN users u ON a.user_id = u.id
            ORDER BY a.id DESC LIMIT $1 OFFSET $2
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

const getRevenueAnalytics = async (request, reply) => {
    try {
        const db = request.server.db;

        // 1. Calculate MRR (Monthly Recurring Revenue) based on current active tiers
        const userTiersRes = await db.query(`
            SELECT tier, COUNT(*) as count 
            FROM users 
            WHERE tier != 'free' 
              AND (plan_expiry > NOW() OR subscription_id IS NOT NULL)
            GROUP BY tier
        `);

        let mrr = 0;
        const mrrByTier = {};
        userTiersRes.rows.forEach(row => {
            const plan = PLAN_TIERS[row.tier];
            if (plan) {
                const tierMrr = (plan.priceUSD || 0) * parseInt(row.count);
                mrr += tierMrr;
                mrrByTier[row.tier] = {
                    count: parseInt(row.count),
                    mrr: tierMrr
                };
            }
        });

        // 2. Transaction Totals
        const statsRes = await db.query(`
            SELECT 
                COUNT(*) as total_tx,
                SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END) as total_revenue,
                COUNT(CASE WHEN status = 'paid' THEN 1 END) as paid_count,
                COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_count,
                SUM(CASE WHEN status = 'paid' AND created_at > NOW() - INTERVAL '30 days' THEN amount ELSE 0 END) as monthly_revenue
            FROM transactions
        `);
        const stats = statsRes.rows[0];

        // 3. Revenue Trend (Last 7 days)
        const trendRes = await db.query(`
            SELECT 
                DATE(created_at) as date,
                SUM(amount) as daily_revenue
            FROM transactions
            WHERE status = 'paid' AND created_at > NOW() - INTERVAL '7 days'
            GROUP BY DATE(created_at)
            ORDER BY DATE(created_at) ASC
        `);

        // 4. Recent Transactions
        const recentRes = await db.query(`
            SELECT t.*, u.email 
            FROM transactions t
            JOIN users u ON t.user_id = u.id
            ORDER BY t.created_at DESC
            LIMIT 10
        `);

        return reply.send({
            mrr,
            mrrByTier,
            totalRevenue: parseInt(stats.total_revenue) / 100, // Cents to USD
            monthlyRevenue: parseInt(stats.monthly_revenue) / 100,
            transactionHealth: {
                total: parseInt(stats.total_tx),
                paid: parseInt(stats.paid_count),
                failed: parseInt(stats.failed_count),
                successRate: stats.total_tx > 0 ? (parseInt(stats.paid_count) / parseInt(stats.total_tx)) * 100 : 0
            },
            revenueTrend: trendRes.rows.map(r => ({
                date: r.date,
                revenue: parseInt(r.daily_revenue) / 100
            })),
            recentTransactions: recentRes.rows.map(r => ({
                ...r,
                amount: parseInt(r.amount) / 100
            }))
        });
    } catch (err) {
        request.log.error('Admin Revenue Analytics Error:', err);
        return reply.status(500).send({ error: 'Failed to fetch revenue analytics' });
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
    getSystemLogs,
    impersonate,
    getRevenueAnalytics
};


