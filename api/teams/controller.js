const pool = require('../../core/db/pool');
const auditService = require('../../core/auth/auditService');

const getMembers = async (request, reply) => {
    try {
        // Find teams where user is owner or member
        let teamsRes = await pool.query('SELECT team_id FROM team_members WHERE user_id = $1', [request.user.id]);
        let teamId;
        
        if (teamsRes.rows.length === 0) {
            // Auto-create a default team for this user
            const newTeam = await pool.query('INSERT INTO teams (name, owner_id) VALUES ($1, $2) RETURNING id', ['My Team', request.user.id]);
            teamId = newTeam.rows[0].id;
            await pool.query('INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)', [teamId, request.user.id, 'owner']);
        } else {
            teamId = teamsRes.rows[0].team_id;
        }

        const res = await pool.query(
            `SELECT u.email, tm.role, tm.user_id, tm.team_id
             FROM team_members tm
             JOIN users u ON tm.user_id = u.id
             WHERE tm.team_id = $1`,
            [teamId]
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

const removeMember = async (request, reply) => {
    const { userId, teamId } = request.body;
    try {
        // Ensure requester is owner/admin
        const callerRes = await pool.query('SELECT role FROM team_members WHERE user_id = $1 AND team_id = $2', [request.user.id, teamId]);
        if (callerRes.rows.length === 0 || !['owner', 'admin'].includes(callerRes.rows[0].role)) {
            return reply.status(403).send({ error: 'Permission denied' });
        }

        // Prevent removing the owner
        const targetRes = await pool.query('SELECT role, (SELECT email FROM users WHERE id = $1) as email FROM team_members WHERE user_id = $1 AND team_id = $2', [userId, teamId]);
        if (targetRes.rows.length > 0 && targetRes.rows[0].role === 'owner') {
            return reply.status(400).send({ error: 'Cannot remove team owner' });
        }

        await pool.query('DELETE FROM team_members WHERE user_id = $1 AND team_id = $2', [userId, teamId]);
        
        if (targetRes.rows.length > 0) {
            await auditService.log(request.user.id, teamId, 'member_removed', { removed_email: targetRes.rows[0].email });
        }

        return reply.send({ success: true });
    } catch (err) {
        return reply.status(500).send({ error: err.message });
    }
};

module.exports = { getMembers, inviteMember, removeMember };
