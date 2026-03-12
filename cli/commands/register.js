const { CONFIG_PATH } = require("../../lib/paths");
const { ensureConfig, writeConfig } = require("../../lib/config");

async function registerCommand(options) {
  const config = ensureConfig();
  const capabilities = String(options.capabilities || "")
    .split(",")
    .map((capability) => capability.trim())
    .filter(Boolean);

  try {
    const response = await fetch(`${config.server_url}/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: options.name,
        capabilities,
        rate_min: Number(options.rateMin ?? 0),
        rate_max: Number(options.rateMax ?? 0),
        description: options.description,
      }),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(payload.error || `Registration failed with status ${response.status}`);
      process.exitCode = 1;
      return;
    }

    writeConfig({
      ...config,
      api_key: payload.api_key,
      agent_id: payload.id,
    });

    console.log(`Registered as ${payload.name} (id: ${payload.id})`);
    console.log(`API Key: ${payload.api_key} (save this - it won't be shown again)`);
    console.log(`Config saved to ${CONFIG_PATH}`);
  } catch (error) {
    console.error(`Registration failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  registerCommand,
};
