const fs = require("fs");
const os = require("os");
const path = require("path");

function createTempHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createMockRequest(app, method, requestPath, headers = {}, body) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );

  const req = Object.create(app.request);
  req.app = app;
  req.method = method.toUpperCase();
  req.url = requestPath;
  req.originalUrl = requestPath;
  req.path = requestPath;
  req.headers = normalizedHeaders;
  req.body = body;
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
  const routeLayer = layers.find(
    (layer) => layer.route && layer.match(requestPath) && layer.route.methods[method.toLowerCase()],
  );
  const notFoundLayer = layers[layers.length - 1];

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
  const homeDir = createTempHome("tachi-phase2-test-");
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

  const insertAgent = ({ id, name, apiKey, walletBalance = 0, status = "active" }) => {
    db.prepare(
      `
        INSERT INTO agents (id, name, api_key_hash, wallet_balance, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    ).run(id, name, hashApiKey(apiKey), walletBalance, status, "2026-03-12T00:00:00.000Z");
  };

  return {
    app: createApp(db),
    db,
    insertAgent,
    close,
  };
}

describe("Phase 2 API", () => {
  let ctx;

  afterEach(() => {
    if (ctx) {
      ctx.close();
      ctx = null;
    }
  });

  test("successful registration returns 201 with id, name, api_key, capabilities", async () => {
    ctx = setupServer();

    const response = await simulateRequest(ctx.app, "POST", "/agents/register", {
      body: {
        name: "alpha",
        capabilities: ["code", "review"],
        rate_min: 10,
        rate_max: 20,
        description: "Builds things",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        name: "alpha",
        api_key: expect.any(String),
        capabilities: ["code", "review"],
        rate_min: 10,
        rate_max: 20,
        description: "Builds things",
      }),
    );
  });

  test("api_key starts with 'tachi_' and is 38 chars total", async () => {
    ctx = setupServer();

    const response = await simulateRequest(ctx.app, "POST", "/agents/register", {
      body: {
        name: "alpha",
        capabilities: ["code"],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.api_key).toMatch(/^tachi_[a-f0-9]{32}$/);
    expect(response.body.api_key).toHaveLength(38);
  });

  test("registered agent can authenticate with returned api_key", async () => {
    ctx = setupServer();

    const registerResponse = await simulateRequest(ctx.app, "POST", "/agents/register", {
      body: {
        name: "alpha",
        capabilities: ["code"],
      },
    });

    const balanceResponse = await simulateRequest(ctx.app, "GET", "/wallet/balance", {
      headers: { "X-API-Key": registerResponse.body.api_key },
    });

    expect(balanceResponse.statusCode).toBe(200);
    expect(balanceResponse.body.agent_id).toBe(registerResponse.body.id);
  });

  test("duplicate name returns 409", async () => {
    ctx = setupServer();

    await simulateRequest(ctx.app, "POST", "/agents/register", {
      body: {
        name: "alpha",
        capabilities: ["code"],
      },
    });

    const response = await simulateRequest(ctx.app, "POST", "/agents/register", {
      body: {
        name: "alpha",
        capabilities: ["review"],
      },
    });

    expect(response.statusCode).toBe(409);
  });

  test("missing name returns 400", async () => {
    ctx = setupServer();

    const response = await simulateRequest(ctx.app, "POST", "/agents/register", {
      body: {
        capabilities: ["code"],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("missing capabilities returns 400", async () => {
    ctx = setupServer();

    const response = await simulateRequest(ctx.app, "POST", "/agents/register", {
      body: {
        name: "alpha",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("agent appears in DB after registration", async () => {
    ctx = setupServer();

    const response = await simulateRequest(ctx.app, "POST", "/agents/register", {
      body: {
        name: "alpha",
        capabilities: ["code"],
      },
    });

    const row = ctx.db
      .prepare(
        `
          SELECT id, name, api_key_hash, capabilities, wallet_balance, status
          FROM agents
          WHERE id = ?
        `,
      )
      .get(response.body.id);

    expect(row).toEqual(
      expect.objectContaining({
        id: response.body.id,
        name: "alpha",
        capabilities: JSON.stringify(["code"]),
        wallet_balance: 0,
        status: "active",
      }),
    );
    expect(row.api_key_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("topup increases wallet balance correctly", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "agent-1", name: "alpha", apiKey: "valid-key" });

    const response = await simulateRequest(ctx.app, "POST", "/wallet/topup", {
      headers: { "X-API-Key": "valid-key" },
      body: { amount: 12.5 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.balance).toBe(12.5);
    expect(response.body.transaction_id).toEqual(expect.any(String));
  });

  test("multiple topups accumulate", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "agent-1", name: "alpha", apiKey: "valid-key" });

    await simulateRequest(ctx.app, "POST", "/wallet/topup", {
      headers: { "X-API-Key": "valid-key" },
      body: { amount: 10 },
    });
    const response = await simulateRequest(ctx.app, "POST", "/wallet/topup", {
      headers: { "X-API-Key": "valid-key" },
      body: { amount: 15.5 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.balance).toBe(25.5);
  });

  test("topup creates a transaction record", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "agent-1", name: "alpha", apiKey: "valid-key" });

    const response = await simulateRequest(ctx.app, "POST", "/wallet/topup", {
      headers: { "X-API-Key": "valid-key" },
      body: { amount: 7 },
    });

    const row = ctx.db.prepare("SELECT * FROM transactions WHERE id = ?").get(response.body.transaction_id);

    expect(row).toEqual(
      expect.objectContaining({
        id: response.body.transaction_id,
        task_id: null,
        from_agent: null,
        to_agent: "agent-1",
        amount: 7,
        type: "topup",
      }),
    );
  });

  test("topup with amount 0 or negative returns 400", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "agent-1", name: "alpha", apiKey: "valid-key" });

    const zeroResponse = await simulateRequest(ctx.app, "POST", "/wallet/topup", {
      headers: { "X-API-Key": "valid-key" },
      body: { amount: 0 },
    });
    const negativeResponse = await simulateRequest(ctx.app, "POST", "/wallet/topup", {
      headers: { "X-API-Key": "valid-key" },
      body: { amount: -1 },
    });

    expect(zeroResponse.statusCode).toBe(400);
    expect(negativeResponse.statusCode).toBe(400);
  });

  test("topup without auth returns 401", async () => {
    ctx = setupServer();

    const response = await simulateRequest(ctx.app, "POST", "/wallet/topup", {
      body: { amount: 5 },
    });

    expect(response.statusCode).toBe(401);
  });

  test("balance returns correct amount after topup", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "agent-1", name: "alpha", apiKey: "valid-key" });

    await simulateRequest(ctx.app, "POST", "/wallet/topup", {
      headers: { "X-API-Key": "valid-key" },
      body: { amount: 12 },
    });
    const response = await simulateRequest(ctx.app, "GET", "/wallet/balance", {
      headers: { "X-API-Key": "valid-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      agent_id: "agent-1",
      balance: 12,
    });
  });

  test("balance for new agent is 0", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "agent-1", name: "alpha", apiKey: "valid-key" });

    const response = await simulateRequest(ctx.app, "GET", "/wallet/balance", {
      headers: { "X-API-Key": "valid-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.balance).toBe(0);
  });

  test("balance without auth returns 401", async () => {
    ctx = setupServer();

    const response = await simulateRequest(ctx.app, "GET", "/wallet/balance");

    expect(response.statusCode).toBe(401);
  });
});
