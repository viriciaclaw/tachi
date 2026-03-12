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
  const homeDir = createTempHome("tachi-phase3-test-");
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
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  let output = "";

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
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }

  return stripAnsi(output);
}

describe("Phase 3 API", () => {
  let ctx;

  afterEach(() => {
    if (ctx) {
      ctx.close();
      ctx = null;
    }
  });

  test("successful post returns 201 with task object, status 'open'", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 20 });

    const response = await simulateRequest(ctx.app, "POST", "/tasks", {
      headers: { "X-API-Key": "buyer-key" },
      body: {
        capability: "code",
        spec: "write tests",
        budget_max: 10,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        buyer_id: "buyer-1",
        capability: "code",
        spec: "write tests",
        budget_max: 10,
        status: "open",
      }),
    );
  });

  test("wallet balance reduced by budget_max * 1.08", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 50 });

    const response = await simulateRequest(ctx.app, "POST", "/tasks", {
      headers: { "X-API-Key": "buyer-key" },
      body: {
        capability: "code",
        spec: "write tests",
        budget_max: 10,
      },
    });

    const balance = ctx.db.prepare("SELECT wallet_balance FROM agents WHERE id = ?").get("buyer-1").wallet_balance;

    expect(response.statusCode).toBe(201);
    expect(balance).toBeCloseTo(39.2, 5);
  });

  test("escrow transaction created with correct amount", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 50 });

    const response = await simulateRequest(ctx.app, "POST", "/tasks", {
      headers: { "X-API-Key": "buyer-key" },
      body: {
        capability: "code",
        spec: "write tests",
        budget_max: 10,
      },
    });

    const transaction = ctx.db
      .prepare("SELECT task_id, from_agent, amount, type FROM transactions WHERE task_id = ? LIMIT 1")
      .get(response.body.id);

    expect(transaction).toEqual({
      task_id: response.body.id,
      from_agent: "buyer-1",
      amount: 10.8,
      type: "escrow_hold",
    });
  });

  test("missing capability returns 400", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 20 });

    const response = await simulateRequest(ctx.app, "POST", "/tasks", {
      headers: { "X-API-Key": "buyer-key" },
      body: {
        spec: "write tests",
        budget_max: 10,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toMatch(/capability/);
  });

  test("missing spec returns 400", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 20 });

    const response = await simulateRequest(ctx.app, "POST", "/tasks", {
      headers: { "X-API-Key": "buyer-key" },
      body: {
        capability: "code",
        budget_max: 10,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toMatch(/spec/);
  });

  test("budget 0 or negative returns 400", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 20 });

    const response = await simulateRequest(ctx.app, "POST", "/tasks", {
      headers: { "X-API-Key": "buyer-key" },
      body: {
        capability: "code",
        spec: "write tests",
        budget_max: 0,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toMatch(/budget_max/);
  });

  test("insufficient wallet balance returns 402", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 5 });

    const response = await simulateRequest(ctx.app, "POST", "/tasks", {
      headers: { "X-API-Key": "buyer-key" },
      body: {
        capability: "code",
        spec: "write tests",
        budget_max: 10,
      },
    });

    expect(response.statusCode).toBe(402);
    expect(response.body.error).toMatch(/Insufficient wallet balance/);
  });

  test("new agent ($10 cap) - budget over $10 returns 400", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 100 });

    const response = await simulateRequest(ctx.app, "POST", "/tasks", {
      headers: { "X-API-Key": "buyer-key" },
      body: {
        capability: "code",
        spec: "write tests",
        budget_max: 12,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toMatch(/limited to \$10/);
  });

  test("agent with 3+ completed tasks can post > $10", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 100 });
    ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key", capabilities: ["code"] });
    ctx.insertTask({ id: "task-1", buyerId: "buyer-1", sellerId: "seller-1", status: "approved" });
    ctx.insertTask({ id: "task-2", buyerId: "buyer-1", sellerId: "seller-1", status: "approved" });
    ctx.insertTask({ id: "task-3", buyerId: "buyer-1", sellerId: "seller-1", status: "approved" });

    const response = await simulateRequest(ctx.app, "POST", "/tasks", {
      headers: { "X-API-Key": "buyer-key" },
      body: {
        capability: "code",
        spec: "large task",
        budget_max: 12,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.budget_max).toBe(12);
  });

  test("returns open tasks", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key" });
    ctx.insertTask({ id: "task-open", buyerId: "buyer-1", status: "open", description: "open task" });
    ctx.insertTask({ id: "task-matched", buyerId: "buyer-1", status: "matched" });

    const response = await simulateRequest(ctx.app, "GET", "/tasks", {
      headers: { "X-API-Key": "buyer-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].id).toBe("task-open");
  });

  test("filters by capability", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key" });
    ctx.insertTask({ id: "task-code", buyerId: "buyer-1", capability: "code", status: "open" });
    ctx.insertTask({ id: "task-design", buyerId: "buyer-1", capability: "design", status: "open" });

    const response = await simulateRequest(ctx.app, "GET", "/tasks?capability=design", {
      headers: { "X-API-Key": "buyer-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].id).toBe("task-design");
  });

  test("filters by status", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key" });
    ctx.insertTask({ id: "task-open", buyerId: "buyer-1", status: "open" });
    ctx.insertTask({ id: "task-progress", buyerId: "buyer-1", status: "in-progress" });

    const response = await simulateRequest(ctx.app, "GET", "/tasks?status=in-progress", {
      headers: { "X-API-Key": "buyer-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].id).toBe("task-progress");
  });

  test("does not expose input_path/output_path", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key" });
    ctx.insertTask({
      id: "task-open",
      buyerId: "buyer-1",
      status: "open",
      inputPath: "/secret/input.txt",
      outputPath: "/secret/output.txt",
    });

    const response = await simulateRequest(ctx.app, "GET", "/tasks", {
      headers: { "X-API-Key": "buyer-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body[0].input_path).toBeUndefined();
    expect(response.body[0].output_path).toBeUndefined();
  });

  test("GET /tasks requires auth", async () => {
    ctx = setupServer();

    const response = await simulateRequest(ctx.app, "GET", "/tasks");

    expect(response.statusCode).toBe(401);
  });

  test("successful accept sets status to 'in-progress' and seller_id", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key" });
    ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key", capabilities: ["code"], rateMin: 5 });
    ctx.insertTask({ id: "task-1", buyerId: "buyer-1", capability: "code", budgetMax: 10, status: "open" });

    const response = await simulateRequest(ctx.app, "POST", "/tasks/task-1/accept", {
      headers: { "X-API-Key": "seller-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe("in-progress");
    expect(response.body.seller_id).toBe("seller-1");
  });

  test("accept sets accepted_at timestamp", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key" });
    ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key", capabilities: ["code"], rateMin: 5 });
    ctx.insertTask({ id: "task-1", buyerId: "buyer-1", capability: "code", budgetMax: 10, status: "open" });

    const response = await simulateRequest(ctx.app, "POST", "/tasks/task-1/accept", {
      headers: { "X-API-Key": "seller-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.accepted_at).toEqual(expect.any(String));
  });

  test("cannot accept task already in-progress (409)", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key" });
    ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key", capabilities: ["code"], rateMin: 5 });
    ctx.insertTask({ id: "task-1", buyerId: "buyer-1", capability: "code", budgetMax: 10, status: "in-progress" });

    const response = await simulateRequest(ctx.app, "POST", "/tasks/task-1/accept", {
      headers: { "X-API-Key": "seller-key" },
    });

    expect(response.statusCode).toBe(409);
  });

  test("cannot accept own task (403)", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", capabilities: ["code"], rateMin: 5 });
    ctx.insertTask({ id: "task-1", buyerId: "buyer-1", capability: "code", budgetMax: 10, status: "open" });

    const response = await simulateRequest(ctx.app, "POST", "/tasks/task-1/accept", {
      headers: { "X-API-Key": "buyer-key" },
    });

    expect(response.statusCode).toBe(403);
  });

  test("cannot accept without matching capability (403)", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key" });
    ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key", capabilities: ["design"], rateMin: 5 });
    ctx.insertTask({ id: "task-1", buyerId: "buyer-1", capability: "code", budgetMax: 10, status: "open" });

    const response = await simulateRequest(ctx.app, "POST", "/tasks/task-1/accept", {
      headers: { "X-API-Key": "seller-key" },
    });

    expect(response.statusCode).toBe(403);
  });

  test("task not found returns 404", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key", capabilities: ["code"], rateMin: 5 });

    const response = await simulateRequest(ctx.app, "POST", "/tasks/missing/accept", {
      headers: { "X-API-Key": "seller-key" },
    });

    expect(response.statusCode).toBe(404);
  });

  test("accept requires auth", async () => {
    ctx = setupServer();

    const response = await simulateRequest(ctx.app, "POST", "/tasks/task-1/accept");

    expect(response.statusCode).toBe(401);
  });

  test("matching engine finds specialist with matching capability", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 20 });
    ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key", capabilities: ["code"], rateMin: 5 });

    const response = await simulateRequest(ctx.app, "POST", "/tasks", {
      headers: { "X-API-Key": "buyer-key" },
      body: {
        capability: "code",
        spec: "write tests",
        budget_max: 10,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.status).toBe("matched");
    expect(response.body.seller_id).toBe("seller-1");
  });

  test("matching engine prefers higher-rated specialist", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 20 });
    ctx.insertAgent({
      id: "seller-1",
      name: "seller-low",
      apiKey: "seller-low-key",
      capabilities: ["code"],
      rateMin: 5,
      ratingAvg: 4.5,
      ratingCount: 20,
    });
    ctx.insertAgent({
      id: "seller-2",
      name: "seller-high",
      apiKey: "seller-high-key",
      capabilities: ["code"],
      rateMin: 5,
      ratingAvg: 4.9,
      ratingCount: 2,
    });

    const response = await simulateRequest(ctx.app, "POST", "/tasks", {
      headers: { "X-API-Key": "buyer-key" },
      body: {
        capability: "code",
        spec: "write tests",
        budget_max: 10,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.seller_id).toBe("seller-2");
  });

  test("matching engine excludes buyer from matches", async () => {
    ctx = setupServer();
    ctx.insertAgent({
      id: "buyer-1",
      name: "buyer",
      apiKey: "buyer-key",
      walletBalance: 20,
      capabilities: ["code"],
      rateMin: 0,
      ratingAvg: 5,
      ratingCount: 100,
    });
    ctx.insertAgent({
      id: "seller-1",
      name: "seller",
      apiKey: "seller-key",
      capabilities: ["code"],
      rateMin: 5,
      ratingAvg: 4,
      ratingCount: 10,
    });

    const response = await simulateRequest(ctx.app, "POST", "/tasks", {
      headers: { "X-API-Key": "buyer-key" },
      body: {
        capability: "code",
        spec: "write tests",
        budget_max: 10,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.seller_id).toBe("seller-1");
  });

  test("no match leaves task as 'open'", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 20 });
    ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key", capabilities: ["design"], rateMin: 5 });

    const response = await simulateRequest(ctx.app, "POST", "/tasks", {
      headers: { "X-API-Key": "buyer-key" },
      body: {
        capability: "code",
        spec: "write tests",
        budget_max: 10,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.status).toBe("open");
    expect(response.body.seller_id).toBeNull();
  });
});

describe("Phase 3 CLI", () => {
  let buyerHome;
  let sellerHome;
  let serverHome;

  afterEach(() => {
    for (const home of [buyerHome, sellerHome, serverHome]) {
      if (home) {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
    buyerHome = null;
    sellerHome = null;
    serverHome = null;
  });

  test("tachi post prints posted task details", async () => {
    serverHome = createTempHome("tachi-phase3-cli-server-");
    buyerHome = createTempHome("tachi-phase3-cli-buyer-");
    const configPath = path.join(buyerHome, "config.json");
    const shimPath = path.join(__dirname, "helpers", "cli-fetch-shim.js");

    fs.writeFileSync(
      configPath,
      JSON.stringify({ server_url: "http://tachi.test", api_key: null, agent_id: null }, null, 2),
    );

    await runCliWithEnv("register --name buyer --capabilities code", buyerHome, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
    });
    await runCliWithEnv("wallet topup 20", buyerHome, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
    });

    const output = await runCliWithEnv("post --capability code --spec deliver --budget 10", buyerHome, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
    });

    expect(output).toContain("Task posted:");
    expect(output).toContain("budget: $10");
  });

  test("tachi find prints task table", async () => {
    serverHome = createTempHome("tachi-phase3-cli-server-");
    buyerHome = createTempHome("tachi-phase3-cli-buyer-");
    const configPath = path.join(buyerHome, "config.json");
    const shimPath = path.join(__dirname, "helpers", "cli-fetch-shim.js");

    fs.writeFileSync(
      configPath,
      JSON.stringify({ server_url: "http://tachi.test", api_key: null, agent_id: null }, null, 2),
    );

    await runCliWithEnv("register --name buyer --capabilities code", buyerHome, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
    });
    await runCliWithEnv("wallet topup 20", buyerHome, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
    });
    await runCliWithEnv("post --capability code --spec deliver --budget 10 --description sample-task", buyerHome, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
    });

    const output = await runCliWithEnv("find", buyerHome, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
    });

    expect(output).toContain("ID | Capability | Budget | Status | Description");
    expect(output).toContain("sample-task");
  });

  test("tachi accept accepts a task", async () => {
    serverHome = createTempHome("tachi-phase3-cli-server-");
    buyerHome = createTempHome("tachi-phase3-cli-buyer-");
    sellerHome = createTempHome("tachi-phase3-cli-seller-");
    const serverConfigPath = path.join(serverHome, "config.json");
    const shimPath = path.join(__dirname, "helpers", "cli-fetch-shim.js");

    fs.writeFileSync(serverConfigPath, JSON.stringify({ server_url: "http://tachi.test", api_key: null, agent_id: null }, null, 2));

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
    await runCliWithEnv("wallet topup 20", buyerHome, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
    });

    const postOutput = await runCliWithEnv("post --capability code --spec deliver --budget 10", buyerHome, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
    });
    const taskId = postOutput.match(/Task posted: ([^ ]+)/)?.[1];

    fs.writeFileSync(serverConfigPath, JSON.stringify(sellerConfig, null, 2));
    const output = await runCliWithEnv(`accept ${taskId}`, sellerHome, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
    });

    expect(output).toContain(`Accepted task ${taskId}. Status: in-progress. Get to work!`);
  });
});
