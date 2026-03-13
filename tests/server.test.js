const fs = require("fs");
const os = require("os");
const path = require("path");

require("supertest");

function createTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tachi-server-test-"));
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
  const res = {
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

  return res;
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
    (layer) =>
      layer.route &&
      layer.match(requestPath) &&
      layer.route.methods[method.toLowerCase()],
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
  const homeDir = createTempHome();
  process.env.TACHI_HOME = homeDir;
  jest.resetModules();

  const { runMigrations } = require("../db/migrate");
  const { openDatabase } = require("../db");
  const { createApp, createAuthMiddleware } = require("../server");
  const { hashApiKey } = require("../lib/hash");

  runMigrations();
  const db = openDatabase();

  const insertAgent = ({ id, name, apiKey, status = "active" }) => {
    db.prepare(
      `
        INSERT INTO agents (id, name, api_key_hash, status, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
    ).run(id, name, hashApiKey(apiKey), status, "2026-03-12T00:00:00.000Z");
  };

  const close = () => {
    db.close();
    delete process.env.TACHI_HOME;
    jest.resetModules();
    fs.rmSync(homeDir, { recursive: true, force: true });
  };

  return {
    app: createApp(db),
    db,
    createAuthMiddleware,
    insertAgent,
    close,
  };
}

describe("server and API", () => {
  let ctx;

  afterEach(() => {
    if (ctx) {
      ctx.close();
      ctx = null;
    }
  });

  test("GET /health returns 200 with status and version", async () => {
    ctx = setupServer();

    const response = await simulateRequest(ctx.app, "GET", "/health");

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      version: "0.1.0",
    });
  });

  test("GET /health works without API key", async () => {
    ctx = setupServer();

    const response = await simulateRequest(ctx.app, "GET", "/health");

    expect(response.statusCode).toBe(200);
  });

  test("POST /agents/register does not require API key", async () => {
    ctx = setupServer();

    const response = await simulateRequest(ctx.app, "POST", "/agents/register", { body: {} });

    expect(response.statusCode).not.toBe(401);
  });

  test("protected routes return 401 when no X-API-Key header is sent", async () => {
    ctx = setupServer();

    const response = await simulateRequest(ctx.app, "GET", "/agents");

    expect(response.statusCode).toBe(401);
    expect(response.body.error).toMatch(/Missing X-API-Key header/);
  });

  test("protected routes return 401 when invalid X-API-Key is sent", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "agent-1", name: "alpha", apiKey: "valid-key" });

    const response = await simulateRequest(ctx.app, "GET", "/agents", {
      headers: { "X-API-Key": "wrong-key" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body.error).toMatch(/Invalid API key/);
  });

  test("protected routes return 501 when valid API key is sent", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "agent-1", name: "alpha", apiKey: "valid-key" });

    const response = await simulateRequest(ctx.app, "GET", "/agents", {
      headers: { "X-API-Key": "valid-key" },
    });

    expect(response.statusCode).toBe(501);
    expect(response.body).toEqual({
      error: "Not implemented yet",
      route: "GET /agents",
    });
  });

  test("auth middleware sets req.agent on valid key", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "agent-1", name: "alpha", apiKey: "valid-key" });

    const req = createMockRequest(ctx.app, "GET", "/agents", { "X-API-Key": "valid-key" });
    const res = createMockResponse();

    await invokeHandler(ctx.createAuthMiddleware(ctx.db), req, res);

    expect(res.finished).toBe(false);
    expect(req.agent).toEqual({
      id: "agent-1",
      name: "alpha",
      status: "active",
    });
  });

  test("suspended agent gets 403", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "agent-1", name: "alpha", apiKey: "valid-key", status: "suspended" });

    const response = await simulateRequest(ctx.app, "GET", "/agents", {
      headers: { "X-API-Key": "valid-key" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body.error).toMatch(/not active/);
  });

  test("unknown routes return 404", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "agent-1", name: "alpha", apiKey: "valid-key" });

    const response = await simulateRequest(ctx.app, "GET", "/missing", {
      headers: { "X-API-Key": "valid-key" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body.error).toBe("Route not found: GET /missing");
  });

  test("all protected route stubs exist and return 501", async () => {
    ctx = setupServer();
    ctx.insertAgent({ id: "agent-1", name: "alpha", apiKey: "valid-key" });

    const routes = [
      ["GET", "/agents", "GET /agents"],
      ["GET", "/agents/agent-1", "GET /agents/:id"],
      ["GET", "/wallet/history", "GET /wallet/history"],
      ["GET", "/history", "GET /history"],
    ];

    for (const [method, requestPath, route] of routes) {
      const response = await simulateRequest(ctx.app, method, requestPath, {
        headers: { "X-API-Key": "valid-key" },
      });

      expect(response.statusCode).toBe(501);
      expect(response.body).toEqual({
        error: "Not implemented yet",
        route,
      });
    }
  });
});
