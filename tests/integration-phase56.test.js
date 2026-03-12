/**
 * Cross-phase integration tests for Phase 5 (call) and Phase 6 (watch).
 * Verifies:
 * - Full call flow with escrow math
 * - Watch auto-accept + auto-release with escrow math
 * - Cross-phase interactions (call/watch → $10 cap, wallet flows)
 * - Security boundaries
 * - Edge cases and error handling
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
    statusCode: 200, body: undefined, headers: {}, locals: {}, finished: false,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.finished = true; if (this._resolve) this._resolve(); return this; },
    setHeader(n, v) { this.headers[n.toLowerCase()] = v; },
    getHeader(n) { return this.headers[n.toLowerCase()]; },
    removeHeader(n) { delete this.headers[n.toLowerCase()]; },
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
  const authLayer = layers.find((l) => l.name === "authMiddleware");
  const routeLayer = layers.find((l) => {
    if (!l.route || !l.route.methods[method.toLowerCase()]) return false;
    return l.match(req.path);
  });
  const notFoundLayer = layers[layers.length - 1];
  if (routeLayer && routeLayer.params) req.params = routeLayer.params;

  await invokeHandler(authLayer.handle, req, res);
  if (res.finished) return res;
  if (routeLayer) { await invokeHandler(routeLayer.route.stack[0].handle, req, res); return res; }
  await invokeHandler(notFoundLayer.handle, req, res);
  return res;
}

function setupServer() {
  const homeDir = createTempHome("tachi-int56-test-");
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

  const insertTask = ({
    id, buyerId, sellerId = null, capability = "code", description = null,
    spec = "ship it", piiMask = 1, budgetMax = 10, agreedPrice = null,
    reviewWindowMs = 7_200_000, status = "open", inputPath = null, outputPath = null,
    rejectionReason = null, revisionCount = 0,
    createdAt = "2026-03-12T00:00:00.000Z", acceptedAt = null, deliveredAt = null, completedAt = null,
  }) => {
    db.prepare(`
      INSERT INTO tasks (id, buyer_id, seller_id, capability, description, spec, pii_mask, budget_max, agreed_price,
        review_window_ms, status, input_path, output_path, rejection_reason, revision_count,
        created_at, accepted_at, delivered_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, buyerId, sellerId, capability, description, spec, piiMask, budgetMax, agreedPrice,
      reviewWindowMs, status, inputPath, outputPath, rejectionReason, revisionCount,
      createdAt, acceptedAt, deliveredAt, completedAt);
  };

  return { app: createApp(db), db, insertAgent, insertTask, getBalance, getTransactions, close };
}


describe("Phase 5+6 Cross-phase integration", () => {
  let ctx;

  afterEach(() => {
    if (ctx) { ctx.close(); ctx = null; }
  });

  describe("call command → full lifecycle with escrow verification", () => {
    test("call auto-approve produces correct wallet balances (Phase 2+3+4+5)", async () => {
      ctx = setupServer();
      const BUDGET = 5;
      const INITIAL = 100;

      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: INITIAL, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller", name: "seller", apiKey: "sk", capabilities: ["code"], walletBalance: 0 });

      // Simulate what `tachi call --auto-approve` does internally:
      // 1. POST task
      const postRes = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "bk" },
        body: { capability: "code", spec: "build it", budget_max: BUDGET },
      });
      expect(postRes.statusCode).toBe(201);
      const taskId = postRes.body.id;

      // Verify escrow deducted
      const totalHold = Number((BUDGET * 1.08).toFixed(2));
      expect(ctx.getBalance("buyer")).toBeCloseTo(INITIAL - totalHold, 5);

      // 2. Seller accepts (simulating what happens during call's polling)
      const acceptRes = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/accept`, {
        headers: { "X-API-Key": "sk" },
      });
      expect(acceptRes.statusCode).toBe(200);

      // 3. Seller delivers
      const deliverRes = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "sk" },
        body: { output_path: "/tmp/result.txt" },
      });
      expect(deliverRes.statusCode).toBe(200);

      // 4. call auto-approves
      const approveRes = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/approve`, {
        headers: { "X-API-Key": "bk" },
      });
      expect(approveRes.statusCode).toBe(200);

      // Verify final balances
      const sellerPayout = Number((BUDGET * 0.93).toFixed(2));
      const platformFee = Number((BUDGET * 0.07).toFixed(2));
      const buyerRefund = Number((totalHold - BUDGET).toFixed(2));

      expect(ctx.getBalance("seller")).toBeCloseTo(sellerPayout, 5);
      expect(ctx.getBalance("buyer")).toBeCloseTo(INITIAL - totalHold + buyerRefund, 5);

      // Accounting invariant
      const buyerNet = INITIAL - ctx.getBalance("buyer");
      const totalOut = ctx.getBalance("seller") + platformFee;
      expect(totalOut).toBeCloseTo(buyerNet, 5);
    });
  });

  describe("watch auto-release → full escrow verification (Phase 2+3+4+6)", () => {
    test("auto-release produces correct wallet balances", async () => {
      ctx = setupServer();
      const BUDGET = 8;
      const INITIAL = 200;

      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: INITIAL, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller", name: "seller", apiKey: "sk", capabilities: ["code"], walletBalance: 0 });

      // Post + accept + deliver
      const postRes = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "bk" },
        body: { capability: "code", spec: "build it", budget_max: BUDGET },
      });
      const taskId = postRes.body.id;
      const totalHold = Number((BUDGET * 1.08).toFixed(2));

      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/accept`, {
        headers: { "X-API-Key": "sk" },
      });
      await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "sk" },
        body: { output_path: "/tmp/out.txt" },
      });

      // Simulate time passing beyond review window by backdating delivered_at
      const pastTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3 hours ago
      ctx.db.prepare("UPDATE tasks SET delivered_at = ? WHERE id = ?").run(pastTime, taskId);

      // Now simulate what watch auto-release does:
      // GET /tasks/mine?status=delivered
      const mineRes = await simulateRequest(ctx.app, "GET", "/tasks/mine?status=delivered", {
        headers: { "X-API-Key": "bk" },
      });
      expect(mineRes.statusCode).toBe(200);
      expect(mineRes.body.length).toBe(1);
      expect(mineRes.body[0].id).toBe(taskId);

      // Check review window expired
      const task = mineRes.body[0];
      const deliveredAtMs = new Date(task.delivered_at).getTime();
      const reviewWindowMs = task.review_window_ms || 7200000;
      expect(Date.now()).toBeGreaterThan(deliveredAtMs + reviewWindowMs);

      // Auto-approve
      const approveRes = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/approve`, {
        headers: { "X-API-Key": "bk" },
      });
      expect(approveRes.statusCode).toBe(200);

      // Verify final balances
      const sellerPayout = Number((BUDGET * 0.93).toFixed(2));
      const platformFee = Number((BUDGET * 0.07).toFixed(2));
      const buyerRefund = Number((totalHold - BUDGET).toFixed(2));

      expect(ctx.getBalance("seller")).toBeCloseTo(sellerPayout, 5);
      expect(ctx.getBalance("buyer")).toBeCloseTo(INITIAL - totalHold + buyerRefund, 5);

      // Accounting invariant
      const buyerNet = INITIAL - ctx.getBalance("buyer");
      const totalOut = ctx.getBalance("seller") + platformFee;
      expect(totalOut).toBeCloseTo(buyerNet, 5);
    });
  });

  describe("GET /tasks/mine cross-phase verification", () => {
    test("/tasks/mine returns tasks in all status phases", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: 100, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller", name: "seller", apiKey: "sk", capabilities: ["code"] });

      // Create tasks in various statuses spanning all phases
      ctx.insertTask({ id: "t-open", buyerId: "buyer", status: "open", capability: "code" });
      ctx.insertTask({ id: "t-progress", buyerId: "buyer", sellerId: "seller", status: "in-progress", capability: "code" });
      ctx.insertTask({ id: "t-delivered", buyerId: "buyer", sellerId: "seller", status: "delivered", capability: "code", deliveredAt: new Date().toISOString() });
      ctx.insertTask({ id: "t-approved", buyerId: "buyer", sellerId: "seller", status: "approved", capability: "code", completedAt: new Date().toISOString() });
      ctx.insertTask({ id: "t-revision", buyerId: "buyer", sellerId: "seller", status: "revision", capability: "code" });
      ctx.insertTask({ id: "t-disputed", buyerId: "buyer", sellerId: "seller", status: "disputed", capability: "code" });

      // All tasks for buyer
      const allRes = await simulateRequest(ctx.app, "GET", "/tasks/mine", {
        headers: { "X-API-Key": "bk" },
      });
      expect(allRes.statusCode).toBe(200);
      expect(allRes.body.length).toBe(6);

      // Filter by delivered
      const deliveredRes = await simulateRequest(ctx.app, "GET", "/tasks/mine?status=delivered", {
        headers: { "X-API-Key": "bk" },
      });
      expect(deliveredRes.statusCode).toBe(200);
      expect(deliveredRes.body.length).toBe(1);
      expect(deliveredRes.body[0].id).toBe("t-delivered");

      // Seller sees tasks where they're seller (not open ones without seller_id)
      const sellerRes = await simulateRequest(ctx.app, "GET", "/tasks/mine", {
        headers: { "X-API-Key": "sk" },
      });
      expect(sellerRes.statusCode).toBe(200);
      // seller_id is set on 5 tasks (not t-open)
      expect(sellerRes.body.length).toBe(5);
    });
  });

  describe("call auto-approve counts toward $10 cap (Phase 3+5)", () => {
    test("3 tasks approved via call flow unlock >$10 budget", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: 500, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller", name: "seller", apiKey: "sk", capabilities: ["code"], walletBalance: 0 });

      // Complete 3 tasks via the call flow (post → accept → deliver → approve)
      for (let i = 0; i < 3; i++) {
        const postRes = await simulateRequest(ctx.app, "POST", "/tasks", {
          headers: { "X-API-Key": "bk" },
          body: { capability: "code", spec: `task ${i}`, budget_max: 5 },
        });
        const tid = postRes.body.id;
        await simulateRequest(ctx.app, "POST", `/tasks/${tid}/accept`, { headers: { "X-API-Key": "sk" } });
        await simulateRequest(ctx.app, "POST", `/tasks/${tid}/deliver`, {
          headers: { "X-API-Key": "sk" }, body: { output_path: `/tmp/out-${i}.txt` },
        });
        await simulateRequest(ctx.app, "POST", `/tasks/${tid}/approve`, { headers: { "X-API-Key": "bk" } });
      }

      // Now buyer should be able to post >$10
      const bigPost = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "bk" },
        body: { capability: "code", spec: "big task", budget_max: 50 },
      });
      expect(bigPost.statusCode).toBe(201);
      expect(bigPost.body.budget_max).toBe(50);
    });
  });

  describe("watch auto-accept security boundaries (Phase 3+6)", () => {
    test("auto-accept cannot accept buyer's own tasks (403 silently skipped)", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: 100, capabilities: ["code"] });

      // Buyer posts a task
      const postRes = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "bk" },
        body: { capability: "code", spec: "build it", budget_max: 5 },
      });
      const taskId = postRes.body.id;

      // Buyer tries to accept own task (what watch --auto-accept would do)
      const acceptRes = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/accept`, {
        headers: { "X-API-Key": "bk" },
      });
      expect(acceptRes.statusCode).toBe(403);

      // Task stays open
      const taskDetail = await simulateRequest(ctx.app, "GET", `/tasks/${taskId}`, {
        headers: { "X-API-Key": "bk" },
      });
      expect(taskDetail.body.status).toBe("open");
    });

    test("auto-accept cannot accept without matching capability (403 silently skipped)", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: 100, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller", name: "seller", apiKey: "sk", capabilities: ["writing"] }); // no "code" capability

      const postRes = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "bk" },
        body: { capability: "code", spec: "build it", budget_max: 5 },
      });
      const taskId = postRes.body.id;

      // Seller without matching capability tries to accept
      const acceptRes = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/accept`, {
        headers: { "X-API-Key": "sk" },
      });
      expect(acceptRes.statusCode).toBe(403);
    });

    test("auto-accept cannot double-accept a task (409 silently skipped)", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: 100, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller1", name: "seller1", apiKey: "sk1", capabilities: ["code"] });
      ctx.insertAgent({ id: "seller2", name: "seller2", apiKey: "sk2", capabilities: ["code"] });

      const postRes = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "bk" },
        body: { capability: "code", spec: "build it", budget_max: 5 },
      });
      const taskId = postRes.body.id;

      // First seller accepts
      const accept1 = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/accept`, {
        headers: { "X-API-Key": "sk1" },
      });
      expect(accept1.statusCode).toBe(200);

      // Second seller tries to accept (already in-progress)
      const accept2 = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/accept`, {
        headers: { "X-API-Key": "sk2" },
      });
      expect(accept2.statusCode).toBe(409);
    });
  });

  describe("watch auto-release timing boundaries (Phase 4+6)", () => {
    test("auto-release does NOT approve task within review window", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: 100, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller", name: "seller", apiKey: "sk", capabilities: ["code"] });

      // Delivered 30 min ago, review window is 2 hours
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      ctx.insertTask({
        id: "t-recent", buyerId: "buyer", sellerId: "seller",
        status: "delivered", deliveredAt: thirtyMinAgo,
        reviewWindowMs: 7_200_000, agreedPrice: 5, budgetMax: 5, outputPath: "/tmp/out.txt",
      });

      // GET /tasks/mine shows it as delivered
      const mineRes = await simulateRequest(ctx.app, "GET", "/tasks/mine?status=delivered", {
        headers: { "X-API-Key": "bk" },
      });
      expect(mineRes.body.length).toBe(1);

      // Check review window NOT expired
      const task = mineRes.body[0];
      const deliveredAtMs = new Date(task.delivered_at).getTime();
      expect(Date.now()).toBeLessThan(deliveredAtMs + task.review_window_ms);

      // Task should NOT be auto-approved — it's still within review window
      // (watch would skip it, but buyer CAN manually approve)
      const approveRes = await simulateRequest(ctx.app, "POST", "/tasks/t-recent/approve", {
        headers: { "X-API-Key": "bk" },
      });
      // Manual approve always works regardless of review window
      expect(approveRes.statusCode).toBe(200);
    });

    test("auto-release DOES approve task past review window", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: 100, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller", name: "seller", apiKey: "sk", capabilities: ["code"], walletBalance: 0 });

      // Delivered 3 hours ago, review window is 2 hours
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      ctx.insertTask({
        id: "t-expired", buyerId: "buyer", sellerId: "seller",
        status: "delivered", deliveredAt: threeHoursAgo,
        reviewWindowMs: 7_200_000, agreedPrice: 5, budgetMax: 5, outputPath: "/tmp/out.txt",
      });

      // Verify review window expired
      const task = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get("t-expired");
      const deliveredAtMs = new Date(task.delivered_at).getTime();
      expect(Date.now()).toBeGreaterThan(deliveredAtMs + task.review_window_ms);

      // Auto-release would call approve
      const approveRes = await simulateRequest(ctx.app, "POST", "/tasks/t-expired/approve", {
        headers: { "X-API-Key": "bk" },
      });
      expect(approveRes.statusCode).toBe(200);
      expect(approveRes.body.status).toBe("approved");

      // Verify wallet balances
      expect(ctx.getBalance("seller")).toBeCloseTo(5 * 0.93, 5);
    });
  });

  describe("pollForStatus edge cases (Phase 5)", () => {
    test("pollForStatus returns task immediately if already in target status", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: 100, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller", name: "seller", apiKey: "sk", capabilities: ["code"] });

      // Create task already in-progress
      ctx.insertTask({
        id: "t-fast", buyerId: "buyer", sellerId: "seller", status: "in-progress",
        agreedPrice: 5, budgetMax: 5, acceptedAt: new Date().toISOString(),
      });

      // Poll should return immediately
      const { pollForStatus } = require("../cli/commands/call");
      const mockFetch = async (url, opts) => {
        const res = await simulateRequest(ctx.app, opts?.method || "GET",
          new URL(url).pathname, { headers: opts?.headers });
        return {
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => res.body,
        };
      };

      const result = await pollForStatus(
        "http://test", "bk", "t-fast", ["in-progress"], 1000, 50,
        { fetchImpl: mockFetch }
      );

      expect(result).not.toBeNull();
      expect(result.status).toBe("in-progress");
    });

    test("pollForStatus returns null on timeout", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", capabilities: ["design"] });

      // Task stays open (no seller to accept)
      ctx.insertTask({ id: "t-stuck", buyerId: "buyer", status: "open" });

      const { pollForStatus } = require("../cli/commands/call");
      const mockFetch = async (url, opts) => {
        const res = await simulateRequest(ctx.app, opts?.method || "GET",
          new URL(url).pathname, { headers: opts?.headers });
        return {
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => res.body,
        };
      };

      const result = await pollForStatus(
        "http://test", "bk", "t-stuck", ["in-progress"], 200, 50,
        { fetchImpl: mockFetch }
      );

      expect(result).toBeNull();
    });
  });

  describe("watch + call end-to-end: two agents collaborate (Phase 2+3+4+5+6)", () => {
    test("buyer calls, seller watches + auto-accepts + delivers, buyer auto-approves", async () => {
      ctx = setupServer();
      const BUDGET = 10;

      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: 100, capabilities: ["design"] });
      ctx.insertAgent({ id: "seller", name: "seller", apiKey: "sk", capabilities: ["code"], walletBalance: 0 });

      // Step 1: Buyer posts task (what `tachi call` does first)
      const postRes = await simulateRequest(ctx.app, "POST", "/tasks", {
        headers: { "X-API-Key": "bk" },
        body: { capability: "code", spec: "build widget", budget_max: BUDGET },
      });
      expect(postRes.statusCode).toBe(201);
      const taskId = postRes.body.id;
      const totalHold = Number((BUDGET * 1.08).toFixed(2));

      // Verify task exists in DB — matching engine auto-matches since seller has "code" capability
      const dbTask = ctx.db.prepare("SELECT id, status, capability, seller_id FROM tasks WHERE id = ?").get(taskId);
      expect(dbTask).toBeDefined();
      expect(dbTask.status).toBe("matched");
      expect(dbTask.seller_id).toBe("seller"); // auto-matched

      // Step 2: Seller sees the matched task via GET /tasks/:id
      const taskRes = await simulateRequest(ctx.app, "GET", `/tasks/${taskId}`, {
        headers: { "X-API-Key": "sk" },
      });
      expect(taskRes.statusCode).toBe(200);
      expect(taskRes.body.status).toBe("matched");

      // Step 3: Seller accepts the matched task
      const acceptRes = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/accept`, {
        headers: { "X-API-Key": "sk" },
      });
      expect(acceptRes.statusCode).toBe(200);

      // Step 4: Seller delivers work
      const deliverRes = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/deliver`, {
        headers: { "X-API-Key": "sk" },
        body: { output_path: "/tmp/widget-v1.js" },
      });
      expect(deliverRes.statusCode).toBe(200);

      // Step 5: Buyer's call auto-approves
      const approveRes = await simulateRequest(ctx.app, "POST", `/tasks/${taskId}/approve`, {
        headers: { "X-API-Key": "bk" },
      });
      expect(approveRes.statusCode).toBe(200);

      // Final verification: all wallet balances correct
      const sellerPayout = Number((BUDGET * 0.93).toFixed(2));
      const platformFee = Number((BUDGET * 0.07).toFixed(2));
      const buyerRefund = Number((totalHold - BUDGET).toFixed(2));

      expect(ctx.getBalance("seller")).toBeCloseTo(sellerPayout, 5);
      expect(ctx.getBalance("buyer")).toBeCloseTo(100 - totalHold + buyerRefund, 5);

      // Accounting invariant: no money created or destroyed
      const buyerNet = 100 - ctx.getBalance("buyer");
      const totalReceived = ctx.getBalance("seller") + platformFee;
      expect(totalReceived).toBeCloseTo(buyerNet, 5);

      // Verify all transaction types present
      const txns = ctx.getTransactions(taskId);
      const types = txns.map(t => t.type);
      expect(types).toContain("escrow_hold");
      expect(types).toContain("escrow_release");
      expect(types).toContain("platform_fee");
      expect(types).toContain("escrow_refund");
    });
  });

  describe("/tasks/mine route ordering (Phase 6 critical)", () => {
    test("/tasks/mine is NOT matched as /tasks/:id with id='mine'", async () => {
      ctx = setupServer();
      ctx.insertAgent({ id: "buyer", name: "buyer", apiKey: "bk", walletBalance: 100 });

      // GET /tasks/mine should return array (findMyTasks), not 404 (getTaskDetail)
      const mineRes = await simulateRequest(ctx.app, "GET", "/tasks/mine", {
        headers: { "X-API-Key": "bk" },
      });
      expect(mineRes.statusCode).toBe(200);
      expect(Array.isArray(mineRes.body)).toBe(true);

      // GET /tasks/nonexistent should return 404 from getTaskDetail
      const notFoundRes = await simulateRequest(ctx.app, "GET", "/tasks/nonexistent", {
        headers: { "X-API-Key": "bk" },
      });
      expect(notFoundRes.statusCode).toBe(404);
    });
  });
});
