const fs = require("fs");
const os = require("os");
const path = require("path");

function createTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tachi-security-test-"));
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

function setupServer(customDbFactory) {
  const homeDir = createTempHome();
  process.env.TACHI_HOME = homeDir;
  jest.resetModules();

  const { runMigrations } = require("../db/migrate");
  const { openDatabase } = require("../db");
  const { createApp } = require("../server");
  const { hashApiKey } = require("../lib/hash");

  runMigrations();
  const realDb = openDatabase();
  const db = customDbFactory ? customDbFactory(realDb) : realDb;

  const insertAgent = ({
    id,
    name,
    apiKey,
    capabilities = [],
    rateMin = 0,
    rateMax = 0,
    walletBalance = 0,
    status = "active",
    createdAt = "2026-03-12T00:00:00.000Z",
  }) => {
    realDb.prepare(
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
      0,
      0,
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
    spec = "ship it",
    budgetMax = 10,
    agreedPrice = 10,
    status = "open",
    inputPath = null,
    outputPath = null,
    revisionCount = 0,
    createdAt = "2026-03-12T00:00:00.000Z",
    acceptedAt = null,
    deliveredAt = null,
  }) => {
    realDb.prepare(
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
      null,
      spec,
      1,
      budgetMax,
      agreedPrice,
      7_200_000,
      status,
      inputPath,
      outputPath,
      null,
      revisionCount,
      createdAt,
      acceptedAt,
      deliveredAt,
      null,
    );
  };

  const close = () => {
    realDb.close();
    delete process.env.TACHI_HOME;
    jest.resetModules();
    fs.rmSync(homeDir, { recursive: true, force: true });
  };

  return {
    app: createApp(db),
    db: realDb,
    insertAgent,
    insertTask,
    close,
  };
}

function withRaceOnQuery(query, raceFn) {
  return (db) =>
    new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "prepare") {
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }

        return (sql) => {
          const statement = target.prepare(sql);
          if (!sql.includes(query)) {
            return statement;
          }

          return new Proxy(statement, {
            get(statementTarget, statementProp, statementReceiver) {
              const value = Reflect.get(statementTarget, statementProp, statementReceiver);
              if (statementProp !== "get") {
                return typeof value === "function" ? value.bind(statementTarget) : value;
              }

              return (...args) => {
                const result = statementTarget.get(...args);
                raceFn(target, result, ...args);
                return result;
              };
            },
          });
        };
      },
    });
}

describe("security fixes", () => {
  let ctx;

  afterEach(() => {
    if (ctx) {
      ctx.close();
      ctx = null;
    }
  });

  test("wallet topup rejects fractional cents", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key" });

    const response = await simulateRequest(ctx.app, "POST", "/wallet/topup", {
      headers: { "X-API-Key": "buyer-key" },
      body: { amount: 10.001 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toMatch(/2 decimal places/);
  });

  test("post task rejects fractional-cent budgets", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 100 });

    const response = await simulateRequest(ctx.app, "POST", "/tasks", {
      headers: { "X-API-Key": "buyer-key" },
      body: { capability: "code", spec: "build it", budget_max: 10.001 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toMatch(/2 decimal places/);
  });

  test("task creation fails closed if the buyer balance changes after the pre-check", async () => {
    ctx = setupServer(
      withRaceOnQuery("SELECT wallet_balance FROM agents WHERE id = ? LIMIT 1", (db, _result, agentId) => {
        db.prepare("UPDATE agents SET wallet_balance = 0 WHERE id = ?").run(agentId);
      }),
    );

    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 20 });

    const response = await simulateRequest(ctx.app, "POST", "/tasks", {
      headers: { "X-API-Key": "buyer-key" },
      body: { capability: "code", spec: "build it", budget_max: 10 },
    });

    expect(response.statusCode).toBe(402);
    expect(ctx.db.prepare("SELECT wallet_balance FROM agents WHERE id = ?").get("buyer-1").wallet_balance).toBe(0);
    expect(ctx.db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count).toBe(0);
    expect(ctx.db.prepare("SELECT COUNT(*) AS count FROM transactions").get().count).toBe(0);
  });

  test("approval fails closed if task status changes after the initial read", async () => {
    ctx = setupServer(
      withRaceOnQuery("SELECT * FROM tasks WHERE id = ? LIMIT 1", (db, result, taskId) => {
        if (result && result.status === "delivered") {
          db.prepare("UPDATE tasks SET status = 'approved' WHERE id = ?").run(taskId);
        }
      }),
    );

    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 100 });
    ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key", walletBalance: 0 });
    ctx.insertTask({
      id: "task-1",
      buyerId: "buyer-1",
      sellerId: "seller-1",
      budgetMax: 10,
      agreedPrice: 10,
      status: "delivered",
      deliveredAt: "2026-03-12T01:00:00.000Z",
    });

    const response = await simulateRequest(ctx.app, "POST", "/tasks/task-1/approve", {
      headers: { "X-API-Key": "buyer-key" },
    });

    expect(response.statusCode).toBe(409);
    expect(ctx.db.prepare("SELECT wallet_balance FROM agents WHERE id = ?").get("seller-1").wallet_balance).toBe(0);
    expect(ctx.db.prepare("SELECT COUNT(*) AS count FROM transactions").get().count).toBe(0);
  });

  test("reject fails closed if the buyer balance changes after the initial read", async () => {
    ctx = setupServer(
      withRaceOnQuery("SELECT * FROM tasks WHERE id = ? LIMIT 1", (db, result) => {
        if (result && result.status === "delivered") {
          db.prepare("UPDATE agents SET wallet_balance = 0 WHERE id = ?").run(result.buyer_id);
        }
      }),
    );

    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 100 });
    ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key", walletBalance: 0 });
    ctx.insertTask({
      id: "task-1",
      buyerId: "buyer-1",
      sellerId: "seller-1",
      budgetMax: 10,
      agreedPrice: 10,
      status: "delivered",
      deliveredAt: "2026-03-12T01:00:00.000Z",
    });

    const response = await simulateRequest(ctx.app, "POST", "/tasks/task-1/reject", {
      headers: { "X-API-Key": "buyer-key" },
      body: { reason: "needs changes" },
    });

    expect(response.statusCode).toBe(402);
    expect(ctx.db.prepare("SELECT status, revision_count FROM tasks WHERE id = ?").get("task-1")).toEqual(
      expect.objectContaining({ status: "delivered", revision_count: 0 }),
    );
    expect(ctx.db.prepare("SELECT wallet_balance FROM agents WHERE id = ?").get("seller-1").wallet_balance).toBe(0);
  });

  test("non-participants cannot read private task details once work has started", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 100 });
    ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key", walletBalance: 0 });
    ctx.insertAgent({ id: "outsider-1", name: "outsider", apiKey: "outsider-key", walletBalance: 0 });
    ctx.insertTask({
      id: "task-1",
      buyerId: "buyer-1",
      sellerId: "seller-1",
      status: "delivered",
      inputPath: "/tmp/tachi/input.txt",
      outputPath: "/tmp/tachi/output.txt",
    });

    const response = await simulateRequest(ctx.app, "GET", "/tasks/task-1", {
      headers: { "X-API-Key": "outsider-key" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body.error).toMatch(/participants/);
  });

  test("pii masking redacts Tachi-issued API keys", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 100 });

    const response = await simulateRequest(ctx.app, "POST", "/tasks", {
      headers: { "X-API-Key": "buyer-key" },
      body: {
        capability: "code",
        spec: "Use tachi_0123456789abcdef0123456789abcdef to authenticate",
        budget_max: 10,
        pii_mask: true,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.spec).toContain("[REDACTED:api_key]");
    expect(response.body.spec).not.toContain("tachi_0123456789abcdef0123456789abcdef");
  });

  test("task creation rejects unsafe input_path values", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 100 });

    for (const inputPath of ["../../etc/passwd", "relative/file.txt", "/etc/passwd", "/tmp/tachi/../escape.txt", "/tmp/tachi/file\0.txt"]) {
      const response = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "buyer-key" },
        body: {
          capability: "code",
          spec: "build it",
          budget_max: 10,
          input_path: inputPath,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.body.error).toMatch(/input_path/);
    }
  });

  test("task creation accepts safe input_path values under /tmp/tachi", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 100 });

    const response = await simulateRequest(ctx.app, "POST", "/tasks", {
      headers: { "X-API-Key": "buyer-key" },
      body: {
        capability: "code",
        spec: "build it",
        budget_max: 10,
        input_path: "/tmp/tachi/work/input.txt",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.input_path).toBe("/tmp/tachi/work/input.txt");
  });

  test("deliver rejects unsafe output paths and accepts safe-root paths", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 100 });
    ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key", walletBalance: 0, capabilities: ["code"] });
    ctx.insertTask({
      id: "task-1",
      buyerId: "buyer-1",
      sellerId: "seller-1",
      budgetMax: 10,
      agreedPrice: 10,
      status: "in-progress",
      acceptedAt: "2026-03-12T01:00:00.000Z",
    });

    const invalidResponse = await simulateRequest(ctx.app, "POST", "/tasks/task-1/deliver", {
      headers: { "X-API-Key": "seller-key" },
      body: { output_path: "/etc/cron.d/root" },
    });

    expect(invalidResponse.statusCode).toBe(400);
    expect(invalidResponse.body.error).toMatch(/output_path/);

    const validResponse = await simulateRequest(ctx.app, "POST", "/tasks/task-1/deliver", {
      headers: { "X-API-Key": "seller-key" },
      body: { output_path: "/tmp/tachi/results/output.txt" },
    });

    expect(validResponse.statusCode).toBe(200);
    expect(validResponse.body.output_path).toBe("/tmp/tachi/results/output.txt");
  });

  test("GET /tasks applies strict pagination defaults", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 100 });
    ctx.insertAgent({ id: "seller-1", name: "seller", apiKey: "seller-key", walletBalance: 0 });

    for (let index = 0; index < 60; index += 1) {
      ctx.insertTask({
        id: `task-${index}`,
        buyerId: "buyer-1",
        sellerId: null,
        status: "open",
        createdAt: `2026-03-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      });
    }

    const response = await simulateRequest(ctx.app, "GET", "/tasks", {
      headers: { "X-API-Key": "buyer-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toHaveLength(50);
  });

  test("non-participants can still view open task listings without internal paths", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "buyer-1", name: "buyer", apiKey: "buyer-key", walletBalance: 100 });
    ctx.insertAgent({ id: "outsider-1", name: "outsider", apiKey: "outsider-key", walletBalance: 0 });
    ctx.insertTask({
      id: "task-1",
      buyerId: "buyer-1",
      status: "open",
      inputPath: "/tmp/tachi/input.txt",
      outputPath: "/tmp/tachi/output.txt",
    });

    const response = await simulateRequest(ctx.app, "GET", "/tasks/task-1", {
      headers: { "X-API-Key": "outsider-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.id).toBe("task-1");
    expect(response.body.input_path).toBeUndefined();
    expect(response.body.output_path).toBeUndefined();
  });
});
