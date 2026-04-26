const pool = require('../../core/db/pool');
const auditService = require('../../core/auth/auditService');

const getMembers = async (request, reply) => {
    try {
        // Find teams where user is owner or member
        const res = await pool.query(
            `SELECT u.email, tm.role, tm.user_id
             FROM team_members tm
             JOIN users u ON tm.user_id = u.id
             WHERE tm.team_id IN (SELECT team_id FROM team_members WHERE user_id = $1)`,
            [request.user.id]
        );
        return reply.send(res.rows);
    } catch (err) {
        return reply.status(500).send({ error: err.message });
    }
};

const inviteMember = async (request, reply) => {
    const { email, role, teamId } = request.body;
    try {
        // Find user by email
        const userRes = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (userRes.rows.length === 0) return reply.status(404).send({ error: 'User not found' });

        const userId = userRes.rows[0].id;

        // Add to team
        await pool.query(
            'INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [teamId, userId, role || 'member']
        );

        // Audit Log
        await auditService.log(request.user.id, teamId, 'member_invited', { invited_email: email, role });

        return reply.send({ success: true });
    } catch (err) {
        return reply.status(500).send({ error: err.message });
    }
};

module.exports = { getMembers, inviteMember };
