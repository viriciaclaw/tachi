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
  const homeDir = createTempHome("tachi-phase5-test-");
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

  return {
    app: createApp(db),
    db,
    insertAgent,
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
  const originalPollInterval = process.env.TACHI_POLL_INTERVAL_MS;
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
    if (originalPollInterval === undefined) {
      delete process.env.TACHI_POLL_INTERVAL_MS;
    } else {
      process.env.TACHI_POLL_INTERVAL_MS = originalPollInterval;
    }
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }

  return stripAnsi(output);
}

function createFetchForApp(app) {
  return async function fetchForApp(url, options = {}) {
    const parsedUrl = new URL(url);
    const method = (options.method || "GET").toUpperCase();
    const headers = options.headers || {};
    let body = options.body;

    if (typeof body === "string" && headers["Content-Type"] === "application/json") {
      body = JSON.parse(body);
    }

    const response = await simulateRequest(app, method, parsedUrl.pathname, {
      headers,
      body,
    });

    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      async json() {
        return response.body;
      },
    };
  };
}

async function createCallCliContext() {
  const serverHome = createTempHome("tachi-phase5-cli-server-");
  const buyerHome = createTempHome("tachi-phase5-cli-buyer-");
  const sellerHome = createTempHome("tachi-phase5-cli-seller-");
  const serverConfigPath = path.join(serverHome, "config.json");
  const shimPath = path.join(__dirname, "helpers", "cli-fetch-shim.js");

  fs.writeFileSync(
    serverConfigPath,
    JSON.stringify({ server_url: "http://tachi.test", api_key: null, agent_id: null }, null, 2),
  );

  await runCliWithEnv("register --name buyer --capabilities design", buyerHome, {
    TACHI_FETCH_SHIM_MODULE: shimPath,
    TACHI_TEST_SERVER_HOME: serverHome,
  });
  const buyerConfig = JSON.parse(fs.readFileSync(serverConfigPath, "utf8"));

  await runCliWithEnv("register --name seller --capabilities code", sellerHome, {
    TACHI_FETCH_SHIM_MODULE: shimPath,
    TACHI_TEST_SERVER_HOME: serverHome,
  });
  const sellerConfig = JSON.parse(fs.readFileSync(serverConfigPath, "utf8"));

  fs.writeFileSync(serverConfigPath, JSON.stringify(buyerConfig, null, 2));
  await runCliWithEnv("wallet topup 100", buyerHome, {
    TACHI_FETCH_SHIM_MODULE: shimPath,
    TACHI_TEST_SERVER_HOME: serverHome,
  });

  return {
    buyerConfig,
    buyerHome,
    sellerConfig,
    sellerHome,
    serverConfigPath,
    serverHome,
    shimPath,
  };
}

function scheduleSpecialistLifecycle(sellerId, outputPath = "/tmp/output.txt") {
  setTimeout(() => {
    const db = global.__tachiTestDb;
    if (!db) {
      return;
    }

    const task = db
      .prepare("SELECT * FROM tasks WHERE status IN ('open', 'matched') ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get();
    if (!task) {
      return;
    }

    db.prepare(
      "UPDATE tasks SET seller_id = ?, status = 'in-progress', agreed_price = ?, accepted_at = ? WHERE id = ?",
    ).run(sellerId, task.budget_max, new Date().toISOString(), task.id);

    setTimeout(() => {
      const innerDb = global.__tachiTestDb;
      if (!innerDb) {
        return;
      }

      innerDb.prepare("UPDATE tasks SET status = 'delivered', output_path = ?, delivered_at = ? WHERE id = ?").run(
        outputPath,
        new Date().toISOString(),
        task.id,
      );
    }, 60);
  }, 60);
}

describe("Phase 5: tachi call", () => {
  let ctx;
  let buyerHome;
  let sellerHome;
  let serverHome;

  afterEach(() => {
    if (ctx) {
      ctx.close();
      ctx = null;
    }

    delete global.__tachiTestDb;
    delete global.__tachiTestApp;

    for (const home of [buyerHome, sellerHome, serverHome]) {
      if (home) {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }

    buyerHome = null;
    sellerHome = null;
    serverHome = null;
  });

  describe("polling logic", () => {
    test("posts task and detects accept on first poll", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 100, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key", capabilities: ["code"] });

      const postResponse = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "buyer-key" },
        body: {
          capability: "code",
          spec: "ship phase 5",
          budget_max: 5,
        },
      });

      ctx.db
        .prepare("UPDATE tasks SET seller_id = ?, status = 'in-progress', agreed_price = ?, accepted_at = ? WHERE id = ?")
        .run("seller-1", 5, new Date().toISOString(), postResponse.body.id);

      const { pollForStatus } = require("../cli/commands/call");
      const task = await pollForStatus(
        "http://tachi.test",
        "buyer-key",
        postResponse.body.id,
        ["in-progress"],
        200,
        20,
        { fetchImpl: createFetchForApp(ctx.app) },
      );

      expect(task).toEqual(
        expect.objectContaining({
          id: postResponse.body.id,
          status: "in-progress",
          seller_id: "seller-1",
        }),
      );
    });

    test("posts task and times out when no specialist accepts", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 100, capabilities: ["design"] });

      const postResponse = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "buyer-key" },
        body: {
          capability: "code",
          spec: "ship phase 5",
          budget_max: 5,
        },
      });

      const { pollForStatus } = require("../cli/commands/call");
      const task = await pollForStatus(
        "http://tachi.test",
        "buyer-key",
        postResponse.body.id,
        ["in-progress"],
        120,
        30,
        { fetchImpl: createFetchForApp(ctx.app) },
      );

      expect(task).toBeNull();
    });

    test("detects delivery after accept", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 100, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key", capabilities: ["code"] });

      const postResponse = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "buyer-key" },
        body: {
          capability: "code",
          spec: "ship phase 5",
          budget_max: 5,
        },
      });

      ctx.db
        .prepare("UPDATE tasks SET seller_id = ?, status = 'in-progress', agreed_price = ?, accepted_at = ? WHERE id = ?")
        .run("seller-1", 5, new Date().toISOString(), postResponse.body.id);
      ctx.db
        .prepare("UPDATE tasks SET status = 'delivered', output_path = ?, delivered_at = ? WHERE id = ?")
        .run("/tmp/output.txt", new Date().toISOString(), postResponse.body.id);

      const { pollForStatus } = require("../cli/commands/call");
      const task = await pollForStatus(
        "http://tachi.test",
        "buyer-key",
        postResponse.body.id,
        ["delivered"],
        200,
        20,
        { fetchImpl: createFetchForApp(ctx.app) },
      );

      expect(task).toEqual(
        expect.objectContaining({
          id: postResponse.body.id,
          status: "delivered",
          output_path: "/tmp/output.txt",
        }),
      );
    });

    test("auto-approve after delivery updates status", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 100, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key", capabilities: ["code"] });

      const postResponse = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "buyer-key" },
        body: {
          capability: "code",
          spec: "ship phase 5",
          budget_max: 5,
        },
      });

      ctx.db
        .prepare("UPDATE tasks SET seller_id = ?, status = 'delivered', agreed_price = ?, accepted_at = ?, delivered_at = ?, output_path = ? WHERE id = ?")
        .run("seller-1", 5, new Date().toISOString(), new Date().toISOString(), "/tmp/output.txt", postResponse.body.id);

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${postResponse.body.id}/approve`, {
        headers: { "X-API-Key": "buyer-key" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body.status).toBe("approved");
    });

    test("times out on delivery wait", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 100, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key", capabilities: ["code"] });

      const postResponse = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "buyer-key" },
        body: {
          capability: "code",
          spec: "ship phase 5",
          budget_max: 5,
        },
      });

      ctx.db
        .prepare("UPDATE tasks SET seller_id = ?, status = 'in-progress', agreed_price = ?, accepted_at = ? WHERE id = ?")
        .run("seller-1", 5, new Date().toISOString(), postResponse.body.id);

      const { pollForStatus } = require("../cli/commands/call");
      const task = await pollForStatus(
        "http://tachi.test",
        "buyer-key",
        postResponse.body.id,
        ["delivered"],
        120,
        30,
        { fetchImpl: createFetchForApp(ctx.app) },
      );

      expect(task).toBeNull();
    });
  });

  describe("CLI integration", () => {
    test("call with auto-approve prints full flow", async () => {
      const cliCtx = await createCallCliContext();
      buyerHome = cliCtx.buyerHome;
      sellerHome = cliCtx.sellerHome;
      serverHome = cliCtx.serverHome;

      fs.writeFileSync(cliCtx.serverConfigPath, JSON.stringify(cliCtx.buyerConfig, null, 2));
      scheduleSpecialistLifecycle(cliCtx.sellerConfig.agent_id);

      const output = await runCliWithEnv(
        "call code --spec deliver-phase-5 --budget 5 --auto-approve --timeout 3000 --delivery-timeout 3000",
        buyerHome,
        {
          TACHI_FETCH_SHIM_MODULE: cliCtx.shimPath,
          TACHI_TEST_SERVER_HOME: serverHome,
          TACHI_POLL_INTERVAL_MS: "50",
        },
      );

      expect(output).toContain("Task posted:");
      expect(output).toContain(`Specialist ${cliCtx.sellerConfig.agent_id} accepted! Waiting for delivery...`);
      expect(output).toContain("Work delivered! Output: /tmp/output.txt");
      expect(output).toContain("Auto-approved task");
    });

    test("call without auto-approve prints review instructions", async () => {
      const cliCtx = await createCallCliContext();
      buyerHome = cliCtx.buyerHome;
      sellerHome = cliCtx.sellerHome;
      serverHome = cliCtx.serverHome;

      fs.writeFileSync(cliCtx.serverConfigPath, JSON.stringify(cliCtx.buyerConfig, null, 2));
      scheduleSpecialistLifecycle(cliCtx.sellerConfig.agent_id, "/tmp/final-output.txt");

      const output = await runCliWithEnv(
        "call code --spec deliver-phase-5 --budget 5 --timeout 3000 --delivery-timeout 3000",
        buyerHome,
        {
          TACHI_FETCH_SHIM_MODULE: cliCtx.shimPath,
          TACHI_TEST_SERVER_HOME: serverHome,
          TACHI_POLL_INTERVAL_MS: "50",
        },
      );

      const taskId = output.match(/Task posted: ([^.]+)/)?.[1];

      expect(output).toContain("Task posted:");
      expect(output).toContain("Work delivered! Output: /tmp/final-output.txt");
      expect(output).toContain(`Task ${taskId} delivered. Review with: tachi status ${taskId}`);
      expect(output).toContain(`Approve: tachi approve ${taskId}`);
      expect(output).toContain(`Reject: tachi reject ${taskId} --reason <text>`);
    });
  });
});
