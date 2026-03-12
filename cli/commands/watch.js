const { ensureConfig } = require("../../lib/config");

const DEFAULT_RELEASE_WINDOW_MS = 7_200_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureRegistered(config) {
  if (!config.api_key) {
    console.error("No API key configured. Run `tachi register` first.");
    process.exitCode = 1;
    return false;
  }

  return true;
}

function getWatchPollInterval() {
  const value = Number.parseInt(process.env.TACHI_WATCH_POLL_INTERVAL_MS || "", 10);
  return Number.isInteger(value) && value > 0 ? value : 5_000;
}

function getReleaseCheckInterval() {
  const value = Number.parseInt(process.env.TACHI_WATCH_RELEASE_INTERVAL_MS || "", 10);
  return Number.isInteger(value) && value > 0 ? value : 1_000;
}

function getMaxCycles() {
  const value = Number.parseInt(process.env.TACHI_WATCH_MAX_CYCLES || "", 10);
  return Number.isInteger(value) && value > 0 ? value : Infinity;
}

function normalizeInterval(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveInterval(optionValue, envValue, defaultValue) {
  const normalizedOption = normalizeInterval(optionValue, NaN);
  const normalizedEnv = normalizeInterval(envValue, NaN);

  if (Number.isInteger(normalizedOption) && normalizedOption > 0) {
    if (normalizedOption !== defaultValue || !Number.isInteger(normalizedEnv)) {
      return normalizedOption;
    }
  }

  if (Number.isInteger(normalizedEnv) && normalizedEnv > 0) {
    return normalizedEnv;
  }

  return defaultValue;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

async function pollMarketplace(config, options, state) {
  const url = new URL(`${config.server_url}/tasks`);
  url.searchParams.set("status", "open");

  if (options.capability) {
    url.searchParams.set("capability", options.capability);
  }

  const { response, payload } = await fetchJson(url.toString(), {
    headers: {
      "X-API-Key": config.api_key,
    },
  });

  if (!response.ok) {
    throw new Error(
      payload && payload.error ? payload.error : `Marketplace watch failed with status ${response.status}`,
    );
  }

  const tasks = Array.isArray(payload) ? payload : [];
  if (tasks.length > 0 && tasks.length !== state.lastOpenCount) {
    console.log(`Found ${tasks.length} open task${tasks.length === 1 ? "" : "s"}`);
  }
  state.lastOpenCount = tasks.length;

  if (!options.autoAccept) {
    return;
  }

  for (const task of tasks) {
    try {
      const { response: acceptResponse, payload: acceptedTask } = await fetchJson(
        `${config.server_url}/tasks/${task.id}/accept`,
        {
          method: "POST",
          headers: {
            "X-API-Key": config.api_key,
          },
        },
      );

      if (acceptResponse.ok) {
        console.log(`Auto-accepted task ${acceptedTask.id} (${acceptedTask.capability})`);
        continue;
      }

      if (![403, 409].includes(acceptResponse.status)) {
        const message =
          acceptedTask && acceptedTask.error
            ? acceptedTask.error
            : `Task accept failed with status ${acceptResponse.status}`;
        console.error(`Auto-accept error for task ${task.id}: ${message}`);
      }
    } catch (error) {
      console.error(`Auto-accept error for task ${task.id}: ${error.message}`);
    }
  }
}

async function runAutoReleaseCycle(config) {
  const { response, payload } = await fetchJson(`${config.server_url}/tasks/mine?status=delivered`, {
    headers: {
      "X-API-Key": config.api_key,
    },
  });

  if (!response.ok) {
    throw new Error(
      payload && payload.error ? payload.error : `Release check failed with status ${response.status}`,
    );
  }

  const tasks = Array.isArray(payload) ? payload : [];
  const now = Date.now();

  for (const task of tasks) {
    if (task.buyer_id !== config.agent_id || !task.delivered_at) {
      continue;
    }

    const deliveredAtMs = new Date(task.delivered_at).getTime();
    const reviewWindowMs = Number(task.review_window_ms) || DEFAULT_RELEASE_WINDOW_MS;

    if (Number.isNaN(deliveredAtMs) || now < deliveredAtMs + reviewWindowMs) {
      continue;
    }

    try {
      const { response: approveResponse, payload: approvedTask } = await fetchJson(
        `${config.server_url}/tasks/${task.id}/approve`,
        {
          method: "POST",
          headers: {
            "X-API-Key": config.api_key,
          },
        },
      );

      if (approveResponse.ok) {
        console.log(`Auto-released task ${task.id}. Payment released to seller.`);
        continue;
      }

      if (![403, 409].includes(approveResponse.status)) {
        const message =
          approvedTask && approvedTask.error
            ? approvedTask.error
            : `Task approve failed with status ${approveResponse.status}`;
        console.error(`Auto-release error for task ${task.id}: ${message}`);
      }
    } catch (error) {
      console.error(`Auto-release error for task ${task.id}: ${error.message}`);
    }
  }
}

async function watchCommand(options = {}) {
  const config = ensureConfig();

  if (!ensureRegistered(config)) {
    return;
  }

  const watchOptions = {
    capability: options.capability,
    autoAccept: Boolean(options.autoAccept),
    autoRelease: options.autoRelease !== false,
    pollInterval: resolveInterval(options.pollInterval, process.env.TACHI_WATCH_POLL_INTERVAL_MS, 5_000),
    releaseCheckInterval: resolveInterval(options.releaseCheckInterval, process.env.TACHI_WATCH_RELEASE_INTERVAL_MS, 1_000),
    maxCycles: getMaxCycles(),
  };

  console.log(
    `Watching marketplace${watchOptions.capability ? ` for capability: ${watchOptions.capability}` : ""}...`,
  );

  const state = {
    intervals: [],
    isStopped: false,
    lastOpenCount: -1,
    cycles: 0,
  };

  let resolveStop;

  const stopPromise = new Promise((resolve) => {
    resolveStop = resolve;
  });

  const shutdown = () => {
    if (state.isStopped) {
      return;
    }

    state.isStopped = true;

    for (const intervalId of state.intervals) {
      clearInterval(intervalId);
    }

    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    console.log("Watch stopped.");
    resolveStop();
  };

  const marketplaceCycle = async () => {
    if (state.isStopped) {
      return;
    }

    try {
      await pollMarketplace(config, watchOptions, state);
    } catch (error) {
      console.error(`Watch poll error: ${error.message}`);
    }

    state.cycles += 1;
    if (state.cycles >= watchOptions.maxCycles) {
      shutdown();
    }
  };

  const releaseCycle = async () => {
    if (state.isStopped || !watchOptions.autoRelease) {
      return;
    }

    try {
      await runAutoReleaseCycle(config);
    } catch (error) {
      console.error(`Release check error: ${error.message}`);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await marketplaceCycle();
  if (!state.isStopped && watchOptions.autoRelease) {
    await releaseCycle();
  }

  if (!state.isStopped) {
    state.intervals.push(setInterval(marketplaceCycle, watchOptions.pollInterval));
    if (watchOptions.autoRelease) {
      state.intervals.push(setInterval(releaseCycle, watchOptions.releaseCheckInterval));
    }
  }

  await stopPromise;
}

module.exports = {
  getMaxCycles,
  getReleaseCheckInterval,
  getWatchPollInterval,
  runAutoReleaseCycle,
  sleep,
  watchCommand,
};
