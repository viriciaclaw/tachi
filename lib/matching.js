function parseCapabilities(rawCapabilities) {
  if (!rawCapabilities) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawCapabilities);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function hydrateAgent(agent) {
  if (!agent) {
    return null;
  }

  return {
    ...agent,
    capabilities: parseCapabilities(agent.capabilities),
  };
}

function findBestMatch(db, task) {
  const match = db
    .prepare(
      `
        SELECT id, name, capabilities, rate_min, rate_max, description, rating_avg, rating_count, status, created_at
        FROM agents
        WHERE status = 'active'
          AND id != ?
          AND rate_min <= ?
          AND EXISTS (
            SELECT 1
            FROM json_each(COALESCE(agents.capabilities, '[]'))
            WHERE json_each.value = ?
          )
        ORDER BY rating_avg DESC, rating_count DESC, created_at ASC, id ASC
        LIMIT 1
      `,
    )
    .get(task.buyer_id, task.budget_max, task.capability);

  if (!match) {
    return null;
  }

  db.prepare("UPDATE tasks SET seller_id = ?, status = 'matched' WHERE id = ?").run(match.id, task.id);
  return hydrateAgent(match);
}

module.exports = {
  findBestMatch,
};
