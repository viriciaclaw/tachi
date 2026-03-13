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
  const homeDir = createTempHome("tachi-phase8-test-");
  process.env.TACHI_HOME = homeDir;
  jest.resetModules();

  const { runMigrations } = require("../db/migrate");
  const { openDatabase } = require("../db");
  const { createApp } = require("../server/index.js");

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

async function registerAgent(app, { name, capabilities, rate_min = 0, rate_max = 0 }) {
  const response = await simulateRequest(app, "POST", "/agents/register", {
    body: { name, capabilities, rate_min, rate_max },
  });
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

let agentCounter = 0;

async function createApprovedTask(ctx, options = {}) {
  agentCounter += 1;
  const suffix = options.suffix || String(agentCounter);

  const buyer = options.buyer || await registerAgent(ctx.app, {
    name: `buyer-${suffix}`,
    capabilities: ["code"],
  });

  if (!options.buyer) {
    await topupWallet(ctx.app, buyer.api_key, 100);
  }

  const seller = options.seller || await registerAgent(ctx.app, {
    name: `seller-${suffix}`,
    capabilities: ["code"],
  });

  const postRes = await simulateRequest(ctx.app, "POST", "/tasks", {
    headers: { "X-API-Key": buyer.api_key },
    body: { capability: "code", spec: "Build feature X", budget_max: 10 },
  });
  expect(postRes.statusCode).toBe(201);

  const taskId = postRes.body.id;

  const acceptRes = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/accept`, {
    headers: { "X-API-Key": seller.api_key },
  });
  expect(acceptRes.statusCode).toBe(200);

  const deliverRes = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
    headers: { "X-API-Key": seller.api_key },
    body: { output_path: "/tmp/tachi/output/result.txt" },
  });
  expect(deliverRes.statusCode).toBe(200);

  const approveRes = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/approve`, {
    headers: { "X-API-Key": buyer.api_key },
  });
  expect(approveRes.statusCode).toBe(200);

  return { buyer, seller, taskId };
}

describe("Phase 8: Rating System", () => {
  let ctx;

  afterEach(() => {
    if (ctx) {
      ctx.close();
      ctx = null;
    }
  });

  describe("happy path", () => {
    test("buyer rates seller after approved task", async () => {
      ctx = setupServer();
      const { buyer, seller, taskId } = await createApprovedTask(ctx);

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/rate`, {
        headers: { "X-API-Key": buyer.api_key },
        body: { rating: 5 },
      });

      expect(response.statusCode).toBe(201);
      expect(response.body).toMatchObject({
        task_id: taskId,
        reviewer_id: buyer.id,
        reviewee_id: seller.id,
        rating: 5,
        comment: null,
        role: "buyer",
        reviewee_rating: { avg: 5, count: 1 },
      });
      expect(typeof response.body.id).toBe("string");
      expect(typeof response.body.created_at).toBe("string");
    });

    test("seller rates buyer after approved task", async () => {
      ctx = setupServer();
      const { buyer, seller, taskId } = await createApprovedTask(ctx);

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/rate`, {
        headers: { "X-API-Key": seller.api_key },
        body: { rating: 4 },
      });

      expect(response.statusCode).toBe(201);
      expect(response.body).toMatchObject({
        task_id: taskId,
        reviewer_id: seller.id,
        reviewee_id: buyer.id,
        rating: 4,
        comment: null,
        role: "seller",
        reviewee_rating: { avg: 4, count: 1 },
      });
    });

    test("rating with comment stores comment", async () => {
      ctx = setupServer();
      const { buyer, taskId } = await createApprovedTask(ctx);

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/rate`, {
        headers: { "X-API-Key": buyer.api_key },
        body: { rating: 5, comment: "great work" },
      });

      expect(response.statusCode).toBe(201);
      expect(response.body.comment).toBe("great work");
    });

    test("rating without comment returns null comment", async () => {
      ctx = setupServer();
      const { buyer, taskId } = await createApprovedTask(ctx);

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/rate`, {
        headers: { "X-API-Key": buyer.api_key },
        body: { rating: 3 },
      });

      expect(response.statusCode).toBe(201);
      expect(response.body.comment).toBeNull();
    });
  });

  describe("validation errors", () => {
    test("missing rating field returns 400", async () => {
      ctx = setupServer();
      const { buyer, taskId } = await createApprovedTask(ctx);

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/rate`, {
        headers: { "X-API-Key": buyer.api_key },
        body: {},
      });

      expect(response.statusCode).toBe(400);
    });

    test("rating 0 returns 400", async () => {
      ctx = setupServer();
      const { buyer, taskId } = await createApprovedTask(ctx);

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/rate`, {
        headers: { "X-API-Key": buyer.api_key },
        body: { rating: 0 },
      });

      expect(response.statusCode).toBe(400);
    });

    test("rating 6 returns 400", async () => {
      ctx = setupServer();
      const { buyer, taskId } = await createApprovedTask(ctx);

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/rate`, {
        headers: { "X-API-Key": buyer.api_key },
        body: { rating: 6 },
      });

      expect(response.statusCode).toBe(400);
    });

    test("non-numeric string rating returns 400", async () => {
      ctx = setupServer();
      const { buyer, taskId } = await createApprovedTask(ctx);

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/rate`, {
        headers: { "X-API-Key": buyer.api_key },
        body: { rating: "abc" },
      });

      expect(response.statusCode).toBe(400);
    });

    test("float rating returns 400", async () => {
      ctx = setupServer();
      const { buyer, taskId } = await createApprovedTask(ctx);

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/rate`, {
        headers: { "X-API-Key": buyer.api_key },
        body: { rating: 3.5 },
      });

      expect(response.statusCode).toBe(400);
    });

    test("non-existent task returns 404", async () => {
      ctx = setupServer();
      const buyer = await registerAgent(ctx.app, { name: "buyer-missing", capabilities: ["code"] });

      const response = await simulateRequest(ctx.app, "POST", "/tasks/missing-task/rate", {
        headers: { "X-API-Key": buyer.api_key },
        body: { rating: 5 },
      });

      expect(response.statusCode).toBe(404);
      expect(response.body.error).toBe("Task not found");
    });
  });

  describe("auth and state errors", () => {
    test("task must be approved before rating", async () => {
      ctx = setupServer();
      const buyer = await registerAgent(ctx.app, { name: "buyer-in-progress", capabilities: ["code"] });
      await topupWallet(ctx.app, buyer.api_key, 100);
      const seller = await registerAgent(ctx.app, { name: "seller-in-progress", capabilities: ["code"] });

      const postRes = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": buyer.api_key },
        body: { capability: "code", spec: "Build feature X", budget_max: 10 },
      });
      const taskId = postRes.body.id;

      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/accept`, {
        headers: { "X-API-Key": seller.api_key },
      });

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/rate`, {
        headers: { "X-API-Key": buyer.api_key },
        body: { rating: 5 },
      });

      expect(response.statusCode).toBe(409);
      expect(response.body.error).toBe("Task must be approved before rating");
    });

    test("non-participant cannot rate task", async () => {
      ctx = setupServer();
      const { taskId } = await createApprovedTask(ctx);
      const outsider = await registerAgent(ctx.app, { name: "outsider", capabilities: ["code"] });

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/rate`, {
        headers: { "X-API-Key": outsider.api_key },
        body: { rating: 5 },
      });

      expect(response.statusCode).toBe(403);
      expect(response.body.error).toBe("Only task participants can rate");
    });

    test("buyer cannot rate same task twice", async () => {
      ctx = setupServer();
      const { buyer, taskId } = await createApprovedTask(ctx);

      const firstResponse = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/rate`, {
        headers: { "X-API-Key": buyer.api_key },
        body: { rating: 5 },
      });
      expect(firstResponse.statusCode).toBe(201);

      const secondResponse = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/rate`, {
        headers: { "X-API-Key": buyer.api_key },
        body: { rating: 4 },
      });

      expect(secondResponse.statusCode).toBe(409);
      expect(secondResponse.body.error).toBe("You have already rated this task");
    });

    test("seller cannot rate same task twice", async () => {
      ctx = setupServer();
      const { seller, taskId } = await createApprovedTask(ctx);

      const firstResponse = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/rate`, {
        headers: { "X-API-Key": seller.api_key },
        body: { rating: 5 },
      });
      expect(firstResponse.statusCode).toBe(201);

      const secondResponse = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/rate`, {
        headers: { "X-API-Key": seller.api_key },
        body: { rating: 4 },
      });

      expect(secondResponse.statusCode).toBe(409);
      expect(secondResponse.body.error).toBe("You have already rated this task");
    });
  });

  describe("rating calculations", () => {
    test("single rating updates agent average and count", async () => {
      ctx = setupServer();
      const { buyer, seller, taskId } = await createApprovedTask(ctx);

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/rate`, {
        headers: { "X-API-Key": buyer.api_key },
        body: { rating: 2 },
      });

      const agent = ctx.db.prepare("SELECT rating_avg, rating_count FROM agents WHERE id = ?").get(seller.id);

      expect(response.statusCode).toBe(201);
      expect(agent).toEqual({ rating_avg: 2, rating_count: 1 });
    });

    test("two ratings across different tasks are averaged", async () => {
      ctx = setupServer();
      const sharedSeller = await registerAgent(ctx.app, { name: "shared-seller", capabilities: ["code"] });

      const firstTask = await createApprovedTask(ctx, { seller: sharedSeller, suffix: "shared-1" });
      const secondTask = await createApprovedTask(ctx, { seller: sharedSeller, suffix: "shared-2" });

      await simulateRequest(ctx.app, "POST", `/tasks/${firstTask.taskId}/rate`, {
        headers: { "X-API-Key": firstTask.buyer.api_key },
        body: { rating: 5 },
      });

      const secondResponse = await simulateRequest(ctx.app, "POST", `/tasks/${secondTask.taskId}/rate`, {
        headers: { "X-API-Key": secondTask.buyer.api_key },
        body: { rating: 3 },
      });

      const agent = ctx.db.prepare("SELECT rating_avg, rating_count FROM agents WHERE id = ?").get(sharedSeller.id);

      expect(secondResponse.statusCode).toBe(201);
      expect(secondResponse.body.reviewee_rating).toEqual({ avg: 4, count: 2 });
      expect(agent).toEqual({ rating_avg: 4, rating_count: 2 });
    });

    test("response includes correct reviewee rating snapshot", async () => {
      ctx = setupServer();
      const sharedSeller = await registerAgent(ctx.app, { name: "snapshot-seller", capabilities: ["code"] });

      const firstTask = await createApprovedTask(ctx, { seller: sharedSeller, suffix: "snapshot-1" });
      const secondTask = await createApprovedTask(ctx, { seller: sharedSeller, suffix: "snapshot-2" });

      await simulateRequest(ctx.app, "POST", `/tasks/${firstTask.taskId}/rate`, {
        headers: { "X-API-Key": firstTask.buyer.api_key },
        body: { rating: 5 },
      });

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${secondTask.taskId}/rate`, {
        headers: { "X-API-Key": secondTask.buyer.api_key },
        body: { rating: 4 },
      });

      expect(response.statusCode).toBe(201);
      expect(response.body.reviewee_rating).toEqual({ avg: 4.5, count: 2 });
    });

    test("review row and agent record are persisted after rating", async () => {
      ctx = setupServer();
      const { buyer, seller, taskId } = await createApprovedTask(ctx);

      const response = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/rate`, {
        headers: { "X-API-Key": buyer.api_key },
        body: { rating: 5, comment: "fast and accurate" },
      });

      const review = ctx.db.prepare(
        "SELECT task_id, reviewer_id, reviewee_id, rating, comment, role FROM reviews WHERE id = ?"
      ).get(response.body.id);
      const agent = ctx.db.prepare("SELECT rating_avg, rating_count FROM agents WHERE id = ?").get(seller.id);

      expect(review).toEqual({
        task_id: taskId,
        reviewer_id: buyer.id,
        reviewee_id: seller.id,
        rating: 5,
        comment: "fast and accurate",
        role: "buyer",
      });
      expect(agent).toEqual({ rating_avg: 5, rating_count: 1 });
    });

    test("buyer and seller can both review same task and update opposite agents", async () => {
      ctx = setupServer();
      const { buyer, seller, taskId } = await createApprovedTask(ctx);

      const buyerReview = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/rate`, {
        headers: { "X-API-Key": buyer.api_key },
        body: { rating: 5 },
      });
      const sellerReview = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/rate`, {
        headers: { "X-API-Key": seller.api_key },
        body: { rating: 4 },
      });

      const reviews = ctx.db.prepare(
        "SELECT reviewer_id, reviewee_id, role, rating FROM reviews WHERE task_id = ? ORDER BY role ASC"
      ).all(taskId);
      const buyerAgent = ctx.db.prepare("SELECT rating_avg, rating_count FROM agents WHERE id = ?").get(buyer.id);
      const sellerAgent = ctx.db.prepare("SELECT rating_avg, rating_count FROM agents WHERE id = ?").get(seller.id);

      expect(buyerReview.statusCode).toBe(201);
      expect(sellerReview.statusCode).toBe(201);
      expect(reviews).toEqual([
        { reviewer_id: buyer.id, reviewee_id: seller.id, role: "buyer", rating: 5 },
        { reviewer_id: seller.id, reviewee_id: buyer.id, role: "seller", rating: 4 },
      ]);
      expect(buyerAgent).toEqual({ rating_avg: 4, rating_count: 1 });
      expect(sellerAgent).toEqual({ rating_avg: 5, rating_count: 1 });
    });
  });

  describe("matching integration", () => {
    test("higher-rated seller gets matched first for new task", async () => {
      ctx = setupServer();
      const sellerHigh = await registerAgent(ctx.app, { name: "seller-high", capabilities: ["code"] });
      const sellerLow = await registerAgent(ctx.app, { name: "seller-low", capabilities: ["code"] });

      const highTask = await createApprovedTask(ctx, { seller: sellerHigh, suffix: "high" });
      const lowTask = await createApprovedTask(ctx, { seller: sellerLow, suffix: "low" });

      await simulateRequest(ctx.app, "POST", `/tasks/${highTask.taskId}/rate`, {
        headers: { "X-API-Key": highTask.buyer.api_key },
        body: { rating: 5 },
      });
      await simulateRequest(ctx.app, "POST", `/tasks/${lowTask.taskId}/rate`, {
        headers: { "X-API-Key": lowTask.buyer.api_key },
        body: { rating: 2 },
      });

      const newBuyer = await registerAgent(ctx.app, { name: "new-buyer", capabilities: ["code"] });
      await topupWallet(ctx.app, newBuyer.api_key, 100);

      const postResponse = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": newBuyer.api_key },
        body: { capability: "code", spec: "Need ranked match", budget_max: 10 },
      });

      expect(postResponse.statusCode).toBe(201);
      expect(postResponse.body.status).toBe("matched");
      expect(postResponse.body.seller_id).toBe(sellerHigh.id);
      expect(postResponse.body.matched_agent_id).toBe(sellerHigh.id);
    });

    test("new ratings affect future matching order", async () => {
      ctx = setupServer();
      const sellerA = await registerAgent(ctx.app, { name: "seller-a", capabilities: ["code"] });
      const sellerB = await registerAgent(ctx.app, { name: "seller-b", capabilities: ["code"] });

      const taskA1 = await createApprovedTask(ctx, { seller: sellerA, suffix: "a1" });
      const taskB1 = await createApprovedTask(ctx, { seller: sellerB, suffix: "b1" });

      await simulateRequest(ctx.app, "POST", `/tasks/${taskA1.taskId}/rate`, {
        headers: { "X-API-Key": taskA1.buyer.api_key },
        body: { rating: 3 },
      });
      await simulateRequest(ctx.app, "POST", `/tasks/${taskB1.taskId}/rate`, {
        headers: { "X-API-Key": taskB1.buyer.api_key },
        body: { rating: 5 },
      });

      const firstBuyer = await registerAgent(ctx.app, { name: "first-match-buyer", capabilities: ["code"] });
      await topupWallet(ctx.app, firstBuyer.api_key, 100);
      const firstPost = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": firstBuyer.api_key },
        body: { capability: "code", spec: "who wins first", budget_max: 10 },
      });

      expect(firstPost.statusCode).toBe(201);
      expect(firstPost.body.seller_id).toBe(sellerB.id);

      const taskA2 = await createApprovedTask(ctx, { seller: sellerA, suffix: "a2" });
      await simulateRequest(ctx.app, "POST", `/tasks/${taskA2.taskId}/rate`, {
        headers: { "X-API-Key": taskA2.buyer.api_key },
        body: { rating: 5 },
      });

      const taskB2 = await createApprovedTask(ctx, { seller: sellerB, suffix: "b2" });
      await simulateRequest(ctx.app, "POST", `/tasks/${taskB2.taskId}/rate`, {
        headers: { "X-API-Key": taskB2.buyer.api_key },
        body: { rating: 1 },
      });

      const sellerARecord = ctx.db.prepare("SELECT rating_avg, rating_count FROM agents WHERE id = ?").get(sellerA.id);
      const sellerBRecord = ctx.db.prepare("SELECT rating_avg, rating_count FROM agents WHERE id = ?").get(sellerB.id);

      expect(sellerARecord).toEqual({ rating_avg: 4, rating_count: 2 });
      expect(sellerBRecord).toEqual({ rating_avg: 3, rating_count: 2 });

      const secondBuyer = await registerAgent(ctx.app, { name: "second-match-buyer", capabilities: ["code"] });
      await topupWallet(ctx.app, secondBuyer.api_key, 100);
      const secondPost = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": secondBuyer.api_key },
        body: { capability: "code", spec: "who wins second", budget_max: 10 },
      });

      expect(secondPost.statusCode).toBe(201);
      expect(secondPost.body.seller_id).toBe(sellerA.id);
      expect(secondPost.body.matched_agent_id).toBe(sellerA.id);
    });
  });
});
