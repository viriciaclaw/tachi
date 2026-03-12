const { ensureConfig } = require("../../lib/config");

function ensureRegistered(config) {
  if (!config.api_key) {
    console.error("No API key configured. Run `tachi register` first.");
    process.exitCode = 1;
    return false;
  }

  return true;
}

function truncateDescription(description, maxLength = 32) {
  if (!description) {
    return "";
  }

  if (description.length <= maxLength) {
    return description;
  }

  return `${description.slice(0, maxLength - 3)}...`;
}

function printTaskTable(tasks) {
  if (tasks.length === 0) {
    console.log("No tasks found.");
    return;
  }

  console.log("ID | Capability | Budget | Status | Description");
  for (const task of tasks) {
    console.log(
      `${task.id} | ${task.capability} | $${task.budget_max} | ${task.status} | ${truncateDescription(task.description)}`,
    );
  }
}

async function postTaskCommand(options = {}) {
  const config = ensureConfig();

  if (!options.capability && !options.spec && (options.budget === undefined || options.budget === null)) {
    console.log("Coming soon: post");
    return;
  }

  if (!ensureRegistered(config)) {
    return;
  }

  const budget = Number(options.budget);
  const body = {
    capability: options.capability,
    spec: options.spec,
    budget_max: budget,
    description: options.description,
    pii_mask: options.piiMask,
    review_window_ms:
      options.reviewWindow === undefined ? undefined : Number.parseInt(String(options.reviewWindow), 10),
    input_path: options.input,
  };

  try {
    const response = await fetch(`${config.server_url}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.api_key,
      },
      body: JSON.stringify(body),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(payload.error || `Task post failed with status ${response.status}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Task posted: ${payload.id} (${payload.capability}), budget: $${payload.budget_max}, status: ${payload.status}`);
    if (payload.status === "matched" && payload.seller_id) {
      console.log(`Matched to specialist: ${payload.seller_id}`);
    }
  } catch (error) {
    console.error(`Task post failed: ${error.message}`);
    process.exitCode = 1;
  }
}

async function findTasksCommand(options = {}) {
  const config = ensureConfig();

  if (!ensureRegistered(config)) {
    if (!options.capability && !options.status) {
      console.log("Coming soon: find");
      process.exitCode = 0;
    }
    return;
  }

  try {
    const url = new URL(`${config.server_url}/tasks`);
    url.searchParams.set("status", options.status || "open");

    if (options.capability) {
      url.searchParams.set("capability", options.capability);
    }

    const response = await fetch(url.toString(), {
      headers: {
        "X-API-Key": config.api_key,
      },
    });

    const payload = await response.json().catch(() => []);

    if (!response.ok) {
      console.error(payload.error || `Task find failed with status ${response.status}`);
      process.exitCode = 1;
      return;
    }

    printTaskTable(Array.isArray(payload) ? payload : []);
  } catch (error) {
    console.error(`Task find failed: ${error.message}`);
    process.exitCode = 1;
  }
}

async function acceptTaskCommand(taskId) {
  const config = ensureConfig();

  if (!ensureRegistered(config)) {
    return;
  }

  try {
    const response = await fetch(`${config.server_url}/tasks/${taskId}/accept`, {
      method: "POST",
      headers: {
        "X-API-Key": config.api_key,
      },
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(payload.error || `Task accept failed with status ${response.status}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Accepted task ${payload.id}. Status: in-progress. Get to work!`);
  } catch (error) {
    console.error(`Task accept failed: ${error.message}`);
    process.exitCode = 1;
  }
}

async function deliverTaskCommand(taskId, options = {}) {
  const config = ensureConfig();

  if (!ensureRegistered(config)) {
    return;
  }

  try {
    const response = await fetch(`${config.server_url}/tasks/${taskId}/deliver`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.api_key,
      },
      body: JSON.stringify({
        output_path: options.output,
      }),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(payload.error || `Task deliver failed with status ${response.status}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Delivered task ${payload.id}. Status: delivered. Awaiting buyer review.`);
  } catch (error) {
    console.error(`Task deliver failed: ${error.message}`);
    process.exitCode = 1;
  }
}

async function approveTaskCommand(taskId) {
  const config = ensureConfig();

  if (!ensureRegistered(config)) {
    return;
  }

  try {
    const response = await fetch(`${config.server_url}/tasks/${taskId}/approve`, {
      method: "POST",
      headers: {
        "X-API-Key": config.api_key,
      },
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(payload.error || `Task approve failed with status ${response.status}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Approved task ${payload.id}. Payment released to seller.`);
  } catch (error) {
    console.error(`Task approve failed: ${error.message}`);
    process.exitCode = 1;
  }
}

async function rejectTaskCommand(taskId, options = {}) {
  const config = ensureConfig();

  if (!ensureRegistered(config)) {
    return;
  }

  try {
    const response = await fetch(`${config.server_url}/tasks/${taskId}/reject`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.api_key,
      },
      body: JSON.stringify({
        reason: options.reason,
      }),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(payload.error || `Task reject failed with status ${response.status}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Rejected task ${payload.id}. Reason: ${payload.rejection_reason}`);
  } catch (error) {
    console.error(`Task reject failed: ${error.message}`);
    process.exitCode = 1;
  }
}

function printTaskDetail(task) {
  console.log(`ID: ${task.id}`);
  console.log(`Status: ${task.status}`);
  console.log(`Capability: ${task.capability}`);
  console.log(`Buyer: ${task.buyer_id}`);
  console.log(`Seller: ${task.seller_id || "unassigned"}`);
  console.log(`Budget: $${task.budget_max}`);
  console.log(`Agreed Price: ${task.agreed_price === null ? "n/a" : `$${task.agreed_price}`}`);
  console.log(`Created At: ${task.created_at || "n/a"}`);
  console.log(`Accepted At: ${task.accepted_at || "n/a"}`);
  console.log(`Delivered At: ${task.delivered_at || "n/a"}`);
  console.log(`Completed At: ${task.completed_at || "n/a"}`);
}

async function taskStatusCommand(taskId) {
  const config = ensureConfig();

  if (!ensureRegistered(config)) {
    return;
  }

  try {
    const response = await fetch(`${config.server_url}/tasks/${taskId}`, {
      headers: {
        "X-API-Key": config.api_key,
      },
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(payload.error || `Task status failed with status ${response.status}`);
      process.exitCode = 1;
      return;
    }

    printTaskDetail(payload);
  } catch (error) {
    console.error(`Task status failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  acceptTaskCommand,
  approveTaskCommand,
  deliverTaskCommand,
  findTasksCommand,
  postTaskCommand,
  rejectTaskCommand,
  taskStatusCommand,
};
