const fs = require("fs");
const os = require("os");
const path = require("path");

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
  const homeDir = createTempHome("tachi-phase9-test-");
  process.env.TACHI_HOME = homeDir;
  jest.resetModules();

  const { runMigrations } = require("../db/migrate");
  const { openDatabase } = require("../db");
  const { createApp } = require("../server");

  runMigrations();
  const db = openDatabase();

  const close = () => {
    db.close();
    delete process.env.TACHI_HOME;
    jest.resetModules();
    fs.rmSync(homeDir, { recursive: true, force: true });
  };

  return {
    app: createApp(db),
    db,
    close,
  };
}

async function registerAgent(app, options) {
  const response = await simulateRequest(app, "POST", "/agents/register", { body: options });
  expect(response.statusCode).toBe(201);
  return response.body;
}

async function topupWallet(app, apiKey, amount) {
  const response = await simulateRequest(app, "POST", "/wallet/topup", {
    headers: { "X-API-Key": apiKey },
    body: { amount },
  });
  expect(response.statusCode).toBe(200);
  return response.body;
}

async function postTask(app, apiKey, body) {
  const response = await simulateRequest(app, "POST", "/tasks", {
    headers: { "X-API-Key": apiKey },
    body,
  });
  expect(response.statusCode).toBe(201);
  return response.body;
}

async function createApprovedTask(ctx, buyer, seller, taskOverrides = {}) {
  const task = await postTask(ctx.app, buyer.api_key, {
    capability: "code",
    spec: "Ship feature",
    budget_max: 10,
    description: "Phase 9 task",
    input_path: "/tmp/tachi/in.txt",
    ...taskOverrides,
  });

  const acceptResponse = await simulateRequest(ctx.app, "POST", `/tasks/${task.id}/accept`, {
    headers: { "X-API-Key": seller.api_key },
  });
  expect(acceptResponse.statusCode).toBe(200);

  const deliverResponse = await simulateRequest(ctx.app, "POST", `/tasks/${task.id}/deliver`, {
    headers: { "X-API-Key": seller.api_key },
    body: { output_path: "/tmp/tachi/out.txt" },
  });
  expect(deliverResponse.statusCode).toBe(200);

  const approveResponse = await simulateRequest(ctx.app, "POST", `/tasks/${task.id}/approve`, {
    headers: { "X-API-Key": buyer.api_key },
  });
  expect(approveResponse.statusCode).toBe(200);

  return task.id;
}

async function createRejectedTask(ctx, buyer, seller) {
  const task = await postTask(ctx.app, buyer.api_key, {
    capability: "code",
    spec: "Need revision",
    budget_max: 8,
  });

  await simulateRequest(ctx.app, "POST", `/tasks/${task.id}/accept`, {
    headers: { "X-API-Key": seller.api_key },
  });
  await simulateRequest(ctx.app, "POST", `/tasks/${task.id}/deliver`, {
    headers: { "X-API-Key": seller.api_key },
    body: { output_path: "/tmp/tachi/revision.txt" },
  });

  const rejectResponse = await simulateRequest(ctx.app, "POST", `/tasks/${task.id}/reject`, {
    headers: { "X-API-Key": buyer.api_key },
    body: { reason: "Needs changes" },
  });
  expect(rejectResponse.statusCode).toBe(200);

  return task.id;
}

describe("Phase 9: Read Commands", () => {
  let ctx;

  afterEach(() => {
    if (ctx) {
      ctx.close();
      ctx = null;
    }
  });

  describe("GET /agents", () => {
    test("returns public agent list without secrets or balances", async () => {
      ctx = setupServer();
      const alpha = await registerAgent(ctx.app, { name: "alpha", capabilities: ["code"], description: "Builds" });
      await registerAgent(ctx.app, { name: "beta", capabilities: ["design"], rate_min: 5, rate_max: 9 });

      const response = await simulateRequest(ctx.app, "GET", "/agents", {
        headers: { "X-API-Key": alpha.api_key },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveLength(2);
      expect(response.body[0]).toEqual(expect.not.objectContaining({ api_key_hash: expect.anything() }));
      expect(response.body[0]).toEqual(expect.not.objectContaining({ wallet_balance: expect.anything() }));
      expect(response.body[0]).toEqual(expect.objectContaining({
        capabilities: ["design"],
        rating_avg: 0,
        rating_count: 0,
      }));
    });

    test("orders agents by created_at descending then id descending", async () => {
      ctx = setupServer();
      const viewer = await registerAgent(ctx.app, { name: "viewer", capabilities: ["code"] });
      const a = await registerAgent(ctx.app, { name: "agent-a", capabilities: ["code"] });
      const b = await registerAgent(ctx.app, { name: "agent-b", capabilities: ["design"] });

      ctx.db.prepare("UPDATE agents SET created_at = ? WHERE id = ?").run("2026-03-12T00:00:00.000Z", a.id);
      ctx.db.prepare("UPDATE agents SET created_at = ? WHERE id = ?").run("2026-03-12T00:00:00.000Z", b.id);
      ctx.db.prepare("UPDATE agents SET created_at = ? WHERE id = ?").run("2026-03-10T00:00:00.000Z", viewer.id);

      const response = await simulateRequest(ctx.app, "GET", "/agents", {
        headers: { "X-API-Key": viewer.api_key },
      });

      const sameTimestamp = response.body.filter((agent) => agent.created_at === "2026-03-12T00:00:00.000Z");
      expect(sameTimestamp.map((agent) => agent.id)).toEqual([b.id, a.id].sort().reverse());
    });

    test("returns an empty array when no other agents exist", async () => {
      ctx = setupServer();
      const viewer = await registerAgent(ctx.app, { name: "solo", capabilities: ["code"] });

      const response = await simulateRequest(ctx.app, "GET", "/agents", {
        headers: { "X-API-Key": viewer.api_key },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveLength(1);
    });

    test("includes suspended agents in the marketplace list", async () => {
      ctx = setupServer();
      const viewer = await registerAgent(ctx.app, { name: "viewer", capabilities: ["code"] });
      const suspended = await registerAgent(ctx.app, { name: "suspended", capabilities: ["ops"] });
      ctx.db.prepare("UPDATE agents SET status = 'suspended' WHERE id = ?").run(suspended.id);

      const response = await simulateRequest(ctx.app, "GET", "/agents", {
        headers: { "X-API-Key": viewer.api_key },
      });

      expect(response.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: suspended.id,
            status: "suspended",
          }),
        ]),
      );
    });

    test("applies default and offset pagination", async () => {
      ctx = setupServer();
      const viewer = await registerAgent(ctx.app, { name: "viewer", capabilities: ["code"] });

      for (let index = 0; index < 55; index += 1) {
        await registerAgent(ctx.app, { name: `agent-${index}`, capabilities: ["code"] });
      }

      const firstPage = await simulateRequest(ctx.app, "GET", "/agents", {
        headers: { "X-API-Key": viewer.api_key },
      });
      const secondPage = await simulateRequest(ctx.app, "GET", "/agents?offset=50", {
        headers: { "X-API-Key": viewer.api_key },
      });

      expect(firstPage.statusCode).toBe(200);
      expect(firstPage.body).toHaveLength(50);
      expect(secondPage.statusCode).toBe(200);
      expect(secondPage.body).toHaveLength(6);
    });

    test("rejects over-large limits", async () => {
      ctx = setupServer();
      const viewer = await registerAgent(ctx.app, { name: "viewer", capabilities: ["code"] });

      const response = await simulateRequest(ctx.app, "GET", "/agents?limit=101", {
        headers: { "X-API-Key": viewer.api_key },
      });

      expect(response.statusCode).toBe(400);
      expect(response.body.error).toMatch(/limit/);
    });
  });

  describe("GET /agents/:id", () => {
    test("returns agent profile with reviews", async () => {
      ctx = setupServer();
      const buyer = await registerAgent(ctx.app, { name: "buyer", capabilities: ["code"] });
      const seller = await registerAgent(ctx.app, { name: "seller", capabilities: ["code"], description: "Ships fast" });
      await topupWallet(ctx.app, buyer.api_key, 100);
      const taskId = await createApprovedTask(ctx, buyer, seller);

      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/rate`, {
        headers: { "X-API-Key": buyer.api_key },
        body: { rating: 5, comment: "Excellent" },
      });

      const response = await simulateRequest(ctx.app, "GET", `/agents/${seller.id}`, {
        headers: { "X-API-Key": buyer.api_key },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual(expect.objectContaining({
        id: seller.id,
        name: "seller",
        capabilities: ["code"],
        description: "Ships fast",
        reviews: [
          expect.objectContaining({
            task_id: taskId,
            reviewer_id: buyer.id,
            reviewer_name: "buyer",
            reviewee_id: seller.id,
            rating: 5,
            comment: "Excellent",
            role: "buyer",
          }),
        ],
      }));
      expect(response.body).toEqual(expect.not.objectContaining({ api_key_hash: expect.anything() }));
      expect(response.body).toEqual(expect.not.objectContaining({ wallet_balance: expect.anything() }));
    });

    test("sorts reviews newest first", async () => {
      ctx = setupServer();
      const buyer = await registerAgent(ctx.app, { name: "buyer", capabilities: ["code"] });
      const seller = await registerAgent(ctx.app, { name: "seller", capabilities: ["code"] });
      await topupWallet(ctx.app, buyer.api_key, 100);
      const firstTaskId = await createApprovedTask(ctx, buyer, seller, { description: "first" });
      const secondTaskId = await createApprovedTask(ctx, buyer, seller, { description: "second", spec: "Ship feature again" });

      const firstReview = await simulateRequest(ctx.app, "POST", `/tasks/${firstTaskId}/rate`, {
        headers: { "X-API-Key": buyer.api_key },
        body: { rating: 4, comment: "First" },
      });
      const secondReview = await simulateRequest(ctx.app, "POST", `/tasks/${secondTaskId}/rate`, {
        headers: { "X-API-Key": buyer.api_key },
        body: { rating: 5, comment: "Second" },
      });

      ctx.db.prepare("UPDATE reviews SET created_at = ? WHERE id = ?").run("2026-03-10T00:00:00.000Z", firstReview.body.id);
      ctx.db.prepare("UPDATE reviews SET created_at = ? WHERE id = ?").run("2026-03-11T00:00:00.000Z", secondReview.body.id);

      const response = await simulateRequest(ctx.app, "GET", `/agents/${seller.id}`, {
        headers: { "X-API-Key": buyer.api_key },
      });

      expect(response.body.reviews.map((review) => review.task_id)).toEqual([secondTaskId, firstTaskId]);
    });

    test("returns empty reviews array when the agent has no reviews", async () => {
      ctx = setupServer();
      const viewer = await registerAgent(ctx.app, { name: "viewer", capabilities: ["code"] });
      const seller = await registerAgent(ctx.app, { name: "seller", capabilities: ["code"] });

      const response = await simulateRequest(ctx.app, "GET", `/agents/${seller.id}`, {
        headers: { "X-API-Key": viewer.api_key },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body.reviews).toEqual([]);
    });

    test("returns stored rating aggregates on the profile", async () => {
      ctx = setupServer();
      const viewer = await registerAgent(ctx.app, { name: "viewer", capabilities: ["code"] });
      const seller = await registerAgent(ctx.app, { name: "seller", capabilities: ["code"] });
      ctx.db.prepare("UPDATE agents SET rating_avg = ?, rating_count = ? WHERE id = ?").run(4.5, 6, seller.id);

      const response = await simulateRequest(ctx.app, "GET", `/agents/${seller.id}`, {
        headers: { "X-API-Key": viewer.api_key },
      });

      expect(response.body.rating_avg).toBe(4.5);
      expect(response.body.rating_count).toBe(6);
    });

    test("returns 404 for a missing agent", async () => {
      ctx = setupServer();
      const viewer = await registerAgent(ctx.app, { name: "viewer", capabilities: ["code"] });

      const response = await simulateRequest(ctx.app, "GET", "/agents/missing-agent", {
        headers: { "X-API-Key": viewer.api_key },
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).toEqual({ error: "Agent not found" });
    });
  });

  describe("GET /wallet/history", () => {
    test("returns wallet transactions for the authenticated agent", async () => {
      ctx = setupServer();
      const agent = await registerAgent(ctx.app, { name: "alpha", capabilities: ["code"] });
      await topupWallet(ctx.app, agent.api_key, 11);

      const response = await simulateRequest(ctx.app, "GET", "/wallet/history", {
        headers: { "X-API-Key": agent.api_key },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual([
        expect.objectContaining({
          task_id: null,
          from_agent: null,
          to_agent: agent.id,
          amount: 11,
          type: "topup",
        }),
      ]);
    });

    test("includes escrow hold and refund history for buyers", async () => {
      ctx = setupServer();
      const buyer = await registerAgent(ctx.app, { name: "buyer", capabilities: ["code"] });
      const seller = await registerAgent(ctx.app, { name: "seller", capabilities: ["code"] });
      await topupWallet(ctx.app, buyer.api_key, 100);
      const taskId = await createApprovedTask(ctx, buyer, seller);

      const response = await simulateRequest(ctx.app, "GET", "/wallet/history", {
        headers: { "X-API-Key": buyer.api_key },
      });

      expect(response.body.map((transaction) => transaction.type)).toEqual(
        expect.arrayContaining(["topup", "escrow_hold", "escrow_refund"]),
      );
      expect(response.body.filter((transaction) => transaction.task_id === taskId)).toHaveLength(2);
    });

    test("includes payouts and compute fees for sellers", async () => {
      ctx = setupServer();
      const buyer = await registerAgent(ctx.app, { name: "buyer", capabilities: ["code"] });
      const seller = await registerAgent(ctx.app, { name: "seller", capabilities: ["code"] });
      await topupWallet(ctx.app, buyer.api_key, 100);
      await createApprovedTask(ctx, buyer, seller);
      await createRejectedTask(ctx, buyer, seller);

      const response = await simulateRequest(ctx.app, "GET", "/wallet/history", {
        headers: { "X-API-Key": seller.api_key },
      });

      expect(response.body.map((transaction) => transaction.type)).toEqual(
        expect.arrayContaining(["escrow_release", "compute_fee"]),
      );
      expect(response.body.every((transaction) => transaction.from_agent === seller.id)).toBe(false);
    });

    test("includes compute fees debited from buyers after rejection", async () => {
      ctx = setupServer();
      const buyer = await registerAgent(ctx.app, { name: "buyer", capabilities: ["code"] });
      const seller = await registerAgent(ctx.app, { name: "seller", capabilities: ["code"] });
      await topupWallet(ctx.app, buyer.api_key, 100);
      await createRejectedTask(ctx, buyer, seller);

      const response = await simulateRequest(ctx.app, "GET", "/wallet/history", {
        headers: { "X-API-Key": buyer.api_key },
      });

      expect(response.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from_agent: buyer.id,
            to_agent: seller.id,
            type: "compute_fee",
          }),
        ]),
      );
    });

    test("excludes unrelated transactions", async () => {
      ctx = setupServer();
      const buyer = await registerAgent(ctx.app, { name: "buyer", capabilities: ["code"] });
      const seller = await registerAgent(ctx.app, { name: "seller", capabilities: ["code"] });
      const outsider = await registerAgent(ctx.app, { name: "outsider", capabilities: ["code"] });
      await topupWallet(ctx.app, buyer.api_key, 100);
      await topupWallet(ctx.app, outsider.api_key, 33);
      await createApprovedTask(ctx, buyer, seller);

      const response = await simulateRequest(ctx.app, "GET", "/wallet/history", {
        headers: { "X-API-Key": seller.api_key },
      });

      expect(response.body.some((transaction) => transaction.to_agent === outsider.id)).toBe(false);
    });

    test("orders transactions newest first", async () => {
      ctx = setupServer();
      const agent = await registerAgent(ctx.app, { name: "alpha", capabilities: ["code"] });
      const first = await topupWallet(ctx.app, agent.api_key, 5);
      const second = await topupWallet(ctx.app, agent.api_key, 7);

      ctx.db.prepare("UPDATE transactions SET created_at = ? WHERE id = ?").run("2026-03-10T00:00:00.000Z", first.transaction_id);
      ctx.db.prepare("UPDATE transactions SET created_at = ? WHERE id = ?").run("2026-03-11T00:00:00.000Z", second.transaction_id);

      const response = await simulateRequest(ctx.app, "GET", "/wallet/history", {
        headers: { "X-API-Key": agent.api_key },
      });

      expect(response.body.map((transaction) => transaction.id).slice(0, 2)).toEqual([second.transaction_id, first.transaction_id]);
    });

    test("returns an empty array when no transactions exist", async () => {
      ctx = setupServer();
      const agent = await registerAgent(ctx.app, { name: "alpha", capabilities: ["code"] });

      const response = await simulateRequest(ctx.app, "GET", "/wallet/history", {
        headers: { "X-API-Key": agent.api_key },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual([]);
    });

    test("supports limit and offset pagination", async () => {
      ctx = setupServer();
      const agent = await registerAgent(ctx.app, { name: "alpha", capabilities: ["code"] });
      const topups = [];

      for (let index = 0; index < 4; index += 1) {
        topups.push(await topupWallet(ctx.app, agent.api_key, index + 1));
      }

      ctx.db.prepare("UPDATE transactions SET created_at = ? WHERE id = ?").run("2026-03-10T00:00:00.000Z", topups[0].transaction_id);
      ctx.db.prepare("UPDATE transactions SET created_at = ? WHERE id = ?").run("2026-03-11T00:00:00.000Z", topups[1].transaction_id);
      ctx.db.prepare("UPDATE transactions SET created_at = ? WHERE id = ?").run("2026-03-12T00:00:00.000Z", topups[2].transaction_id);
      ctx.db.prepare("UPDATE transactions SET created_at = ? WHERE id = ?").run("2026-03-13T00:00:00.000Z", topups[3].transaction_id);

      const response = await simulateRequest(ctx.app, "GET", "/wallet/history?limit=2&offset=1", {
        headers: { "X-API-Key": agent.api_key },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveLength(2);
      expect(response.body[0].amount).toBe(3);
      expect(response.body[1].amount).toBe(2);
    });
  });

  describe("GET /history", () => {
    test("returns tasks where the agent is buyer or seller", async () => {
      ctx = setupServer();
      const buyer = await registerAgent(ctx.app, { name: "buyer", capabilities: ["code"] });
      const seller = await registerAgent(ctx.app, { name: "seller", capabilities: ["code"] });
      await topupWallet(ctx.app, buyer.api_key, 100);
      const taskId = await createApprovedTask(ctx, buyer, seller);

      const response = await simulateRequest(ctx.app, "GET", "/history", {
        headers: { "X-API-Key": seller.api_key },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toEqual(expect.objectContaining({
        id: taskId,
        buyer_id: buyer.id,
        seller_id: seller.id,
        status: "approved",
      }));
    });

    test("supports filtering by status", async () => {
      ctx = setupServer();
      const buyer = await registerAgent(ctx.app, { name: "buyer", capabilities: ["code"] });
      const seller = await registerAgent(ctx.app, { name: "seller", capabilities: ["code"] });
      await topupWallet(ctx.app, buyer.api_key, 100);
      await createApprovedTask(ctx, buyer, seller);
      await createRejectedTask(ctx, buyer, seller);

      const response = await simulateRequest(ctx.app, "GET", "/history?status=revision", {
        headers: { "X-API-Key": seller.api_key },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].status).toBe("revision");
    });

    test("includes task paths and normalized pii_mask", async () => {
      ctx = setupServer();
      const buyer = await registerAgent(ctx.app, { name: "buyer", capabilities: ["code"] });
      const seller = await registerAgent(ctx.app, { name: "seller", capabilities: ["code"] });
      await topupWallet(ctx.app, buyer.api_key, 100);
      const taskId = await createApprovedTask(ctx, buyer, seller, {
        pii_mask: false,
        input_path: "/tmp/tachi/input.md",
      });

      const response = await simulateRequest(ctx.app, "GET", "/history", {
        headers: { "X-API-Key": buyer.api_key },
      });

      expect(response.body.find((task) => task.id === taskId)).toEqual(expect.objectContaining({
        input_path: "/tmp/tachi/input.md",
        output_path: "/tmp/tachi/out.txt",
        pii_mask: false,
      }));
    });

    test("orders tasks newest first", async () => {
      ctx = setupServer();
      const buyer = await registerAgent(ctx.app, { name: "buyer", capabilities: ["code"] });
      const seller = await registerAgent(ctx.app, { name: "seller", capabilities: ["code"] });
      await topupWallet(ctx.app, buyer.api_key, 100);
      const firstTaskId = await createApprovedTask(ctx, buyer, seller, { budget_max: 10 });
      const secondTaskId = await createApprovedTask(ctx, buyer, seller, { spec: "Ship feature again" });

      ctx.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run("2026-03-10T00:00:00.000Z", firstTaskId);
      ctx.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run("2026-03-11T00:00:00.000Z", secondTaskId);

      const response = await simulateRequest(ctx.app, "GET", "/history", {
        headers: { "X-API-Key": seller.api_key },
      });

      expect(response.body.map((task) => task.id).slice(0, 2)).toEqual([secondTaskId, firstTaskId]);
    });

    test("excludes unrelated tasks", async () => {
      ctx = setupServer();
      const buyer = await registerAgent(ctx.app, { name: "buyer", capabilities: ["code"] });
      const seller = await registerAgent(ctx.app, { name: "seller", capabilities: ["code"] });
      const outsider = await registerAgent(ctx.app, { name: "outsider", capabilities: ["code"] });
      await topupWallet(ctx.app, buyer.api_key, 100);
      await topupWallet(ctx.app, outsider.api_key, 100);
      await createApprovedTask(ctx, buyer, seller);
      await createApprovedTask(ctx, outsider, seller);

      const response = await simulateRequest(ctx.app, "GET", "/history", {
        headers: { "X-API-Key": buyer.api_key },
      });

      expect(response.body.every((task) => task.buyer_id === buyer.id || task.seller_id === buyer.id)).toBe(true);
      expect(response.body.some((task) => task.buyer_id === outsider.id)).toBe(false);
    });

    test("returns an empty array when no task history exists", async () => {
      ctx = setupServer();
      const agent = await registerAgent(ctx.app, { name: "agent", capabilities: ["code"] });

      const response = await simulateRequest(ctx.app, "GET", "/history", {
        headers: { "X-API-Key": agent.api_key },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual([]);
    });

    test("supports limit and offset pagination", async () => {
      ctx = setupServer();
      const buyer = await registerAgent(ctx.app, { name: "buyer", capabilities: ["code"] });
      const seller = await registerAgent(ctx.app, { name: "seller", capabilities: ["code"] });
      await topupWallet(ctx.app, buyer.api_key, 100);
      const firstTaskId = await createApprovedTask(ctx, buyer, seller, { spec: "First task" });
      const secondTaskId = await createApprovedTask(ctx, buyer, seller, { spec: "Second task" });
      const thirdTaskId = await createApprovedTask(ctx, buyer, seller, { spec: "Third task" });

      ctx.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run("2026-03-10T00:00:00.000Z", firstTaskId);
      ctx.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run("2026-03-11T00:00:00.000Z", secondTaskId);
      ctx.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run("2026-03-12T00:00:00.000Z", thirdTaskId);

      const response = await simulateRequest(ctx.app, "GET", "/history?limit=1&offset=1", {
        headers: { "X-API-Key": seller.api_key },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].id).toBe(secondTaskId);
    });
  });
});
