const { normalizeTask } = require("./tasks");
const { parsePagination } = require("../../lib/pagination");

function createWalletHistoryHandler(db) {
  const findTransactions = db.prepare(`
    SELECT id, task_id, from_agent, to_agent, amount, type, created_at
    FROM transactions
    WHERE from_agent = ? OR to_agent = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `);

  return function walletHistory(req, res) {
    const pagination = parsePagination(req.query);
    if (pagination.error) {
      return res.status(400).json({ error: pagination.error });
    }

    const transactions = findTransactions.all(req.agent.id, req.agent.id, pagination.limit, pagination.offset).map((transaction) => ({
      ...transaction,
      amount: Number(transaction.amount),
    }));

    return res.status(200).json(transactions);
  };
}

function createTaskHistoryHandler(db) {
  const findTasks = db.prepare(`
    SELECT *
    FROM tasks
    WHERE (buyer_id = @agentId OR seller_id = @agentId)
      AND (@status IS NULL OR status = @status)
    ORDER BY created_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `);

  return function taskHistory(req, res) {
    const pagination = parsePagination(req.query);
    if (pagination.error) {
      return res.status(400).json({ error: pagination.error });
    }

    const status = req.query?.status || null;
    const tasks = findTasks.all({
      agentId: req.agent.id,
      status,
      limit: pagination.limit,
      offset: pagination.offset,
    });

    return res.status(200).json(tasks.map(normalizeTask));
  };
}

module.exports = {
  createTaskHistoryHandler,
  createWalletHistoryHandler,
};
