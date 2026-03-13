const { v4: uuidv4 } = require("uuid");
const { isValidCurrencyAmount, roundCurrency } = require("../../lib/money");

function createWalletTopupHandler(db) {
  const applyTopup = db.transaction((agentId, amount, createdAt) => {
    db.prepare("UPDATE agents SET wallet_balance = ROUND(wallet_balance + ?, 2) WHERE id = ?").run(amount, agentId);

    const balanceRow = db.prepare("SELECT wallet_balance FROM agents WHERE id = ?").get(agentId);
    const transactionId = uuidv4();

    db.prepare(`
      INSERT INTO transactions (id, task_id, from_agent, to_agent, amount, type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(transactionId, null, null, agentId, amount, "topup", createdAt);

    return {
      balance: balanceRow.wallet_balance,
      transactionId,
    };
  });

  return function walletTopup(req, res) {
    const amount = Number(req.body?.amount);

    if (!isValidCurrencyAmount(amount)) {
      return res.status(400).json({ error: "Field 'amount' must be a positive number with at most 2 decimal places" });
    }

    const result = applyTopup(req.agent.id, roundCurrency(amount), new Date().toISOString());
    return res.status(200).json({
      balance: result.balance,
      transaction_id: result.transactionId,
    });
  };
}

function createWalletBalanceHandler(db) {
  const findBalance = db.prepare("SELECT wallet_balance FROM agents WHERE id = ? LIMIT 1");

  return function walletBalance(req, res) {
    const row = findBalance.get(req.agent.id);

    return res.status(200).json({
      agent_id: req.agent.id,
      balance: row ? row.wallet_balance : 0,
    });
  };
}

module.exports = {
  createWalletBalanceHandler,
  createWalletTopupHandler,
};
