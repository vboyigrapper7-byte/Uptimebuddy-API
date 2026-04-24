const statusPageService = require('../../core/reporting/statusPageService');

const getPublicStatus = async (request, reply) => {
    const { slug } = request.params;

    if (!slug) return reply.code(400).send({ error: 'Slug is required' });

    try {
        const data = await statusPageService.getPublicStatus(slug);
        if (!data) {
            return reply.code(404).send({ error: 'Status page not found' });
        }

        return reply.send(data);
    } catch (error) {
        request.log.error(error, 'getPublicStatus error');
        return reply.code(500).send({ error: 'Failed to fetch status page data' });
    }
};

module.exports = { getPublicStatus };
