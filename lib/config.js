const fs = require("fs");

const { CONFIG_PATH, ensureTachiDir } = require("./paths");

const DEFAULT_CONFIG = {
  server_url: "http://localhost:7070",
  api_key: null,
  agent_id: null,
};

function ensureConfig() {
  ensureTachiDir();

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }

  const raw = fs.readFileSync(CONFIG_PATH, "utf8");

  try {
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_CONFIG, ...parsed };

    if (JSON.stringify(parsed) !== JSON.stringify(merged)) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
    }

    return merged;
  } catch (error) {
    throw new Error(`Failed to parse config at ${CONFIG_PATH}: ${error.message}`);
  }
}

function writeConfig(nextConfig) {
  ensureTachiDir();
  const merged = { ...DEFAULT_CONFIG, ...nextConfig };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = {
  DEFAULT_CONFIG,
  ensureConfig,
  writeConfig,
};
