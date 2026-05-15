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

const getBlogs = async (request, reply) => {
    try {
        const db = request.server.db;
        const res = await db.query('SELECT * FROM blogs ORDER BY published_at DESC');

        // Format to match the static MDX format
        const blogs = res.rows.map(blog => ({
            slug: blog.slug,
            title: blog.title,
            date: blog.published_at instanceof Date ? blog.published_at.toISOString() : new Date(blog.published_at).toISOString(),
            category: blog.category,
            excerpt: blog.excerpt,
            content: blog.content,
            readingTime: Math.ceil((blog.content || '').split(' ').length / 200) + ' min read',
            author: {
                name: blog.author_name,
                role: blog.author_role,
                image: blog.author_image
            },
            coverImage: blog.cover_image,
            meta: {
                title: blog.meta_title,
                description: blog.meta_description,
                keywords: blog.keywords
            },
            faqs: [] // Or parse from DB if you add JSON support
        }));

        return reply.send({ success: true, blogs });
    } catch (err) {
        request.log.error('Public Get Blogs Error:', err);
        return reply.status(500).send({ error: 'Failed to fetch blogs' });
    }
};

module.exports = { getPublicStatus, getBlogs };
