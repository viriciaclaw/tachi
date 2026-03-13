const { ensureConfig } = require("../../lib/config");

function ensureRegistered(config) {
  if (!config.api_key) {
    console.error("No API key configured. Run `tachi register` first.");
    process.exitCode = 1;
    return false;
  }

  return true;
}

function printWalletHistory(transactions) {
  if (transactions.length === 0) {
    console.log("No wallet transactions found.");
    return;
  }

  console.log("ID | Type | Amount | Task | From | To");
  for (const transaction of transactions) {
    console.log(
      `${transaction.id} | ${transaction.type} | $${transaction.amount} | ${transaction.task_id || "-"} | ${transaction.from_agent || "-"} | ${transaction.to_agent || "-"}`,
    );
  }
}

function printTaskHistory(tasks) {
  if (tasks.length === 0) {
    console.log("No task history found.");
    return;
  }

  console.log("ID | Capability | Status | Buyer | Seller");
  for (const task of tasks) {
    console.log(
      `${task.id} | ${task.capability} | ${task.status} | ${task.buyer_id} | ${task.seller_id || "-"}`,
    );
  }
}

async function walletHistoryCommand() {
  const config = ensureConfig();

  if (!ensureRegistered(config)) {
    return;
  }

  try {
    const response = await fetch(`${config.server_url}/wallet/history`, {
      headers: {
        "X-API-Key": config.api_key,
      },
    });
    const payload = await response.json().catch(() => []);

    if (!response.ok) {
      console.error(payload.error || `Wallet history failed with status ${response.status}`);
      process.exitCode = 1;
      return;
    }

    printWalletHistory(Array.isArray(payload) ? payload : []);
  } catch (error) {
    console.error(`Wallet history failed: ${error.message}`);
    process.exitCode = 1;
  }
}

async function taskHistoryCommand() {
  const config = ensureConfig();

  if (!ensureRegistered(config)) {
    return;
  }

  try {
    const response = await fetch(`${config.server_url}/history`, {
      headers: {
        "X-API-Key": config.api_key,
      },
    });
    const payload = await response.json().catch(() => []);

    if (!response.ok) {
      console.error(payload.error || `Task history failed with status ${response.status}`);
      process.exitCode = 1;
      return;
    }

    printTaskHistory(Array.isArray(payload) ? payload : []);
  } catch (error) {
    console.error(`Task history failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  taskHistoryCommand,
  walletHistoryCommand,
};
