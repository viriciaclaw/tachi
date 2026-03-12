const { ensureConfig } = require("../../lib/config");

function ensureRegistered(config) {
  if (!config.api_key) {
    console.error("No API key configured. Run `tachi register` first.");
    process.exitCode = 1;
    return false;
  }

  return true;
}

async function walletTopupCommand(amountArg) {
  const config = ensureConfig();

  if (!ensureRegistered(config)) {
    return;
  }

  const amount = Number.parseFloat(amountArg);

  try {
    const response = await fetch(`${config.server_url}/wallet/topup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.api_key,
      },
      body: JSON.stringify({ amount }),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(payload.error || `Wallet topup failed with status ${response.status}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Added $${amount}. New balance: $${payload.balance}`);
  } catch (error) {
    console.error(`Wallet topup failed: ${error.message}`);
    process.exitCode = 1;
  }
}

async function walletBalanceCommand() {
  const config = ensureConfig();

  if (!ensureRegistered(config)) {
    return;
  }

  try {
    const response = await fetch(`${config.server_url}/wallet/balance`, {
      headers: {
        "X-API-Key": config.api_key,
      },
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(payload.error || `Wallet balance failed with status ${response.status}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Balance: $${payload.balance}`);
  } catch (error) {
    console.error(`Wallet balance failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  walletBalanceCommand,
  walletTopupCommand,
};
