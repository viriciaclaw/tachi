const { ensureConfig } = require("../../lib/config");

const DEFAULT_ACCEPT_TIMEOUT_MS = 60_000;
const DEFAULT_DELIVERY_TIMEOUT_MS = 7_200_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

function ensureRegistered(config) {
  if (!config.api_key) {
    console.error("No API key configured. Run `tachi register` first.");
    process.exitCode = 1;
    return false;
  }

  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPollIntervalMs() {
  const value = Number.parseInt(process.env.TACHI_POLL_INTERVAL_MS || "", 10);

  if (!Number.isInteger(value) || value <= 0) {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  return value;
}

function normalizeTimeout(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

async function fetchTask(serverUrl, apiKey, taskId, fetchImpl = fetch) {
  const response = await fetchImpl(`${serverUrl}/tasks/${taskId}`, {
    headers: {
      "X-API-Key": apiKey,
    },
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload.error || `Task fetch failed with status ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return payload;
}

async function pollForStatus(
  serverUrl,
  apiKey,
  taskId,
  targetStatuses,
  timeoutMs,
  pollIntervalMs = getPollIntervalMs(),
  options = {},
) {
  const fetchImpl = options.fetchImpl || fetch;
  const onPoll = options.onPoll;
  const onDot = options.onDot;
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  let polls = 0;

  while (polls < maxPolls) {
    const task = await fetchTask(serverUrl, apiKey, taskId, fetchImpl);

    if (typeof onPoll === "function") {
      onPoll(task, polls + 1);
    }

    if (targetStatuses.includes(task.status)) {
      return task;
    }

    polls += 1;
    if (polls >= maxPolls) {
      break;
    }

    if (polls % 5 === 0) {
      process.stdout.write(".");
      if (typeof onDot === "function") {
        onDot(polls);
      }
    }

    await sleep(pollIntervalMs);
  }

  return null;
}

async function callCommand(capability, options = {}) {
  const config = ensureConfig();

  if (!ensureRegistered(config)) {
    return;
  }

  const acceptTimeoutMs = normalizeTimeout(options.timeout, DEFAULT_ACCEPT_TIMEOUT_MS);
  const deliveryTimeoutMs = normalizeTimeout(options.deliveryTimeout, DEFAULT_DELIVERY_TIMEOUT_MS);
  const budget = Number(options.budget);
  const postBody = {
    capability,
    spec: options.spec,
    budget_max: budget,
    description: options.description,
    input_path: options.input,
    pii_mask: options.piiMask,
  };

  let taskId;
  let acceptanceDotsPrinted = false;
  let lastAcceptanceStatus = null;

  try {
    const postResponse = await fetch(`${config.server_url}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": config.api_key,
      },
      body: JSON.stringify(postBody),
    });

    const postPayload = await postResponse.json().catch(() => ({}));

    if (!postResponse.ok) {
      console.error(postPayload.error || `Task post failed with status ${postResponse.status}`);
      process.exitCode = 1;
      return;
    }

    taskId = postPayload.id;
    console.log(`Task posted: ${taskId}. Looking for specialist...`);

    const acceptedTask = await pollForStatus(
      config.server_url,
      config.api_key,
      taskId,
      ["in-progress"],
      acceptTimeoutMs,
      getPollIntervalMs(),
      {
        onPoll(task) {
          if (task.status === "matched" && lastAcceptanceStatus !== "matched") {
            if (acceptanceDotsPrinted) {
              process.stdout.write("\n");
              acceptanceDotsPrinted = false;
            }
            console.log(`Matched to ${task.seller_id}. Waiting for accept...`);
          }

          if (task.status === "in-progress" && acceptanceDotsPrinted) {
            process.stdout.write("\n");
            acceptanceDotsPrinted = false;
          }

          lastAcceptanceStatus = task.status;
        },
        onDot() {
          acceptanceDotsPrinted = true;
        },
      },
    );

    if (!acceptedTask) {
      if (acceptanceDotsPrinted) {
        process.stdout.write("\n");
      }
      console.error(`No specialist accepted within ${acceptTimeoutMs}ms. Task ${taskId} is still open.`);
      process.exitCode = 1;
      return;
    }

    console.log(`Specialist ${acceptedTask.seller_id} accepted! Waiting for delivery...`);

    let deliveryDotsPrinted = false;
    const deliveredTask = await pollForStatus(
      config.server_url,
      config.api_key,
      taskId,
      ["delivered"],
      deliveryTimeoutMs,
      getPollIntervalMs(),
      {
        onPoll(task, pollCount) {
          if (task.status === "delivered" && deliveryDotsPrinted) {
            process.stdout.write("\n");
            deliveryDotsPrinted = false;
          }
        },
        onDot() {
          deliveryDotsPrinted = true;
        },
      },
    );

    if (!deliveredTask) {
      if (deliveryDotsPrinted) {
        process.stdout.write("\n");
      }
      console.error(`Delivery timed out after ${deliveryTimeoutMs}ms. Task ${taskId} is still in-progress.`);
      process.exitCode = 1;
      return;
    }

    console.log(`Work delivered! Output: ${deliveredTask.output_path}`);

    if (options.autoApprove) {
      const approveResponse = await fetch(`${config.server_url}/tasks/${taskId}/approve`, {
        method: "POST",
        headers: {
          "X-API-Key": config.api_key,
        },
      });

      const approvePayload = await approveResponse.json().catch(() => ({}));

      if (!approveResponse.ok) {
        console.error(approvePayload.error || `Task approve failed with status ${approveResponse.status}`);
        process.exitCode = 1;
        return;
      }

      console.log(`Auto-approved task ${taskId}. Payment released to seller.`);
      return;
    }

    console.log(`Task ${taskId} delivered. Review with: tachi status ${taskId}`);
    console.log(`Approve: tachi approve ${taskId}`);
    console.log(`Reject: tachi reject ${taskId} --reason <text>`);
  } catch (error) {
    console.error(error.message || `Task call failed for ${taskId || capability}`);
    process.exitCode = 1;
  }
}

module.exports = {
  callCommand,
  fetchTask,
  getPollIntervalMs,
  pollForStatus,
  sleep,
};
