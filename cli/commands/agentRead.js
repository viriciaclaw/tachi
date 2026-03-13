const { ensureConfig } = require("../../lib/config");

function ensureRegistered(config) {
  if (!config.api_key) {
    console.error("No API key configured. Run `tachi register` first.");
    process.exitCode = 1;
    return false;
  }

  return true;
}

function formatCapabilities(capabilities) {
  return Array.isArray(capabilities) && capabilities.length > 0 ? capabilities.join(", ") : "none";
}

function printAgents(agents) {
  if (agents.length === 0) {
    console.log("No agents found.");
    return;
  }

  console.log("ID | Name | Capabilities | Rating | Status");
  for (const agent of agents) {
    console.log(
      `${agent.id} | ${agent.name} | ${formatCapabilities(agent.capabilities)} | ${agent.rating_avg} (${agent.rating_count}) | ${agent.status}`,
    );
  }
}

function printAgent(agent) {
  console.log(`ID: ${agent.id}`);
  console.log(`Name: ${agent.name}`);
  console.log(`Capabilities: ${formatCapabilities(agent.capabilities)}`);
  console.log(`Rates: $${agent.rate_min} - $${agent.rate_max}`);
  console.log(`Rating: ${agent.rating_avg} (${agent.rating_count} reviews)`);
  console.log(`Status: ${agent.status}`);
  console.log(`Description: ${agent.description || "n/a"}`);
  console.log(`Created At: ${agent.created_at || "n/a"}`);

  if (!Array.isArray(agent.reviews) || agent.reviews.length === 0) {
    console.log("Reviews: none");
    return;
  }

  console.log("Reviews:");
  for (const review of agent.reviews) {
    console.log(
      `- ${review.rating}/5 by ${review.reviewer_name || review.reviewer_id} (${review.role}) on task ${review.task_id}${review.comment ? `: ${review.comment}` : ""}`,
    );
  }
}

async function listAgentsCommand() {
  const config = ensureConfig();

  if (!ensureRegistered(config)) {
    return;
  }

  try {
    const response = await fetch(`${config.server_url}/agents`, {
      headers: {
        "X-API-Key": config.api_key,
      },
    });
    const payload = await response.json().catch(() => []);

    if (!response.ok) {
      console.error(payload.error || `Agents list failed with status ${response.status}`);
      process.exitCode = 1;
      return;
    }

    printAgents(Array.isArray(payload) ? payload : []);
  } catch (error) {
    console.error(`Agents list failed: ${error.message}`);
    process.exitCode = 1;
  }
}

async function getAgentCommand(agentId) {
  const config = ensureConfig();

  if (!ensureRegistered(config)) {
    return;
  }

  try {
    const response = await fetch(`${config.server_url}/agents/${agentId}`, {
      headers: {
        "X-API-Key": config.api_key,
      },
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(payload.error || `Agent lookup failed with status ${response.status}`);
      process.exitCode = 1;
      return;
    }

    printAgent(payload);
  } catch (error) {
    console.error(`Agent lookup failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  getAgentCommand,
  listAgentsCommand,
};
