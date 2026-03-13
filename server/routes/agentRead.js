const { parsePagination } = require("../../lib/pagination");

function parseCapabilities(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function toPublicAgent(agent) {
  if (!agent) {
    return null;
  }

  return {
    id: agent.id,
    name: agent.name,
    capabilities: parseCapabilities(agent.capabilities),
    rate_min: Number(agent.rate_min || 0),
    rate_max: Number(agent.rate_max || 0),
    description: agent.description ?? null,
    rating_avg: Number(agent.rating_avg || 0),
    rating_count: Number(agent.rating_count || 0),
    status: agent.status,
    created_at: agent.created_at ?? null,
  };
}

function getAgentId(req) {
  if (req.params && req.params.id) {
    return req.params.id;
  }

  const path = req.path || req.url || "";
  const match = path.match(/^\/agents\/([^/]+)/);
  return match ? match[1] : null;
}

function createListAgentsHandler(db) {
  const findAgents = db.prepare(`
    SELECT
      id,
      name,
      capabilities,
      rate_min,
      rate_max,
      description,
      rating_avg,
      rating_count,
      status,
      created_at
    FROM agents
    ORDER BY created_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `);

  return function listAgents(req, res) {
    const pagination = parsePagination(req.query);
    if (pagination.error) {
      return res.status(400).json({ error: pagination.error });
    }

    return res.status(200).json(
      findAgents.all(pagination).map(toPublicAgent),
    );
  };
}

function createGetAgentHandler(db) {
  const findAgent = db.prepare(`
    SELECT
      id,
      name,
      capabilities,
      rate_min,
      rate_max,
      description,
      rating_avg,
      rating_count,
      status,
      created_at
    FROM agents
    WHERE id = ?
    LIMIT 1
  `);

  const findReviews = db.prepare(`
    SELECT
      reviews.id,
      reviews.task_id,
      reviews.reviewer_id,
      reviewers.name AS reviewer_name,
      reviews.reviewee_id,
      reviews.rating,
      reviews.comment,
      reviews.role,
      reviews.created_at
    FROM reviews
    LEFT JOIN agents AS reviewers ON reviewers.id = reviews.reviewer_id
    WHERE reviews.reviewee_id = ?
    ORDER BY reviews.created_at DESC, reviews.id DESC
  `);

  return function getAgent(req, res) {
    const agentId = getAgentId(req);
    const agent = findAgent.get(agentId);

    if (!agent) {
      return res.status(404).json({ error: "Agent not found" });
    }

    return res.status(200).json({
      ...toPublicAgent(agent),
      reviews: findReviews.all(agent.id).map((review) => ({
        ...review,
        rating: Number(review.rating),
        comment: review.comment ?? null,
        reviewer_name: review.reviewer_name ?? null,
      })),
    });
  };
}

module.exports = {
  createGetAgentHandler,
  createListAgentsHandler,
  toPublicAgent,
};
