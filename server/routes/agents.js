const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

const { hashApiKey } = require("../../lib/hash");

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) {
    return null;
  }

  const normalized = capabilities
    .filter((capability) => typeof capability === "string")
    .map((capability) => capability.trim())
    .filter(Boolean);

  return normalized.length > 0 ? normalized : null;
}

function createRegisterAgentHandler(db) {
  const findByName = db.prepare("SELECT id FROM agents WHERE name = ? LIMIT 1");
  const insertAgent = db.prepare(`
    INSERT INTO agents (
      id,
      name,
      api_key_hash,
      capabilities,
      rate_min,
      rate_max,
      description,
      wallet_balance,
      status,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return function registerAgent(req, res) {
    const { name, capabilities, rate_min = 0, rate_max = 0, description = null } = req.body ?? {};
    const normalizedName = typeof name === "string" ? name.trim() : "";
    const normalizedCapabilities = normalizeCapabilities(capabilities);

    if (!isNonEmptyString(normalizedName)) {
      return res.status(400).json({ error: "Field 'name' is required" });
    }

    if (!normalizedCapabilities) {
      return res.status(400).json({ error: "Field 'capabilities' must be a non-empty array of strings" });
    }

    if (findByName.get(normalizedName)) {
      return res.status(409).json({ error: `Agent name '${normalizedName}' is already registered` });
    }

    const id = uuidv4();
    const apiKey = `tachi_${crypto.randomBytes(16).toString("hex")}`;
    const createdAt = new Date().toISOString();

    insertAgent.run(
      id,
      normalizedName,
      hashApiKey(apiKey),
      JSON.stringify(normalizedCapabilities),
      Number(rate_min) || 0,
      Number(rate_max) || 0,
      description ?? null,
      0,
      "active",
      createdAt,
    );

    return res.status(201).json({
      id,
      name: normalizedName,
      api_key: apiKey,
      capabilities: normalizedCapabilities,
      rate_min: Number(rate_min) || 0,
      rate_max: Number(rate_max) || 0,
      description: description ?? null,
    });
  };
}

module.exports = {
  createRegisterAgentHandler,
};
