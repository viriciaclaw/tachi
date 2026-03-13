const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function parsePagination(query = {}) {
  const rawLimit = query.limit;
  const rawOffset = query.offset;

  const limit = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit);
  const offset = rawOffset === undefined ? 0 : Number(rawOffset);

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return {
      error: `Query parameter 'limit' must be an integer between 1 and ${MAX_LIMIT}`,
    };
  }

  if (!Number.isInteger(offset) || offset < 0) {
    return {
      error: "Query parameter 'offset' must be a non-negative integer",
    };
  }

  return { limit, offset };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  parsePagination,
};
