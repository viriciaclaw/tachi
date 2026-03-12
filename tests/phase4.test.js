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
  const homeDir = createTempHome("tachi-phase4-test-");
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
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }

  return stripAnsi(output);
}

async function createInProgressTask(ctx, budgetMax = 5) {
  ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 100, capabilities: ["design"] });
  ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key", capabilities: ["code"] });

  const postResponse = await simulateRequest(ctx.app, "POST", "/tasks", {
    headers: { "X-API-Key": "buyer-key" },
    body: {
      capability: "code",
      spec: "ship phase 4",
      budget_max: budgetMax,
      input_path: "/tmp/input.txt",
    },
  });

  const acceptResponse = await simulateRequest(ctx.app, "POST", `/tasks/${postResponse.body.id}/accept`, {
    headers: { "X-API-Key": "seller-key" },
  });

  return {
    taskId: postResponse.body.id,
    postResponse,
    acceptResponse,
  };
}

async function createCliAcceptedTask() {
  const serverHome = createTempHome("tachi-phase4-cli-server-");
  const buyerHome = createTempHome("tachi-phase4-cli-buyer-");
  const sellerHome = createTempHome("tachi-phase4-cli-seller-");
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

  const postOutput = await runCliWithEnv("post --capability code --spec deliver --budget 5 --input /tmp/input.txt", buyerHome, {
    TACHI_FETCH_SHIM_MODULE: shimPath,
    TACHI_TEST_SERVER_HOME: serverHome,
  });
  const taskId = postOutput.match(/Task posted: ([^ ]+)/)?.[1];

  fs.writeFileSync(serverConfigPath, JSON.stringify(sellerConfig, null, 2));
  await runCliWithEnv(`accept ${taskId}`, sellerHome, {
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
    taskId,
  };
}

describe("Phase 4 API", () => {
  let ctx;

  afterEach(() => {
    if (ctx) {
      ctx.close();
      ctx = null;
    }
  });

  describe("deliver", () => {
    test("happy path sets status to delivered, output_path, delivered_at", async () => {
      ctx = setupServer();
      const { taskId } = await createInProgressTask(ctx);

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "seller-key" },
        body: { output_path: "/tmp/output.txt" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual(
        expect.objectContaining({
          id: taskId,
          status: "delivered",
          output_path: "/tmp/output.txt",
          delivered_at: expect.any(String),
        }),
      );
    });

    test("cannot deliver if not the seller", async () => {
      ctx = setupServer();
      const { taskId } = await createInProgressTask(ctx);

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "buyer-key" },
        body: { output_path: "/tmp/output.txt" },
      });

      expect(response.statusCode).toBe(403);
    });

    test("cannot deliver if status is not in-progress or revision", async () => {
      ctx = setupServer();
      const { taskId } = await createInProgressTask(ctx);
      ctx.db.prepare("UPDATE tasks SET status = 'approved' WHERE id = ?").run(taskId);

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "seller-key" },
        body: { output_path: "/tmp/output.txt" },
      });

      expect(response.statusCode).toBe(409);
    });

    test("task not found returns 404", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key", capabilities: ["code"] });

      const response = await simulateRequest(ctx.app, "POST", "/tasks/missing-task/deliver", {
        headers: { "X-API-Key": "seller-key" },
        body: { output_path: "/tmp/output.txt" },
      });

      expect(response.statusCode).toBe(404);
    });

    test("missing output_path returns 400", async () => {
      ctx = setupServer();
      const { taskId } = await createInProgressTask(ctx);

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "seller-key" },
        body: {},
      });

      expect(response.statusCode).toBe(400);
    });

    test("deliver requires auth", async () => {
      ctx = setupServer();
      const { taskId } = await createInProgressTask(ctx);

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        body: { output_path: "/tmp/output.txt" },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe("approve", () => {
    test("happy path releases escrow correctly", async () => {
      ctx = setupServer();
      const { taskId } = await createInProgressTask(ctx, 5);
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "seller-key" },
        body: { output_path: "/tmp/output.txt" },
      });

      const buyerBefore = ctx.db.prepare("SELECT wallet_balance FROM agents WHERE id = ?").get("buyer-1").wallet_balance;
      const sellerBefore = ctx.db.prepare("SELECT wallet_balance FROM agents WHERE id = ?").get("seller-1").wallet_balance;

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/approve`, {
        headers: { "X-API-Key": "buyer-key" },
      });

      const sellerAfter = ctx.db.prepare("SELECT wallet_balance FROM agents WHERE id = ?").get("seller-1").wallet_balance;
      const buyerAfter = ctx.db.prepare("SELECT wallet_balance FROM agents WHERE id = ?").get("buyer-1").wallet_balance;
      const transactions = ctx.db
        .prepare("SELECT type, to_agent, amount FROM transactions WHERE task_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(taskId);

      expect(response.statusCode).toBe(200);
      expect(response.body.status).toBe("approved");
      expect(response.body.completed_at).toEqual(expect.any(String));
      expect(sellerAfter - sellerBefore).toBeCloseTo(4.65, 5);
      expect(buyerAfter - buyerBefore).toBeCloseTo(0.4, 5);
      expect(transactions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "escrow_release", to_agent: "seller-1", amount: 4.65 }),
          expect.objectContaining({ type: "platform_fee", to_agent: null, amount: 0.35 }),
          expect.objectContaining({ type: "escrow_refund", to_agent: "buyer-1", amount: 0.4 }),
        ]),
      );
    });

    test("cannot approve if not the buyer", async () => {
      ctx = setupServer();
      const { taskId } = await createInProgressTask(ctx);
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "seller-key" },
        body: { output_path: "/tmp/output.txt" },
      });

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/approve`, {
        headers: { "X-API-Key": "seller-key" },
      });

      expect(response.statusCode).toBe(403);
    });

    test("cannot approve if status is not delivered", async () => {
      ctx = setupServer();
      const { taskId } = await createInProgressTask(ctx);

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/approve`, {
        headers: { "X-API-Key": "buyer-key" },
      });

      expect(response.statusCode).toBe(409);
    });

    test("cannot approve already approved task", async () => {
      ctx = setupServer();
      const { taskId } = await createInProgressTask(ctx);
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "seller-key" },
        body: { output_path: "/tmp/output.txt" },
      });
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/approve`, {
        headers: { "X-API-Key": "buyer-key" },
      });

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/approve`, {
        headers: { "X-API-Key": "buyer-key" },
      });

      expect(response.statusCode).toBe(409);
    });

    test("approve requires auth", async () => {
      ctx = setupServer();
      const { taskId } = await createInProgressTask(ctx);
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "seller-key" },
        body: { output_path: "/tmp/output.txt" },
      });

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/approve`);

      expect(response.statusCode).toBe(401);
    });
  });

  describe("reject", () => {
    test("happy path first rejection sets status to revision and revision_count to 1", async () => {
      ctx = setupServer();
      const { taskId } = await createInProgressTask(ctx);
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "seller-key" },
        body: { output_path: "/tmp/output.txt" },
      });

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/reject`, {
        headers: { "X-API-Key": "buyer-key" },
        body: { reason: "Needs revision" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body.status).toBe("revision");
      expect(response.body.revision_count).toBe(1);
      expect(response.body.rejection_reason).toBe("Needs revision");
    });

    test("first rejection pays compute fee to seller", async () => {
      ctx = setupServer();
      const { taskId } = await createInProgressTask(ctx, 5);
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "seller-key" },
        body: { output_path: "/tmp/output.txt" },
      });

      const sellerBefore = ctx.db.prepare("SELECT wallet_balance FROM agents WHERE id = ?").get("seller-1").wallet_balance;

      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/reject`, {
        headers: { "X-API-Key": "buyer-key" },
        body: { reason: "Try again" },
      });

      const sellerAfter = ctx.db.prepare("SELECT wallet_balance FROM agents WHERE id = ?").get("seller-1").wallet_balance;
      const transaction = ctx.db
        .prepare("SELECT type, to_agent, amount FROM transactions WHERE task_id = ? AND type = 'compute_fee' LIMIT 1")
        .get(taskId);

      expect(sellerAfter - sellerBefore).toBeCloseTo(1.25, 5);
      expect(transaction).toEqual({
        type: "compute_fee",
        to_agent: "seller-1",
        amount: 1.25,
      });
    });

    test("second rejection sets status to disputed", async () => {
      ctx = setupServer();
      const { taskId } = await createInProgressTask(ctx);
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "seller-key" },
        body: { output_path: "/tmp/output.txt" },
      });
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/reject`, {
        headers: { "X-API-Key": "buyer-key" },
        body: { reason: "First pass failed" },
      });
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "seller-key" },
        body: { output_path: "/tmp/output-v2.txt" },
      });

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/reject`, {
        headers: { "X-API-Key": "buyer-key" },
        body: { reason: "Still not correct" },
      });

      const computeFees = ctx.db
        .prepare("SELECT COUNT(*) AS count FROM transactions WHERE task_id = ? AND type = 'compute_fee'")
        .get(taskId).count;

      expect(response.statusCode).toBe(200);
      expect(response.body.status).toBe("disputed");
      expect(response.body.revision_count).toBe(1);
      expect(computeFees).toBe(1);
    });

    test("cannot reject if not the buyer", async () => {
      ctx = setupServer();
      const { taskId } = await createInProgressTask(ctx);
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "seller-key" },
        body: { output_path: "/tmp/output.txt" },
      });

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/reject`, {
        headers: { "X-API-Key": "seller-key" },
        body: { reason: "Nope" },
      });

      expect(response.statusCode).toBe(403);
    });

    test("cannot reject if status is not delivered", async () => {
      ctx = setupServer();
      const { taskId } = await createInProgressTask(ctx);

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/reject`, {
        headers: { "X-API-Key": "buyer-key" },
        body: { reason: "Nope" },
      });

      expect(response.statusCode).toBe(409);
    });

    test("missing reason returns 400", async () => {
      ctx = setupServer();
      const { taskId } = await createInProgressTask(ctx);
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "seller-key" },
        body: { output_path: "/tmp/output.txt" },
      });

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/reject`, {
        headers: { "X-API-Key": "buyer-key" },
        body: {},
      });

      expect(response.statusCode).toBe(400);
    });

    test("reject requires auth", async () => {
      ctx = setupServer();
      const { taskId } = await createInProgressTask(ctx);
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "seller-key" },
        body: { output_path: "/tmp/output.txt" },
      });

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/reject`, {
        body: { reason: "Nope" },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe("revision round", () => {
    test("after rejection seller can re-deliver", async () => {
      ctx = setupServer();
      const { taskId } = await createInProgressTask(ctx);
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "seller-key" },
        body: { output_path: "/tmp/output.txt" },
      });
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/reject`, {
        headers: { "X-API-Key": "buyer-key" },
        body: { reason: "Revise" },
      });

      ctx.db.prepare("UPDATE tasks SET delivered_at = ? WHERE id = ?").run("2026-03-12T00:00:00.000Z", taskId);

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "seller-key" },
        body: { output_path: "/tmp/output-v2.txt" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body.status).toBe("delivered");
      expect(response.body.output_path).toBe("/tmp/output-v2.txt");
      expect(response.body.delivered_at).not.toBe("2026-03-12T00:00:00.000Z");
    });

    test("after re-deliver buyer can approve", async () => {
      ctx = setupServer();
      const { taskId } = await createInProgressTask(ctx, 5);
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "seller-key" },
        body: { output_path: "/tmp/output.txt" },
      });
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/reject`, {
        headers: { "X-API-Key": "buyer-key" },
        body: { reason: "Revise" },
      });
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "seller-key" },
        body: { output_path: "/tmp/output-v2.txt" },
      });

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/approve`, {
        headers: { "X-API-Key": "buyer-key" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body.status).toBe("approved");
    });

    test("after re-deliver buyer can reject again into disputed", async () => {
      ctx = setupServer();
      const { taskId } = await createInProgressTask(ctx);
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "seller-key" },
        body: { output_path: "/tmp/output.txt" },
      });
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/reject`, {
        headers: { "X-API-Key": "buyer-key" },
        body: { reason: "Revise" },
      });
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "seller-key" },
        body: { output_path: "/tmp/output-v2.txt" },
      });

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/reject`, {
        headers: { "X-API-Key": "buyer-key" },
        body: { reason: "Escalate" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body.status).toBe("disputed");
    });
  });

  describe("task detail", () => {
    test("GET /tasks/:id returns full task with input_path/output_path", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key" });
      ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key" });
      ctx.insertTask({
        id: "task-1",
        buyerId: "buyer-1",
        sellerId: "seller-1",
        status: "delivered",
        inputPath: "/tmp/input.txt",
        outputPath: "/tmp/output.txt",
      });

      const response = await simulateRequest(ctx.app, "GET", "/tasks/task-1", {
        headers: { "X-API-Key": "buyer-key" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body.input_path).toBe("/tmp/input.txt");
      expect(response.body.output_path).toBe("/tmp/output.txt");
    });

    test("task not found returns 404", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key" });

      const response = await simulateRequest(ctx.app, "GET", "/tasks/missing-task", {
        headers: { "X-API-Key": "buyer-key" },
      });

      expect(response.statusCode).toBe(404);
    });

    test("requires auth", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key" });
      ctx.insertTask({ id: "task-1", buyerId: "buyer-1" });

      const response = await simulateRequest(ctx.app, "GET", "/tasks/task-1");

      expect(response.statusCode).toBe(401);
    });
  });
});

describe("Phase 4 CLI", () => {
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

  test("tachi deliver prints success", async () => {
    const cliCtx = await createCliAcceptedTask();
    buyerHome = cliCtx.buyerHome;
    sellerHome = cliCtx.sellerHome;
    serverHome = cliCtx.serverHome;

    fs.writeFileSync(cliCtx.serverConfigPath, JSON.stringify(cliCtx.sellerConfig, null, 2));
    const output = await runCliWithEnv(`deliver ${cliCtx.taskId} --output /tmp/output.txt`, sellerHome, {
      TACHI_FETCH_SHIM_MODULE: cliCtx.shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
    });

    expect(output).toContain(`Delivered task ${cliCtx.taskId}. Status: delivered. Awaiting buyer review.`);
  });

  test("tachi approve prints success", async () => {
    const cliCtx = await createCliAcceptedTask();
    buyerHome = cliCtx.buyerHome;
    sellerHome = cliCtx.sellerHome;
    serverHome = cliCtx.serverHome;

    fs.writeFileSync(cliCtx.serverConfigPath, JSON.stringify(cliCtx.sellerConfig, null, 2));
    await runCliWithEnv(`deliver ${cliCtx.taskId} --output /tmp/output.txt`, sellerHome, {
      TACHI_FETCH_SHIM_MODULE: cliCtx.shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
    });

    fs.writeFileSync(cliCtx.serverConfigPath, JSON.stringify(cliCtx.buyerConfig, null, 2));
    const output = await runCliWithEnv(`approve ${cliCtx.taskId}`, buyerHome, {
      TACHI_FETCH_SHIM_MODULE: cliCtx.shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
    });

    expect(output).toContain(`Approved task ${cliCtx.taskId}. Payment released to seller.`);
  });

  test("tachi reject prints success", async () => {
    const cliCtx = await createCliAcceptedTask();
    buyerHome = cliCtx.buyerHome;
    sellerHome = cliCtx.sellerHome;
    serverHome = cliCtx.serverHome;

    fs.writeFileSync(cliCtx.serverConfigPath, JSON.stringify(cliCtx.sellerConfig, null, 2));
    await runCliWithEnv(`deliver ${cliCtx.taskId} --output /tmp/output.txt`, sellerHome, {
      TACHI_FETCH_SHIM_MODULE: cliCtx.shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
    });

    fs.writeFileSync(cliCtx.serverConfigPath, JSON.stringify(cliCtx.buyerConfig, null, 2));
    const output = await runCliWithEnv(`reject ${cliCtx.taskId} --reason needs-revision`, buyerHome, {
      TACHI_FETCH_SHIM_MODULE: cliCtx.shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
    });

    expect(output).toContain(`Rejected task ${cliCtx.taskId}. Reason: needs-revision`);
  });

  test("tachi status prints task details", async () => {
    const cliCtx = await createCliAcceptedTask();
    buyerHome = cliCtx.buyerHome;
    sellerHome = cliCtx.sellerHome;
    serverHome = cliCtx.serverHome;

    fs.writeFileSync(cliCtx.serverConfigPath, JSON.stringify(cliCtx.sellerConfig, null, 2));
    await runCliWithEnv(`deliver ${cliCtx.taskId} --output /tmp/output.txt`, sellerHome, {
      TACHI_FETCH_SHIM_MODULE: cliCtx.shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
    });

    fs.writeFileSync(cliCtx.serverConfigPath, JSON.stringify(cliCtx.buyerConfig, null, 2));
    const output = await runCliWithEnv(`status ${cliCtx.taskId}`, buyerHome, {
      TACHI_FETCH_SHIM_MODULE: cliCtx.shimPath,
      TACHI_TEST_SERVER_HOME: serverHome,
    });

    expect(output).toContain(`ID: ${cliCtx.taskId}`);
    expect(output).toContain("Status: delivered");
    expect(output).toContain("Capability: code");
    expect(output).toContain("Buyer:");
    expect(output).toContain("Seller:");
    expect(output).toContain("Budget: $5");
    expect(output).toContain("Agreed Price: $5");
  });
});
