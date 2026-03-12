const fs = require("fs");
const os = require("os");
const path = require("path");

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

function createTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tachi-cli-server-home-"));
}

const serverHome = process.env.TACHI_TEST_SERVER_HOME || createTempHome();
process.env.TACHI_HOME = serverHome;

const { runMigrations } = require("../../db/migrate");
const { openDatabase } = require("../../db");
const { createApp } = require("../../server");

runMigrations();

const db = openDatabase();
const app = createApp(db);

global.fetch = async function fetchShim(url, options = {}) {
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

process.on("exit", () => {
  db.close();
  fs.rmSync(serverHome, { recursive: true, force: true });
});
