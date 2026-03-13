/**
 * Full cross-phase integration test: Phases 1-9 end-to-end
 *
 * Tests the COMPLETE lifecycle:
 *   Register → Topup → Post (with PII masking) → Accept → Deliver → Approve → Rate
 *   Then verifies ALL Phase 9 read endpoints return correct, consistent data.
 *
 * Also tests: rejection flow, disputed state, wallet math integrity, security boundaries.
 */
const { randomUUID } = require("crypto");

const Database = require("better-sqlite3");

const { createApp } = require("../server");
const { hashApiKey } = require("../lib/hash");

let db;
let app;

// ─── Mock request/response (matches existing test patterns) ─────────────────

function createMockRequest(method, requestPath, headers = {}, body) {
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
      if (this._resolve) this._resolve();
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

function simulateRequest(method, path, { body, apiKey, query } = {}) {
  return new Promise((resolve) => {
    const url = query
      ? `${path}?${new URLSearchParams(query).toString()}`
      : path;
    const headers = apiKey ? { "x-api-key": apiKey } : {};
    const req = createMockRequest(method, url, headers, body);
    const res = createMockResponse();

    res._resolve = () => {
      resolve({ status: res.statusCode, body: res.body });
    };

    app.handle(req, res, () => {
      resolve({ status: 404, body: { error: "No route matched" } });
    });
  });
}

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, api_key_hash TEXT NOT NULL,
      capabilities TEXT, rate_min REAL DEFAULT 0, rate_max REAL DEFAULT 0,
      description TEXT, rating_avg REAL DEFAULT 0, rating_count INTEGER DEFAULT 0,
      wallet_balance REAL DEFAULT 0, status TEXT DEFAULT 'active' CHECK (status IN ('active','suspended')),
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, buyer_id TEXT NOT NULL, seller_id TEXT,
      capability TEXT NOT NULL, description TEXT, spec TEXT NOT NULL,
      pii_mask INTEGER DEFAULT 1, budget_max REAL NOT NULL, agreed_price REAL,
      review_window_ms INTEGER DEFAULT 7200000,
      status TEXT DEFAULT 'open' CHECK (status IN ('open','matched','in-progress','delivered','approved','rejected','disputed','expired','revision')),
      input_path TEXT, output_path TEXT, rejection_reason TEXT, revision_count INTEGER DEFAULT 0,
      created_at TEXT, accepted_at TEXT, delivered_at TEXT, completed_at TEXT,
      FOREIGN KEY (buyer_id) REFERENCES agents(id), FOREIGN KEY (seller_id) REFERENCES agents(id)
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY, task_id TEXT, from_agent TEXT, to_agent TEXT,
      amount REAL NOT NULL, type TEXT NOT NULL CHECK (type IN ('topup','escrow_hold','escrow_release','escrow_refund','compute_fee','platform_fee')),
      created_at TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, reviewer_id TEXT NOT NULL,
      reviewee_id TEXT NOT NULL, rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT, role TEXT NOT NULL CHECK (role IN ('buyer','seller')), created_at TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );
  `);
  app = createApp(db);
});

afterAll(() => {
  db.close();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function registerAgent(name, capabilities, rateMin, rateMax, description) {
  const apiKey = `key-${randomUUID()}`;
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO agents (id, name, api_key_hash, capabilities, rate_min, rate_max, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, hashApiKey(apiKey), JSON.stringify(capabilities), rateMin, rateMax, description, now);
  return { id, apiKey, name };
}

function topup(agentId, amount) {
  const now = new Date().toISOString();
  db.prepare("UPDATE agents SET wallet_balance = wallet_balance + ? WHERE id = ?").run(amount, agentId);
  db.prepare("INSERT INTO transactions (id, task_id, from_agent, to_agent, amount, type, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(randomUUID(), null, null, agentId, amount, "topup", now);
}

function getBalance(agentId) {
  return db.prepare("SELECT wallet_balance FROM agents WHERE id = ?").get(agentId).wallet_balance;
}

// ─── TEST SUITE ─────────────────────────────────────────────────────────────

describe("Full lifecycle integration (Phases 1-9)", () => {
  let buyer, seller, thirdParty;
  let task1Id; // happy path task
  let task2Id; // rejection → revision → deliver → approve task
  let task3Id; // double rejection → disputed task

  beforeAll(() => {
    buyer = registerAgent("integ-buyer", ["management"], 0, 100, "A buyer agent");
    seller = registerAgent("integ-seller", ["code-review", "summarization"], 1, 50, "A specialist agent");
    thirdParty = registerAgent("integ-observer", ["translation"], 2, 30, "An uninvolved agent");

    topup(buyer.id, 500);
    topup(thirdParty.id, 200);
  });

  // ─── Phase 3: Post + Match ───────────────────────────────────────────────

  test("buyer posts task and seller gets auto-matched", async () => {
    const res = await simulateRequest("POST", "/tasks", {
      apiKey: buyer.apiKey,
      body: {
        capability: "code-review",
        spec: "Review the auth module for security issues",
        budget_max: 10,
        description: "Standard code review",
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("matched");
    expect(res.body.matched_agent_id).toBe(seller.id);
    expect(res.body.buyer_id).toBe(buyer.id);
    task1Id = res.body.id;

    // Verify escrow deducted: 10 * 1.08 = 10.80
    const bal = getBalance(buyer.id);
    expect(bal).toBeCloseTo(500 - 10.80, 2);
  });

  // ─── Phase 3: Accept ─────────────────────────────────────────────────────

  test("seller accepts the matched task", async () => {
    const res = await simulateRequest("POST", `/tasks/${task1Id}/accept`, {
      apiKey: seller.apiKey,
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in-progress");
    expect(res.body.seller_id).toBe(seller.id);
    expect(res.body.agreed_price).toBe(10);
  });

  // ─── Phase 4: Deliver + Approve ──────────────────────────────────────────

  test("seller delivers output", async () => {
    const res = await simulateRequest("POST", `/tasks/${task1Id}/deliver`, {
      apiKey: seller.apiKey,
      body: { output_path: "/tmp/tachi/results/review-1.md" },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("delivered");
    expect(res.body.output_path).toBe("/tmp/tachi/results/review-1.md");
  });

  test("buyer approves — escrow releases correctly", async () => {
    const buyerBefore = getBalance(buyer.id);
    const sellerBefore = getBalance(seller.id);

    const res = await simulateRequest("POST", `/tasks/${task1Id}/approve`, {
      apiKey: buyer.apiKey,
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");

    // Seller gets 10 * 0.93 = 9.30
    const sellerAfter = getBalance(seller.id);
    expect(sellerAfter - sellerBefore).toBeCloseTo(9.30, 2);

    // Buyer refund: 10.80 - 10 = 0.80
    const buyerAfter = getBalance(buyer.id);
    expect(buyerAfter - buyerBefore).toBeCloseTo(0.80, 2);
  });

  // ─── Phase 8: Both sides rate each other ─────────────────────────────────

  test("buyer rates seller 5/5", async () => {
    const res = await simulateRequest("POST", `/tasks/${task1Id}/rate`, {
      apiKey: buyer.apiKey,
      body: { rating: 5, comment: "Excellent review" },
    });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("buyer");
    expect(res.body.reviewee_id).toBe(seller.id);
    expect(res.body.reviewee_rating.avg).toBe(5);
    expect(res.body.reviewee_rating.count).toBe(1);
  });

  test("seller rates buyer 4/5", async () => {
    const res = await simulateRequest("POST", `/tasks/${task1Id}/rate`, {
      apiKey: seller.apiKey,
      body: { rating: 4, comment: "Clear specs, quick approval" },
    });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("seller");
    expect(res.body.reviewee_id).toBe(buyer.id);
    expect(res.body.reviewee_rating.avg).toBe(4);
    expect(res.body.reviewee_rating.count).toBe(1);
  });

  // ─── Phase 7: PII masking on post ────────────────────────────────────────

  test("PII in spec is masked before storage", async () => {
    const res = await simulateRequest("POST", "/tasks", {
      apiKey: buyer.apiKey,
      body: {
        capability: "code-review",
        spec: "Review my code, my API key is sk-1234567890abcdef1234567890abcdef and my email is test@example.com",
        budget_max: 8,
        pii_mask: true,
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.spec).not.toContain("sk-1234567890abcdef");
    expect(res.body.spec).not.toContain("test@example.com");
    expect(res.body.spec).toContain("[REDACTED");
    task2Id = res.body.id;
  });

  // ─── Phase 4: Rejection → Revision → Re-deliver → Approve ────────────────

  test("rejection flow: reject → revision → re-deliver → approve", async () => {
    // Seller accepts task2
    let res = await simulateRequest("POST", `/tasks/${task2Id}/accept`, {
      apiKey: seller.apiKey,
    });
    expect(res.status).toBe(200);

    // Seller delivers
    res = await simulateRequest("POST", `/tasks/${task2Id}/deliver`, {
      apiKey: seller.apiKey,
      body: { output_path: "/tmp/tachi/results/v1.md" },
    });
    expect(res.status).toBe(200);

    const buyerBeforeReject = getBalance(buyer.id);
    const sellerBeforeReject = getBalance(seller.id);

    // Buyer rejects — compute fee: 8 * 0.25 = 2.00
    res = await simulateRequest("POST", `/tasks/${task2Id}/reject`, {
      apiKey: buyer.apiKey,
      body: { reason: "Missed critical security check" },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("revision");
    expect(res.body.revision_count).toBe(1);

    // Verify compute fee transfer
    expect(getBalance(buyer.id)).toBeCloseTo(buyerBeforeReject - 2.00, 2);
    expect(getBalance(seller.id)).toBeCloseTo(sellerBeforeReject + 2.00, 2);

    // Seller re-delivers
    res = await simulateRequest("POST", `/tasks/${task2Id}/deliver`, {
      apiKey: seller.apiKey,
      body: { output_path: "/tmp/tachi/results/v2.md" },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("delivered");

    // Buyer approves revision
    res = await simulateRequest("POST", `/tasks/${task2Id}/approve`, {
      apiKey: buyer.apiKey,
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
  });

  // ─── Double rejection → disputed ─────────────────────────────────────────

  test("double rejection leads to disputed state", async () => {
    let res = await simulateRequest("POST", "/tasks", {
      apiKey: buyer.apiKey,
      body: {
        capability: "summarization",
        spec: "Summarize the quarterly report",
        budget_max: 5,
      },
    });
    expect(res.status).toBe(201);
    task3Id = res.body.id;

    // Accept
    res = await simulateRequest("POST", `/tasks/${task3Id}/accept`, {
      apiKey: seller.apiKey,
    });
    expect(res.status).toBe(200);

    // Deliver → Reject (first)
    res = await simulateRequest("POST", `/tasks/${task3Id}/deliver`, {
      apiKey: seller.apiKey,
      body: { output_path: "/tmp/tachi/out/v1.md" },
    });
    res = await simulateRequest("POST", `/tasks/${task3Id}/reject`, {
      apiKey: buyer.apiKey,
      body: { reason: "Not detailed enough" },
    });
    expect(res.body.status).toBe("revision");

    // Deliver → Reject (second) → disputed
    res = await simulateRequest("POST", `/tasks/${task3Id}/deliver`, {
      apiKey: seller.apiKey,
      body: { output_path: "/tmp/tachi/out/v2.md" },
    });
    res = await simulateRequest("POST", `/tasks/${task3Id}/reject`, {
      apiKey: buyer.apiKey,
      body: { reason: "Still not good enough" },
    });
    expect(res.body.status).toBe("disputed");
  });

  // Rate task2 to build up rating history
  test("buyer rates seller on task2 — 3/5, rating updates correctly", async () => {
    const res = await simulateRequest("POST", `/tasks/${task2Id}/rate`, {
      apiKey: buyer.apiKey,
      body: { rating: 3, comment: "Needed revision but got there" },
    });
    expect(res.status).toBe(201);
    // Seller now has 2 reviews: 5 and 3 → avg = 4.0
    expect(res.body.reviewee_rating.avg).toBe(4);
    expect(res.body.reviewee_rating.count).toBe(2);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 9 READ ENDPOINTS — VERIFICATION AGAINST FULL STATE
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Phase 9: GET /agents (list)", () => {
    test("returns all three agents with correct fields", async () => {
      const res = await simulateRequest("GET", "/agents", { apiKey: buyer.apiKey });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(3);

      const names = res.body.map((a) => a.name);
      expect(names).toContain("integ-buyer");
      expect(names).toContain("integ-seller");
      expect(names).toContain("integ-observer");
    });

    test("seller profile shows correct rating from phases 8+", async () => {
      const res = await simulateRequest("GET", "/agents", { apiKey: buyer.apiKey });
      const sellerProfile = res.body.find((a) => a.name === "integ-seller");
      expect(sellerProfile.rating_avg).toBe(4);
      expect(sellerProfile.rating_count).toBe(2);
      expect(sellerProfile.capabilities).toEqual(["code-review", "summarization"]);
    });

    test("buyer profile shows rating from seller's review", async () => {
      const res = await simulateRequest("GET", "/agents", { apiKey: buyer.apiKey });
      const buyerProfile = res.body.find((a) => a.name === "integ-buyer");
      expect(buyerProfile.rating_avg).toBe(4);
      expect(buyerProfile.rating_count).toBe(1);
    });

    test("agent list does NOT expose api_key_hash or wallet_balance", async () => {
      const res = await simulateRequest("GET", "/agents", { apiKey: buyer.apiKey });
      for (const agent of res.body) {
        expect(agent).not.toHaveProperty("api_key_hash");
        expect(agent).not.toHaveProperty("wallet_balance");
      }
    });

    test("agent list ordered by created_at DESC", async () => {
      const res = await simulateRequest("GET", "/agents", { apiKey: buyer.apiKey });
      const timestamps = res.body.map((a) => a.created_at);
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i] <= timestamps[i - 1]).toBe(true);
      }
    });
  });

  describe("Phase 9: GET /agents/:id (detail with reviews)", () => {
    test("seller detail includes full reviews from phase 8", async () => {
      const res = await simulateRequest("GET", `/agents/${seller.id}`, { apiKey: buyer.apiKey });
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(seller.id);
      expect(res.body.reviews).toBeDefined();
      expect(Array.isArray(res.body.reviews)).toBe(true);
      expect(res.body.reviews.length).toBe(2);

      const ratings = res.body.reviews.map((r) => r.rating);
      expect(ratings).toContain(5);
      expect(ratings).toContain(3);

      for (const review of res.body.reviews) {
        expect(review.reviewer_name).toBeTruthy();
        expect(review.role).toBe("buyer");
      }
    });

    test("buyer detail shows seller's review", async () => {
      const res = await simulateRequest("GET", `/agents/${buyer.id}`, { apiKey: seller.apiKey });
      expect(res.status).toBe(200);
      expect(res.body.reviews.length).toBe(1);
      expect(res.body.reviews[0].rating).toBe(4);
      expect(res.body.reviews[0].role).toBe("seller");
      expect(res.body.reviews[0].reviewer_name).toBe("integ-seller");
    });

    test("observer agent has no reviews", async () => {
      const res = await simulateRequest("GET", `/agents/${thirdParty.id}`, { apiKey: buyer.apiKey });
      expect(res.status).toBe(200);
      expect(res.body.reviews).toEqual([]);
    });

    test("non-existent agent returns 404", async () => {
      const res = await simulateRequest("GET", "/agents/fake-id-12345", { apiKey: buyer.apiKey });
      expect(res.status).toBe(404);
    });

    test("detail does NOT expose wallet_balance or api_key_hash", async () => {
      const res = await simulateRequest("GET", `/agents/${seller.id}`, { apiKey: buyer.apiKey });
      expect(res.body).not.toHaveProperty("api_key_hash");
      expect(res.body).not.toHaveProperty("wallet_balance");
    });

    test("reviews ordered by created_at DESC", async () => {
      const res = await simulateRequest("GET", `/agents/${seller.id}`, { apiKey: buyer.apiKey });
      const timestamps = res.body.reviews.map((r) => r.created_at);
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i] <= timestamps[i - 1]).toBe(true);
      }
    });
  });

  describe("Phase 9: GET /wallet/history", () => {
    test("buyer wallet history includes all transaction types", async () => {
      const res = await simulateRequest("GET", "/wallet/history", { apiKey: buyer.apiKey });
      expect(res.status).toBe(200);
      const types = res.body.map((t) => t.type);

      expect(types).toContain("topup");
      expect(types).toContain("escrow_hold");
      expect(types).toContain("escrow_refund");
      expect(types).toContain("compute_fee");
    });

    test("seller wallet history shows escrow_release and compute_fee", async () => {
      const res = await simulateRequest("GET", "/wallet/history", { apiKey: seller.apiKey });
      expect(res.status).toBe(200);
      const types = res.body.map((t) => t.type);

      expect(types).toContain("escrow_release");
      expect(types).toContain("compute_fee");
    });

    test("wallet history amounts are numbers, not strings", async () => {
      const res = await simulateRequest("GET", "/wallet/history", { apiKey: buyer.apiKey });
      for (const tx of res.body) {
        expect(typeof tx.amount).toBe("number");
      }
    });

    test("wallet history only shows transactions involving the authenticated agent", async () => {
      const res = await simulateRequest("GET", "/wallet/history", { apiKey: thirdParty.apiKey });
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].type).toBe("topup");
    });

    test("wallet transaction math reconciles with actual balance", async () => {
      const res = await simulateRequest("GET", "/wallet/history", { apiKey: buyer.apiKey });
      const actualBalance = getBalance(buyer.id);

      let computed = 0;
      for (const tx of res.body) {
        if (tx.to_agent === buyer.id) computed += tx.amount;
        if (tx.from_agent === buyer.id) computed -= tx.amount;
      }

      expect(computed).toBeCloseTo(actualBalance, 2);
    });

    test("wallet history ordered newest first", async () => {
      const res = await simulateRequest("GET", "/wallet/history", { apiKey: buyer.apiKey });
      const timestamps = res.body.map((t) => t.created_at);
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i] <= timestamps[i - 1]).toBe(true);
      }
    });
  });

  describe("Phase 9: GET /history (task history)", () => {
    test("buyer sees all 3 tasks in history", async () => {
      const res = await simulateRequest("GET", "/history", { apiKey: buyer.apiKey });
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(3);
    });

    test("seller sees all 3 tasks (was seller on all)", async () => {
      const res = await simulateRequest("GET", "/history", { apiKey: seller.apiKey });
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(3);
    });

    test("observer sees zero tasks", async () => {
      const res = await simulateRequest("GET", "/history", { apiKey: thirdParty.apiKey });
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(0);
    });

    test("task statuses reflect correct lifecycle outcomes", async () => {
      const res = await simulateRequest("GET", "/history", { apiKey: buyer.apiKey });
      const statusById = {};
      for (const t of res.body) statusById[t.id] = t.status;

      expect(statusById[task1Id]).toBe("approved");
      expect(statusById[task2Id]).toBe("approved");
      expect(statusById[task3Id]).toBe("disputed");
    });

    test("filter by status=approved returns only approved tasks", async () => {
      const res = await simulateRequest("GET", "/history", {
        apiKey: buyer.apiKey,
        query: { status: "approved" },
      });
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(2);
      for (const t of res.body) {
        expect(t.status).toBe("approved");
      }
    });

    test("filter by status=disputed returns the disputed task", async () => {
      const res = await simulateRequest("GET", "/history", {
        apiKey: buyer.apiKey,
        query: { status: "disputed" },
      });
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].id).toBe(task3Id);
    });

    test("pii_mask is boolean in history response", async () => {
      const res = await simulateRequest("GET", "/history", { apiKey: buyer.apiKey });
      for (const t of res.body) {
        expect(typeof t.pii_mask).toBe("boolean");
      }
    });

    test("task history ordered newest first", async () => {
      const res = await simulateRequest("GET", "/history", { apiKey: buyer.apiKey });
      const timestamps = res.body.map((t) => t.created_at);
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i] <= timestamps[i - 1]).toBe(true);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECURITY & AUTH BOUNDARY TESTS
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Security: auth on read endpoints", () => {
    test("GET /agents without API key returns 401", async () => {
      const res = await simulateRequest("GET", "/agents", {});
      expect(res.status).toBe(401);
    });

    test("GET /agents/:id without API key returns 401", async () => {
      const res = await simulateRequest("GET", `/agents/${seller.id}`, {});
      expect(res.status).toBe(401);
    });

    test("GET /wallet/history without API key returns 401", async () => {
      const res = await simulateRequest("GET", "/wallet/history", {});
      expect(res.status).toBe(401);
    });

    test("GET /history without API key returns 401", async () => {
      const res = await simulateRequest("GET", "/history", {});
      expect(res.status).toBe(401);
    });

    test("invalid API key returns 401 on all read endpoints", async () => {
      const fakeKey = "key-fake-doesnt-exist";
      for (const path of ["/agents", `/agents/${seller.id}`, "/wallet/history", "/history"]) {
        const res = await simulateRequest("GET", path, { apiKey: fakeKey });
        expect(res.status).toBe(401);
      }
    });

    test("suspended agent cannot access read endpoints", async () => {
      db.prepare("UPDATE agents SET status = 'suspended' WHERE id = ?").run(thirdParty.id);

      const res = await simulateRequest("GET", "/agents", { apiKey: thirdParty.apiKey });
      expect(res.status).toBe(403);

      // Restore
      db.prepare("UPDATE agents SET status = 'active' WHERE id = ?").run(thirdParty.id);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DATA CONSISTENCY: Cross-phase integrity
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Data consistency across all phases", () => {
    test("total platform fees collected match 7% of all approved task prices", () => {
      const platformFees = db.prepare(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE type = 'platform_fee'"
      ).get().total;

      const approvedPrices = db.prepare(
        "SELECT COALESCE(SUM(agreed_price), 0) AS total FROM tasks WHERE status = 'approved'"
      ).get().total;

      expect(platformFees).toBeCloseTo(approvedPrices * 0.07, 2);
    });

    test("all escrow holds match budget_max * 1.08 for each task", () => {
      const holds = db.prepare(`
        SELECT t.amount, tk.budget_max
        FROM transactions t
        JOIN tasks tk ON t.task_id = tk.id
        WHERE t.type = 'escrow_hold'
      `).all();

      for (const h of holds) {
        expect(h.amount).toBeCloseTo(h.budget_max * 1.08, 2);
      }
    });

    test("agent list ratings match computed avg from reviews table", async () => {
      const res = await simulateRequest("GET", "/agents", { apiKey: buyer.apiKey });

      for (const agent of res.body) {
        const reviews = db.prepare(
          "SELECT rating FROM reviews WHERE reviewee_id = ?"
        ).all(agent.id);

        if (reviews.length === 0) {
          expect(agent.rating_count).toBe(0);
        } else {
          const expectedAvg = Number(
            (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(2)
          );
          expect(agent.rating_avg).toBeCloseTo(expectedAvg, 2);
          expect(agent.rating_count).toBe(reviews.length);
        }
      }
    });

    test("GET /agents/:id review count matches GET /agents list rating_count", async () => {
      const listRes = await simulateRequest("GET", "/agents", { apiKey: buyer.apiKey });
      const sellerFromList = listRes.body.find((a) => a.id === seller.id);

      const detailRes = await simulateRequest("GET", `/agents/${seller.id}`, { apiKey: buyer.apiKey });

      expect(detailRes.body.reviews.length).toBe(sellerFromList.rating_count);
      expect(detailRes.body.rating_avg).toBe(sellerFromList.rating_avg);
    });

    test("wallet balance = SUM(credits) - SUM(debits) for all agents", () => {
      const agents = db.prepare("SELECT id, wallet_balance FROM agents").all();

      for (const agent of agents) {
        const credits = db.prepare(
          "SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE to_agent = ?"
        ).get(agent.id).total;
        const debits = db.prepare(
          "SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE from_agent = ?"
        ).get(agent.id).total;

        expect(agent.wallet_balance).toBeCloseTo(credits - debits, 2);
      }
    });

    test("no orphaned transactions — every task_id in transactions exists in tasks", () => {
      const orphans = db.prepare(`
        SELECT t.id FROM transactions t
        WHERE t.task_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM tasks tk WHERE tk.id = t.task_id)
      `).all();
      expect(orphans.length).toBe(0);
    });

    test("no orphaned reviews — every task_id in reviews exists in tasks", () => {
      const orphans = db.prepare(`
        SELECT r.id FROM reviews r
        WHERE NOT EXISTS (SELECT 1 FROM tasks tk WHERE tk.id = r.task_id)
      `).all();
      expect(orphans.length).toBe(0);
    });

    test("every approved task has at least escrow_hold + escrow_release + platform_fee transactions", () => {
      const approvedTasks = db.prepare("SELECT id FROM tasks WHERE status = 'approved'").all();

      for (const task of approvedTasks) {
        const txTypes = db.prepare(
          "SELECT DISTINCT type FROM transactions WHERE task_id = ?"
        ).all(task.id).map((t) => t.type);

        expect(txTypes).toContain("escrow_hold");
        expect(txTypes).toContain("escrow_release");
        expect(txTypes).toContain("platform_fee");
      }
    });
  });
});
