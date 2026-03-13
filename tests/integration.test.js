/**
 * Cross-phase integration tests for Tachi.
 * Tests full lifecycle flows and verifies accounting invariants.
 */
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
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    getHeader(name) { return this.headers[name.toLowerCase()]; },
    removeHeader(name) { delete this.headers[name.toLowerCase()]; },
  };
}

function invokeHandler(handler, req, res) {
  return new Promise((resolve, reject) => {
    res._resolve = () => resolve();
    const next = (error) => { if (error) reject(error); else resolve(); };
    try {
      const result = handler(req, res, next);
      if (result && typeof result.then === "function") result.then(resolve).catch(reject);
    } catch (error) { reject(error); }
  });
}

async function simulateRequest(app, method, requestPath, options = {}) {
  const req = createMockRequest(app, method, requestPath, options.headers, options.body);
  const res = createMockResponse();
  const layers = app.router.stack;
  const authLayer = layers.find((layer) => layer.name === "authMiddleware");
  const routeLayer = layers.find((layer) => {
    if (!layer.route || !layer.route.methods[method.toLowerCase()]) return false;
    return layer.match(req.path);
  });
  const notFoundLayer = layers[layers.length - 1];

  if (routeLayer && routeLayer.params) req.params = routeLayer.params;

  await invokeHandler(authLayer.handle, req, res);
  if (res.finished) return res;

  if (routeLayer) {
    await invokeHandler(routeLayer.route.stack[0].handle, req, res);
    return res;
  }

  await invokeHandler(notFoundLayer.handle, req, res);
  return res;
}

function setupServer() {
  const homeDir = createTempHome("tachi-integration-test-");
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
    id, name, apiKey, capabilities = [], rateMin = 0, rateMax = 0,
    ratingAvg = 0, ratingCount = 0, walletBalance = 0, status = "active",
    createdAt = "2026-03-12T00:00:00.000Z",
  }) => {
    db.prepare(`
      INSERT INTO agents (id, name, api_key_hash, capabilities, rate_min, rate_max,
        description, rating_avg, rating_count, wallet_balance, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, hashApiKey(apiKey), JSON.stringify(capabilities), rateMin, rateMax,
      null, ratingAvg, ratingCount, walletBalance, status, createdAt);
  };

  const getBalance = (agentId) =>
    db.prepare("SELECT wallet_balance FROM agents WHERE id = ?").get(agentId)?.wallet_balance ?? 0;

  const getTransactions = (taskId) =>
    db.prepare("SELECT type, from_agent, to_agent, amount FROM transactions WHERE task_id = ? ORDER BY rowid ASC")
      .all(taskId);

  const sumTransactionsByType = (taskId) => {
    const txns = getTransactions(taskId);
    const sums = {};
    for (const t of txns) {
      sums[t.type] = (sums[t.type] || 0) + t.amount;
    }
    return sums;
  };

  return { app: createApp(db), db, insertAgent, getBalance, getTransactions, sumTransactionsByType, close };
}

describe("Cross-phase integration", () => {
  let ctx;

  afterEach(() => {
    if (ctx) { ctx.close(); ctx = null; }
  });

  describe("Full lifecycle: register → topup → post → accept → deliver → approve", () => {
    test("wallet balances are consistent after full happy path", async () => {
      ctx = setupServer();
      const BUDGET = 5;
      const INITIAL_BALANCE = 100;

      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: INITIAL_BALANCE, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller", name: "seller", apiKey: "sk", capabilities: ["code"], walletBalance: 0 });

      // Post task (escrow: 5 * 1.08 = 5.40)
      const postRes = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "bk" },
        body: { capability: "code", spec: "build it", budget_max: BUDGET },
      });
      expect(postRes.statusCode).toBe(201);
      const taskId = postRes.body.id;

      const buyerAfterPost = ctx.getBalance("buyer");
      expect(buyerAfterPost).toBeCloseTo(INITIAL_BALANCE - (BUDGET * 1.08), 5);

      // Accept
      const acceptRes = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/accept`, {
        headers: { "X-API-Key": "sk" },
      });
      expect(acceptRes.statusCode).toBe(200);

      // Deliver
      const deliverRes = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "sk" },
        body: { output_path: "/tmp/tachi/result.txt" },
      });
      expect(deliverRes.statusCode).toBe(200);

      // Approve
      const approveRes = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/approve`, {
        headers: { "X-API-Key": "bk" },
      });
      expect(approveRes.statusCode).toBe(200);
      expect(approveRes.body.status).toBe("approved");

      // Verify wallet balances
      const sellerFinal = ctx.getBalance("seller");
      const buyerFinal = ctx.getBalance("buyer");

      const sellerPayout = Number((BUDGET * 0.93).toFixed(2)); // 4.65
      const platformFee = Number((BUDGET * 0.07).toFixed(2)); // 0.35
      const buyerRefund = Number((BUDGET * 1.08 - BUDGET).toFixed(2)); // 0.40
      const totalHold = Number((BUDGET * 1.08).toFixed(2)); // 5.40

      expect(sellerFinal).toBeCloseTo(sellerPayout, 5); // 4.65
      expect(buyerFinal).toBeCloseTo(INITIAL_BALANCE - totalHold + buyerRefund, 5); // 100 - 5.40 + 0.40 = 95.00

      // ACCOUNTING INVARIANT: money in = money out
      // Total deducted from buyer = totalHold = 5.40
      // Total paid out = sellerPayout + platformFee + buyerRefund = 4.65 + 0.35 + 0.40 = 5.40
      expect(sellerPayout + platformFee + buyerRefund).toBeCloseTo(totalHold, 5);

      // Verify transaction records
      const txnSums = ctx.sumTransactionsByType(taskId);
      expect(txnSums.escrow_hold).toBeCloseTo(totalHold, 5);
      expect(txnSums.escrow_release).toBeCloseTo(sellerPayout, 5);
      expect(txnSums.platform_fee).toBeCloseTo(platformFee, 5);
      expect(txnSums.escrow_refund).toBeCloseTo(buyerRefund, 5);
    });
  });

  describe("Full lifecycle with rejection: post → accept → deliver → reject → re-deliver → approve", () => {
    test("accounting is correct: compute fee deducted from buyer, all money accounted for", async () => {
      ctx = setupServer();
      const BUDGET = 5;
      const INITIAL_BALANCE = 100;

      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: INITIAL_BALANCE, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller", name: "seller", apiKey: "sk", capabilities: ["code"], walletBalance: 0 });

      // Post task
      const postRes = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "bk" },
        body: { capability: "code", spec: "build it", budget_max: BUDGET },
      });
      const taskId = postRes.body.id;
      const totalHold = Number((BUDGET * 1.08).toFixed(2)); // 5.40
      const computeFee = Number((BUDGET * 0.25).toFixed(2)); // 1.25

      // Accept
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/accept`, {
        headers: { "X-API-Key": "sk" },
      });

      // Deliver
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "sk" },
        body: { output_path: "/tmp/tachi/v1.txt" },
      });

      // Buyer balance after post: 100 - 5.40 = 94.60
      const buyerAfterPost = ctx.getBalance("buyer");
      expect(buyerAfterPost).toBeCloseTo(INITIAL_BALANCE - totalHold, 5);

      // Reject (first rejection — compute fee of 25% from buyer wallet)
      const rejectRes = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/reject`, {
        headers: { "X-API-Key": "bk" },
        body: { reason: "Not good enough" },
      });
      expect(rejectRes.statusCode).toBe(200);
      expect(rejectRes.body.status).toBe("revision");

      // Verify compute fee deducted from buyer, paid to seller
      const sellerAfterReject = ctx.getBalance("seller");
      const buyerAfterReject = ctx.getBalance("buyer");
      expect(sellerAfterReject).toBeCloseTo(computeFee, 5); // 1.25
      expect(buyerAfterReject).toBeCloseTo(buyerAfterPost - computeFee, 5); // 94.60 - 1.25 = 93.35

      // Re-deliver
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "sk" },
        body: { output_path: "/tmp/tachi/v2.txt" },
      });

      // Approve
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/approve`, {
        headers: { "X-API-Key": "bk" },
      });

      // Check final balances
      const sellerFinal = ctx.getBalance("seller");
      const buyerFinal = ctx.getBalance("buyer");

      const sellerPayout = Number((BUDGET * 0.93).toFixed(2)); // 4.65
      const platformFee = Number((BUDGET * 0.07).toFixed(2)); // 0.35
      const buyerRefund = Number((totalHold - BUDGET).toFixed(2)); // 0.40

      // Seller total: compute fee (1.25) + escrow release (4.65) = 5.90
      expect(sellerFinal).toBeCloseTo(computeFee + sellerPayout, 5);

      // Buyer: 100 - 5.40 (escrow) - 1.25 (compute fee) + 0.40 (refund) = 93.75
      expect(buyerFinal).toBeCloseTo(INITIAL_BALANCE - totalHold - computeFee + buyerRefund, 5);

      // ACCOUNTING INVARIANT: buyer net spend = seller received + platform fee
      const buyerNetSpend = INITIAL_BALANCE - buyerFinal; // 100 - 93.75 = 6.25
      const totalReceived = sellerFinal + platformFee; // 5.90 + 0.35 = 6.25
      expect(totalReceived).toBeCloseTo(buyerNetSpend, 5); // EXACT MATCH — no money created from nothing
    });

    test("reject returns 402 if buyer cannot afford compute fee", async () => {
      ctx = setupServer();
      // Buyer has exactly enough for escrow but nothing left for compute fee
      const BUDGET = 5;
      const totalHold = Number((BUDGET * 1.08).toFixed(2)); // 5.40

      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: totalHold, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller", name: "seller", apiKey: "sk", capabilities: ["code"], walletBalance: 0 });

      const postRes = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "bk" },
        body: { capability: "code", spec: "build it", budget_max: BUDGET },
      });
      const taskId = postRes.body.id;

      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/accept`, { headers: { "X-API-Key": "sk" } });
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "sk" },
        body: { output_path: "/tmp/tachi/v1.txt" },
      });

      // Buyer has $0 left — can't pay compute fee
      expect(ctx.getBalance("buyer")).toBeCloseTo(0, 5);

      const rejectRes = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/reject`, {
        headers: { "X-API-Key": "bk" },
        body: { reason: "Bad work" },
      });

      expect(rejectRes.statusCode).toBe(402);
      expect(rejectRes.body.error).toMatch(/Insufficient wallet balance/);
    });
  });

  describe("Phase 3→4 interface: approved tasks affect $10 cap", () => {
    test("tasks approved via Phase 4 flow count toward the 3-task cap", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: 500, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller", name: "seller", apiKey: "sk", capabilities: ["code"], walletBalance: 0 });

      // Complete 3 tasks through full lifecycle
      for (let i = 0; i < 3; i++) {
        const postRes = await simulateRequest(ctx.app, "POST", "/tasks", {
          headers: { "X-API-Key": "bk" },
          body: { capability: "code", spec: `task ${i}`, budget_max: 5 },
        });
        const tid = postRes.body.id;

        await simulateRequest(ctx.app, "POST", `/tasks/${tid}/accept`, {
          headers: { "X-API-Key": "sk" },
        });
        await simulateRequest(ctx.app, "POST", `/tasks/${tid}/deliver`, {
          headers: { "X-API-Key": "sk" },
          body: { output_path: `/tmp/tachi/out-${i}.txt` },
        });
        await simulateRequest(ctx.app, "POST", `/tasks/${tid}/approve`, {
          headers: { "X-API-Key": "bk" },
        });
      }

      // Now buyer should be able to post tasks > $10 (no longer capped)
      const bigPostRes = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "bk" },
        body: { capability: "code", spec: "big task", budget_max: 50 },
      });

      expect(bigPostRes.statusCode).toBe(201);
      expect(bigPostRes.body.budget_max).toBe(50);
    });
  });

  describe("Phase 2→4 interface: wallet reflects escrow + refund correctly", () => {
    test("buyer can use refunded balance from approved task to post new task", async () => {
      ctx = setupServer();
      // Buyer starts with exactly enough for one task
      const BUDGET = 5;
      const totalHold = Number((BUDGET * 1.08).toFixed(2)); // 5.40

      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: totalHold, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller", name: "seller", apiKey: "sk", capabilities: ["code"], walletBalance: 0 });

      // Post + accept + deliver + approve
      const postRes = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "bk" },
        body: { capability: "code", spec: "task 1", budget_max: BUDGET },
      });
      const tid = postRes.body.id;

      // Buyer should have $0 after posting
      expect(ctx.getBalance("buyer")).toBeCloseTo(0, 5);

      await simulateRequest(ctx.app, "POST", `/tasks/${tid}/accept`, { headers: { "X-API-Key": "sk" } });
      await simulateRequest(ctx.app, "POST", `/tasks/${tid}/deliver`, {
        headers: { "X-API-Key": "sk" },
        body: { output_path: "/tmp/tachi/out.txt" },
      });
      await simulateRequest(ctx.app, "POST", `/tasks/${tid}/approve`, { headers: { "X-API-Key": "bk" } });

      // After approve, buyer gets $0.40 refund
      const buyerRefund = Number((totalHold - BUDGET).toFixed(2)); // 0.40
      expect(ctx.getBalance("buyer")).toBeCloseTo(buyerRefund, 5);

      // Buyer cannot post another task (only $0.40, need at least $1.08 for $1 task)
      const failPost = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "bk" },
        body: { capability: "code", spec: "task 2", budget_max: 1 },
      });
      expect(failPost.statusCode).toBe(402); // insufficient balance
    });
  });

  describe("Security: authorization boundary checks", () => {
    test("third-party agent cannot deliver, approve, or reject another pair's task", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: 100, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller", name: "seller", apiKey: "sk", capabilities: ["code"] });
      ctx.insertAgent({ id: "outsider", name: "outsider", apiKey: "ok", capabilities: ["code"] });

      const postRes = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "bk" },
        body: { capability: "code", spec: "build it", budget_max: 5 },
      });
      const taskId = postRes.body.id;

      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/accept`, {
        headers: { "X-API-Key": "sk" },
      });

      // Outsider cannot deliver
      const deliverRes = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "ok" },
        body: { output_path: "/tmp/tachi/evil.txt" },
      });
      expect(deliverRes.statusCode).toBe(403);

      // Legitimate deliver
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "sk" },
        body: { output_path: "/tmp/tachi/legit.txt" },
      });

      // Outsider cannot approve
      const approveRes = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/approve`, {
        headers: { "X-API-Key": "ok" },
      });
      expect(approveRes.statusCode).toBe(403);

      // Outsider cannot reject
      const rejectRes = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/reject`, {
        headers: { "X-API-Key": "ok" },
        body: { reason: "I'm not the buyer" },
      });
      expect(rejectRes.statusCode).toBe(403);
    });

    test("suspended agent cannot perform Phase 4 operations", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: 100, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller", name: "seller", apiKey: "sk", capabilities: ["code"], status: "suspended" });

      // Suspended seller cannot deliver
      const deliverRes = await simulateRequest(ctx.app, "POST", "/tasks/some-task/deliver", {
        headers: { "X-API-Key": "sk" },
        body: { output_path: "/tmp/tachi/output.txt" },
      });
      expect(deliverRes.statusCode).toBe(403);
      expect(deliverRes.body.error).toMatch(/not active/);
    });
  });

  describe("Edge cases", () => {
    test("deliver with whitespace-only output_path returns 400", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: 100, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller", name: "seller", apiKey: "sk", capabilities: ["code"] });

      const postRes = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "bk" },
        body: { capability: "code", spec: "build", budget_max: 5 },
      });
      await simulateRequest(ctx.app, "POST", `/tasks/${postRes.body.id}/accept`, {
        headers: { "X-API-Key": "sk" },
      });

      const deliverRes = await simulateRequest(ctx.app, "POST", `/tasks/${postRes.body.id}/deliver`, {
        headers: { "X-API-Key": "sk" },
        body: { output_path: "   " },
      });
      expect(deliverRes.statusCode).toBe(400);
    });

    test("reject with whitespace-only reason returns 400", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: 100, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller", name: "seller", apiKey: "sk", capabilities: ["code"] });

      const postRes = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "bk" },
        body: { capability: "code", spec: "build", budget_max: 5 },
      });
      await simulateRequest(ctx.app, "POST", `/tasks/${postRes.body.id}/accept`, {
        headers: { "X-API-Key": "sk" },
      });
      await simulateRequest(ctx.app, "POST", `/tasks/${postRes.body.id}/deliver`, {
        headers: { "X-API-Key": "sk" },
        body: { output_path: "/tmp/tachi/out.txt" },
      });

      const rejectRes = await simulateRequest(ctx.app, "POST", `/tasks/${postRes.body.id}/reject`, {
        headers: { "X-API-Key": "bk" },
        body: { reason: "   " },
      });
      expect(rejectRes.statusCode).toBe(400);
    });

    test("escrow math with fractional budget (7.77)", async () => {
      ctx = setupServer();
      const BUDGET = 7.77;

      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: 100, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller", name: "seller", apiKey: "sk", capabilities: ["code"], walletBalance: 0 });

      const postRes = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "bk" },
        body: { capability: "code", spec: "fractional test", budget_max: BUDGET },
      });
      const taskId = postRes.body.id;

      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/accept`, { headers: { "X-API-Key": "sk" } });
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "sk" },
        body: { output_path: "/tmp/tachi/out.txt" },
      });
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/approve`, { headers: { "X-API-Key": "bk" } });

      const totalHold = Number((BUDGET * 1.08).toFixed(2)); // 8.39
      const sellerPayout = Number((BUDGET * 0.93).toFixed(2)); // 7.23
      const platformFee = Number((BUDGET * 0.07).toFixed(2)); // 0.54
      const buyerRefund = Number((totalHold - BUDGET).toFixed(2)); // 0.62

      expect(ctx.getBalance("seller")).toBeCloseTo(sellerPayout, 2);
      expect(ctx.getBalance("buyer")).toBeCloseTo(100 - totalHold + buyerRefund, 2);

      // Verify no rounding leaks: seller + platform + buyer_refund should account for all escrow
      const accountedFor = sellerPayout + platformFee + buyerRefund;
      // Allow up to 1 cent rounding error
      expect(Math.abs(accountedFor - totalHold)).toBeLessThanOrEqual(0.01);
    });
  });
});
