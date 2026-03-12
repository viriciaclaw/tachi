const fs = require("fs");
const os = require("os");
const path = require("path");

const CLI_PATH = path.join(__dirname, "..", "cli", "index.js");

function createTempHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createMockRequest(app, method, requestPath, headers = {}, body) {
  const parsedUrl = new URL(requestPath, "http://localhost");
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );

  const req = Object.create(app.request);
  req.app = app;
  req.method = method.toUpperCase();
  req.url = requestPath;
  req.originalUrl = requestPath;
  req.path = parsedUrl.pathname;
  req.query = Object.fromEntries(parsedUrl.searchParams.entries());
  req.headers = normalizedHeaders;
  req.body = body;
  req.params = {};
  req.header = (name) => normalizedHeaders[name.toLowerCase()];
  return req;
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    locals: {},
    finished: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.finished = true;
      if (this._resolve) {
        this._resolve();
      }
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return this.headers[name.toLowerCase()];
    },
    removeHeader(name) {
      delete this.headers[name.toLowerCase()];
    },
  };
}

function invokeHandler(handler, req, res) {
  return new Promise((resolve, reject) => {
    res._resolve = () => resolve();

    const next = (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    try {
      const result = handler(req, res, next);
      if (result && typeof result.then === "function") {
        result.then(resolve).catch(reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}

async function simulateRequest(app, method, requestPath, options = {}) {
  const req = createMockRequest(app, method, requestPath, options.headers, options.body);
  const res = createMockResponse();
  const layers = app.router.stack;
  const authLayer = layers.find((layer) => layer.name === "authMiddleware");
  const routeLayer = layers.find((layer) => {
    if (!layer.route || !layer.route.methods[method.toLowerCase()]) {
      return false;
    }

    return layer.match(req.path);
  });
  const notFoundLayer = layers[layers.length - 1];

  if (routeLayer && routeLayer.params) {
    req.params = routeLayer.params;
  }

  await invokeHandler(authLayer.handle, req, res);
  if (res.finished) {
    return res;
  }

  if (routeLayer) {
    await invokeHandler(routeLayer.route.stack[0].handle, req, res);
    return res;
  }

  await invokeHandler(notFoundLayer.handle, req, res);
  return res;
}

function setupServer() {
  const homeDir = createTempHome("tachi-phase6-test-");
  process.env.TACHI_HOME = homeDir;
  jest.resetModules();

  const { runMigrations } = require("../db/migrate");
  const { openDatabase } = require("../db");
  const { createApp } = require("../server");
  const { hashApiKey } = require("../lib/hash");

  runMigrations();
  const db = openDatabase();

  const close = () => {
    db.close();
    delete process.env.TACHI_HOME;
    jest.resetModules();
    fs.rmSync(homeDir, { recursive: true, force: true });
  };

  const insertAgent = ({
    id,
    name,
    apiKey,
    capabilities = [],
    rateMin = 0,
    rateMax = 0,
    ratingAvg = 0,
    ratingCount = 0,
    walletBalance = 0,
    status = "active",
    createdAt = "2026-03-12T00:00:00.000Z",
  }) => {
    db.prepare(
      `
        INSERT INTO agents (
          id, name, api_key_hash, capabilities, rate_min, rate_max, description,
          rating_avg, rating_count, wallet_balance, status, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      id,
      name,
      hashApiKey(apiKey),
      JSON.stringify(capabilities),
      rateMin,
      rateMax,
      null,
      ratingAvg,
      ratingCount,
      walletBalance,
      status,
      createdAt,
    );
  };

  const insertTask = ({
    id,
    buyerId,
    sellerId = null,
    capability = "code",
    description = null,
    spec = "ship it",
    piiMask = 1,
    budgetMax = 10,
    agreedPrice = null,
    reviewWindowMs = 7_200_000,
    status = "open",
    inputPath = null,
    outputPath = null,
    rejectionReason = null,
    revisionCount = 0,
    createdAt = "2026-03-12T00:00:00.000Z",
    acceptedAt = null,
    deliveredAt = null,
    completedAt = null,
  }) => {
    db.prepare(
      `
        INSERT INTO tasks (
          id, buyer_id, seller_id, capability, description, spec, pii_mask, budget_max, agreed_price,
          review_window_ms, status, input_path, output_path, rejection_reason, revision_count,
          created_at, accepted_at, delivered_at, completed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      id,
      buyerId,
      sellerId,
      capability,
      description,
      spec,
      piiMask,
      budgetMax,
      agreedPrice,
      reviewWindowMs,
      status,
      inputPath,
      outputPath,
      rejectionReason,
      revisionCount,
      createdAt,
      acceptedAt,
      deliveredAt,
      completedAt,
    );
  };

  return {
    app: createApp(db),
    db,
    insertAgent,
    insertTask,
    close,
  };
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

async function runCliWithEnv(args, homeDir, extraEnv = {}) {
  const argv = args.length > 0 ? args.split(" ") : [];
  const originalHome = process.env.TACHI_HOME;
  const originalShim = process.env.TACHI_FETCH_SHIM_MODULE;
  const originalServerHome = process.env.TACHI_TEST_SERVER_HOME;
  const originalWatchPoll = process.env.TACHI_WATCH_POLL_INTERVAL_MS;
  const originalWatchRelease = process.env.TACHI_WATCH_RELEASE_INTERVAL_MS;
  const originalWatchCycles = process.env.TACHI_WATCH_MAX_CYCLES;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalExitCode = process.exitCode;
  let output = "";

  process.exitCode = 0;
  process.env.TACHI_HOME = homeDir;
  Object.assign(process.env, extraEnv);
  process.stdout.write = (chunk, encoding, callback) => {
    output += String(chunk);
    if (typeof callback === "function") {
      callback();
    }
    return true;
  };
  process.stderr.write = (chunk, encoding, callback) => {
    output += String(chunk);
    if (typeof callback === "function") {
      callback();
    }
    return true;
  };
  console.log = (...parts) => {
    output += `${parts.join(" ")}\n`;
  };
  console.error = (...parts) => {
    output += `${parts.join(" ")}\n`;
  };

  jest.resetModules();

  try {
    let program;
    jest.isolateModules(() => {
      jest.doMock("chalk", () => ({
        __esModule: true,
        default: {
          yellow: (value) => value,
        },
      }));
      ({ createProgram: program } = require(CLI_PATH));
    });
    const cliProgram = program();
    cliProgram.exitOverride();

    try {
      await cliProgram.parseAsync(argv, { from: "user" });
    } catch (error) {
      if (error.code !== "commander.helpDisplayed" && error.code !== "commander.version") {
        throw error;
      }
    }
  } finally {
    process.exitCode = originalExitCode;
    if (originalHome === undefined) {
      delete process.env.TACHI_HOME;
    } else {
      process.env.TACHI_HOME = originalHome;
    }
    if (originalShim === undefined) {
      delete process.env.TACHI_FETCH_SHIM_MODULE;
    } else {
      process.env.TACHI_FETCH_SHIM_MODULE = originalShim;
    }
    if (originalServerHome === undefined) {
      delete process.env.TACHI_TEST_SERVER_HOME;
    } else {
      process.env.TACHI_TEST_SERVER_HOME = originalServerHome;
    }
    if (originalWatchPoll === undefined) {
      delete process.env.TACHI_WATCH_POLL_INTERVAL_MS;
    } else {
      process.env.TACHI_WATCH_POLL_INTERVAL_MS = originalWatchPoll;
    }
    if (originalWatchRelease === undefined) {
      delete process.env.TACHI_WATCH_RELEASE_INTERVAL_MS;
    } else {
      process.env.TACHI_WATCH_RELEASE_INTERVAL_MS = originalWatchRelease;
    }
    if (originalWatchCycles === undefined) {
      delete process.env.TACHI_WATCH_MAX_CYCLES;
    } else {
      process.env.TACHI_WATCH_MAX_CYCLES = originalWatchCycles;
    }
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }

  return stripAnsi(output);
}

async function registerAgent(homeDir, serverHome, name, capabilities) {
  const configPath = path.join(serverHome, "config.json");
  const shimPath = path.join(__dirname, "helpers", "cli-fetch-shim.js");

  fs.writeFileSync(
    configPath,
    JSON.stringify({ server_url: "http://tachi.test", api_key: null, agent_id: null }, null, 2),
  );

  await runCliWithEnv(`register --name ${name} --capabilities ${capabilities}`, homeDir, {
    TACHI_FETCH_SHIM_MODULE: shimPath,
    TACHI_TEST_SERVER_HOME: serverHome,
  });

  return {
    config: JSON.parse(fs.readFileSync(configPath, "utf8")),
    configPath,
    shimPath,
  };
}

async function createWatchCliContext() {
  const serverHome = createTempHome("tachi-phase6-cli-server-");
  const buyerHome = createTempHome("tachi-phase6-cli-buyer-");
  const sellerHome = createTempHome("tachi-phase6-cli-seller-");
  const { config: buyerConfig, configPath, shimPath } = await registerAgent(buyerHome, serverHome, "buyer", "design");
  const { config: sellerConfig } = await registerAgent(sellerHome, serverHome, "seller", "code");

  return {
    buyerConfig,
    buyerHome,
    configPath,
    sellerConfig,
    sellerHome,
    serverHome,
    shimPath,
  };
}

function loadCliShim(serverHome, shimPath) {
  process.env.TACHI_TEST_SERVER_HOME = serverHome;
  delete require.cache[require.resolve(shimPath)];
  require(shimPath);
}

describe("Phase 6: GET /tasks/mine", () => {
  let ctx;

  afterEach(() => {
    if (ctx) {
      ctx.close();
      ctx = null;
    }
  });

  test("returns tasks where agent is buyer", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key" });
    ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key" });
    ctx.insertTask({ id: "task-1", buyerId: "buyer-1", sellerId: "seller-1", status: "open" });

    const response = await simulateRequest(ctx.app, "GET", "/tasks/mine", {
      headers: { "X-API-Key": "buyer-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.map((task) => task.id)).toEqual(["task-1"]);
  });

  test("returns tasks where agent is seller", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key" });
    ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key" });
    ctx.insertTask({ id: "task-1", buyerId: "buyer-1", sellerId: "seller-1", status: "in-progress" });

    const response = await simulateRequest(ctx.app, "GET", "/tasks/mine", {
      headers: { "X-API-Key": "seller-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.map((task) => task.id)).toEqual(["task-1"]);
  });

  test("filters by status", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key" });
    ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key" });
    ctx.insertTask({ id: "task-1", buyerId: "buyer-1", sellerId: "seller-1", status: "open" });
    ctx.insertTask({ id: "task-2", buyerId: "buyer-1", sellerId: "seller-1", status: "delivered" });

    const response = await simulateRequest(ctx.app, "GET", "/tasks/mine?status=delivered", {
      headers: { "X-API-Key": "buyer-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.map((task) => task.id)).toEqual(["task-2"]);
  });

  test("requires auth", async () => {
    ctx = setupServer();

    const response = await simulateRequest(ctx.app, "GET", "/tasks/mine");

    expect(response.statusCode).toBe(401);
  });

  test("returns empty for agent with no tasks", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key" });

    const response = await simulateRequest(ctx.app, "GET", "/tasks/mine", {
      headers: { "X-API-Key": "buyer-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual([]);
  });
});

describe("Phase 6: auto-release logic", () => {
  let ctx;

  afterEach(() => {
    if (ctx) {
      ctx.close();
      ctx = null;
    }
  });

  test("approves delivered task past review window", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 100 });
    ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key", walletBalance: 0 });
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    ctx.insertTask({
      id: "task-1",
      buyerId: "buyer-1",
      sellerId: "seller-1",
      status: "delivered",
      deliveredAt: threeHoursAgo,
      reviewWindowMs: 7_200_000,
      agreedPrice: 5,
      budgetMax: 5,
      outputPath: "/tmp/output.txt",
    });

    const originalHome = process.env.TACHI_HOME;
    process.env.TACHI_HOME = createTempHome("tachi-phase6-auto-release-");
    jest.resetModules();
    const { writeConfig } = require("../lib/config");
    const { runAutoReleaseCycle } = require("../cli/commands/watch");
    writeConfig({ server_url: "http://tachi.test", api_key: "buyer-key", agent_id: "buyer-1" });
    global.fetch = async (url, options = {}) => {
      const parsedUrl = new URL(url);
      const response = await simulateRequest(ctx.app, options.method || "GET", `${parsedUrl.pathname}${parsedUrl.search}`, {
        headers: options.headers,
      });
      return {
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        async json() {
          return response.body;
        },
      };
    };

    await runAutoReleaseCycle(writeConfig({ server_url: "http://tachi.test", api_key: "buyer-key", agent_id: "buyer-1" }));

    const task = ctx.db.prepare("SELECT status FROM tasks WHERE id = ?").get("task-1");
    expect(task.status).toBe("approved");

    delete global.fetch;
    if (originalHome === undefined) {
      delete process.env.TACHI_HOME;
    } else {
      process.env.TACHI_HOME = originalHome;
    }
  });

  test("does not approve task within review window", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key" });
    ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key" });
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    ctx.insertTask({
      id: "task-1",
      buyerId: "buyer-1",
      sellerId: "seller-1",
      status: "delivered",
      deliveredAt: thirtyMinutesAgo,
      reviewWindowMs: 7_200_000,
      agreedPrice: 5,
      budgetMax: 5,
      outputPath: "/tmp/output.txt",
    });

    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      const parsedUrl = new URL(url);
      const response = await simulateRequest(ctx.app, options.method || "GET", `${parsedUrl.pathname}${parsedUrl.search}`, {
        headers: options.headers,
      });
      return {
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        async json() {
          return response.body;
        },
      };
    };

    const { runAutoReleaseCycle } = require("../cli/commands/watch");
    await runAutoReleaseCycle({ server_url: "http://tachi.test", api_key: "buyer-key", agent_id: "buyer-1" });

    const task = ctx.db.prepare("SELECT status FROM tasks WHERE id = ?").get("task-1");
    expect(task.status).toBe("delivered");

    global.fetch = originalFetch;
  });

  test("only approves tasks where agent is buyer", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key" });
    ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key" });
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    ctx.insertTask({
      id: "task-1",
      buyerId: "buyer-1",
      sellerId: "seller-1",
      status: "delivered",
      deliveredAt: threeHoursAgo,
      reviewWindowMs: 7_200_000,
      agreedPrice: 5,
      budgetMax: 5,
      outputPath: "/tmp/output.txt",
    });

    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      const parsedUrl = new URL(url);
      const response = await simulateRequest(ctx.app, options.method || "GET", `${parsedUrl.pathname}${parsedUrl.search}`, {
        headers: options.headers,
      });
      return {
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        async json() {
          return response.body;
        },
      };
    };

    const { runAutoReleaseCycle } = require("../cli/commands/watch");
    await runAutoReleaseCycle({ server_url: "http://tachi.test", api_key: "seller-key", agent_id: "seller-1" });

    const task = ctx.db.prepare("SELECT status FROM tasks WHERE id = ?").get("task-1");
    expect(task.status).toBe("delivered");

    global.fetch = originalFetch;
  });
});

describe("Phase 6: watch CLI", () => {
  let buyerHome;
  let sellerHome;
  let serverHome;

  afterEach(() => {
    delete process.env.TACHI_TEST_SERVER_HOME;
    for (const home of [buyerHome, sellerHome, serverHome]) {
      if (home) {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }

    buyerHome = null;
    sellerHome = null;
    serverHome = null;
  });

  test("prints marketplace open tasks count", async () => {
    const ctx = await createWatchCliContext();
    ({ buyerHome, serverHome } = ctx);

    loadCliShim(serverHome, ctx.shimPath);
    global.__tachiTestDb.prepare(
      `
        INSERT INTO tasks (
          id, buyer_id, seller_id, capability, description, spec, pii_mask, budget_max, agreed_price,
          review_window_ms, status, input_path, output_path, rejection_reason, revision_count,
          created_at, accepted_at, delivered_at, completed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      "task-1",
      ctx.buyerConfig.agent_id,
      null,
      "code",
      null,
      "ship it",
      1,
      5,
      null,
      7_200_000,
      "open",
      null,
      null,
      null,
      0,
      "2026-03-12T00:00:00.000Z",
      null,
      null,
      null,
    );

    fs.writeFileSync(ctx.configPath, JSON.stringify(ctx.buyerConfig, null, 2));
    const output = await runCliWithEnv("watch", buyerHome, {
      TACHI_FETCH_SHIM_MODULE: ctx.shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
      TACHI_WATCH_POLL_INTERVAL_MS: "50",
      TACHI_WATCH_RELEASE_INTERVAL_MS: "50",
      TACHI_WATCH_MAX_CYCLES: "2",
    });

    expect(output).toContain("Watching marketplace...");
    expect(output).toContain("Found 1 open task");
    expect(output).toContain("Watch stopped.");
  });

  test("auto-accept accepts matching tasks", async () => {
    const ctx = await createWatchCliContext();
    ({ buyerHome, sellerHome, serverHome } = ctx);

    fs.writeFileSync(ctx.configPath, JSON.stringify(ctx.buyerConfig, null, 2));
    await runCliWithEnv("wallet topup 100", buyerHome, {
      TACHI_FETCH_SHIM_MODULE: ctx.shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
    });

    loadCliShim(serverHome, ctx.shimPath);
    global.__tachiTestDb.prepare(
      `
        INSERT INTO tasks (
          id, buyer_id, seller_id, capability, description, spec, pii_mask, budget_max, agreed_price,
          review_window_ms, status, input_path, output_path, rejection_reason, revision_count,
          created_at, accepted_at, delivered_at, completed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      "task-accept-1",
      ctx.buyerConfig.agent_id,
      null,
      "code",
      null,
      "watch me",
      1,
      5,
      null,
      7_200_000,
      "open",
      null,
      null,
      null,
      0,
      "2026-03-12T00:00:00.000Z",
      null,
      null,
      null,
    );

    fs.writeFileSync(ctx.configPath, JSON.stringify(ctx.sellerConfig, null, 2));
    const output = await runCliWithEnv("watch --auto-accept --capability code", sellerHome, {
      TACHI_FETCH_SHIM_MODULE: ctx.shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
      TACHI_WATCH_POLL_INTERVAL_MS: "50",
      TACHI_WATCH_RELEASE_INTERVAL_MS: "50",
      TACHI_WATCH_MAX_CYCLES: "2",
    });

    const task = global.__tachiTestDb.prepare("SELECT status, seller_id FROM tasks WHERE id = ?").get("task-accept-1");
    expect(task.status).toBe("in-progress");
    expect(task.seller_id).toBe(ctx.sellerConfig.agent_id);
    expect(output).toContain("Auto-accepted task task-accept-1 (code)");
  });

  test("auto-release approves expired delivered tasks", async () => {
    const ctx = await createWatchCliContext();
    ({ buyerHome, sellerHome, serverHome } = ctx);

    loadCliShim(serverHome, ctx.shimPath);
    global.__tachiTestDb.prepare(
      `
        INSERT INTO tasks (
          id, buyer_id, seller_id, capability, description, spec, pii_mask, budget_max, agreed_price,
          review_window_ms, status, input_path, output_path, rejection_reason, revision_count,
          created_at, accepted_at, delivered_at, completed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      "task-1",
      ctx.buyerConfig.agent_id,
      ctx.sellerConfig.agent_id,
      "code",
      null,
      "ship it",
      1,
      5,
      5,
      100,
      "delivered",
      null,
      "/tmp/output.txt",
      null,
      0,
      "2026-03-12T00:00:00.000Z",
      "2026-03-12T00:10:00.000Z",
      new Date(Date.now() - 1_000).toISOString(),
      null,
    );

    fs.writeFileSync(ctx.configPath, JSON.stringify(ctx.buyerConfig, null, 2));
    const output = await runCliWithEnv("watch", buyerHome, {
      TACHI_FETCH_SHIM_MODULE: ctx.shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
      TACHI_WATCH_POLL_INTERVAL_MS: "50",
      TACHI_WATCH_RELEASE_INTERVAL_MS: "50",
      TACHI_WATCH_MAX_CYCLES: "2",
    });

    const task = global.__tachiTestDb.prepare("SELECT status FROM tasks WHERE id = ?").get("task-1");
    expect(task.status).toBe("approved");
    expect(output).toContain("Auto-released task task-1. Payment released to seller.");
  });

  test("--no-auto-release prevents auto-approval", async () => {
    const ctx = await createWatchCliContext();
    ({ buyerHome, sellerHome, serverHome } = ctx);

    loadCliShim(serverHome, ctx.shimPath);
    global.__tachiTestDb.prepare(
      `
        INSERT INTO tasks (
          id, buyer_id, seller_id, capability, description, spec, pii_mask, budget_max, agreed_price,
          review_window_ms, status, input_path, output_path, rejection_reason, revision_count,
          created_at, accepted_at, delivered_at, completed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      "task-1",
      ctx.buyerConfig.agent_id,
      ctx.sellerConfig.agent_id,
      "code",
      null,
      "ship it",
      1,
      5,
      5,
      100,
      "delivered",
      null,
      "/tmp/output.txt",
      null,
      0,
      "2026-03-12T00:00:00.000Z",
      "2026-03-12T00:10:00.000Z",
      new Date(Date.now() - 1_000).toISOString(),
      null,
    );

    fs.writeFileSync(ctx.configPath, JSON.stringify(ctx.buyerConfig, null, 2));
    const output = await runCliWithEnv("watch --no-auto-release", buyerHome, {
      TACHI_FETCH_SHIM_MODULE: ctx.shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
      TACHI_WATCH_POLL_INTERVAL_MS: "50",
      TACHI_WATCH_RELEASE_INTERVAL_MS: "50",
      TACHI_WATCH_MAX_CYCLES: "2",
    });

    const task = global.__tachiTestDb.prepare("SELECT status FROM tasks WHERE id = ?").get("task-1");
    expect(task.status).toBe("delivered");
    expect(output).not.toContain("Auto-released task task-1");
  });
});
