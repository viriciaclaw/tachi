/**
 * Phase 10 Integration Tests
 *
 * Verifies the demo script contract, CLI help completeness, README accuracy,
 * and that the full demo lifecycle (register → topup → post → match → accept →
 * deliver → approve → rate → read) works through the actual Express app.
 *
 * Tests cross-phase integration from the Phase 10 demo perspective:
 *   Phase 1 (scaffold) + Phase 2 (register/wallet) + Phase 3 (post/match/accept)
 *   + Phase 4 (deliver/approve) + Phase 7 (PII) + Phase 8 (rate) + Phase 9 (reads)
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const Database = require("better-sqlite3");

const { createApp } = require("../server");
const { hashApiKey } = require("../lib/hash");

// ─── Shared test infra ──────────────────────────────────────────────────────

let db;
let app;

function createMockRequest(method, requestPath, headers = {}, body) {
  const parsedUrl = new URL(requestPath, "http://localhost");
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
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
    status(code) { this.statusCode = code; return this; },
    json(payload) {
      this.body = payload;
      this.finished = true;
      if (this._resolve) this._resolve();
      return this;
    },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    getHeader(name) { return this.headers[name.toLowerCase()]; },
    removeHeader(name) { delete this.headers[name.toLowerCase()]; },
  };
}

function api(method, urlPath, { body, apiKey, query } = {}) {
  return new Promise((resolve) => {
    const url = query
      ? `${urlPath}?${new URLSearchParams(query).toString()}`
      : urlPath;
    const headers = apiKey ? { "x-api-key": apiKey } : {};
    const req = createMockRequest(method, url, headers, body);
    const res = createMockResponse();
    res._resolve = () => resolve({ status: res.statusCode, body: res.body });
    app.handle(req, res, () => resolve({ status: 404, body: { error: "No route" } }));
  });
}

function registerAgent(name, capabilities, rateMin = 0, rateMax = 0, description = null) {
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

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, api_key_hash TEXT NOT NULL,
      capabilities TEXT, rate_min REAL DEFAULT 0, rate_max REAL DEFAULT 0,
      description TEXT, rating_avg REAL DEFAULT 0, rating_count INTEGER DEFAULT 0,
      wallet_balance REAL DEFAULT 0, status TEXT DEFAULT 'active',
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, buyer_id TEXT NOT NULL, seller_id TEXT,
      capability TEXT NOT NULL, description TEXT, spec TEXT NOT NULL,
      pii_mask INTEGER DEFAULT 1, budget_max REAL NOT NULL, agreed_price REAL,
      review_window_ms INTEGER DEFAULT 7200000,
      status TEXT DEFAULT 'open',
      input_path TEXT, output_path TEXT, rejection_reason TEXT, revision_count INTEGER DEFAULT 0,
      created_at TEXT, accepted_at TEXT, delivered_at TEXT, completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY, task_id TEXT, from_agent TEXT, to_agent TEXT,
      amount REAL NOT NULL, type TEXT NOT NULL, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, reviewer_id TEXT NOT NULL,
      reviewee_id TEXT NOT NULL, rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT, role TEXT NOT NULL CHECK (role IN ('buyer','seller')), created_at TEXT
    );
  `);
  app = createApp(db);
});

afterAll(() => { db.close(); });

// ═══════════════════════════════════════════════════════════════════════════════
// 1. DEMO SCRIPT CONTRACT — full lifecycle that mirrors scripts/demo.sh
// ═══════════════════════════════════════════════════════════════════════════════

describe("Demo lifecycle (mirrors scripts/demo.sh)", () => {
  let alice, bob;
  let taskId;

  beforeAll(() => {
    alice = registerAgent("demo-alice", ["management"], 0, 100);
    bob = registerAgent("demo-bob", ["code-review", "summarization"], 0, 50);
    topup(alice.id, 100);
  });

  test("alice posts $10 code-review task → matched to bob", async () => {
    const res = await api("POST", "/tasks", {
      apiKey: alice.apiKey,
      body: {
        capability: "code-review",
        spec: "Review the authentication module for SQL injection vulnerabilities",
        budget_max: 10,
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("matched");
    expect(res.body.matched_agent_id).toBe(bob.id);
    taskId = res.body.id;
  });

  test("bob accepts → in-progress", async () => {
    const res = await api("POST", `/tasks/${taskId}/accept`, { apiKey: bob.apiKey });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in-progress");
    expect(res.body.seller_id).toBe(bob.id);
  });

  test("bob delivers → delivered", async () => {
    const res = await api("POST", `/tasks/${taskId}/deliver`, {
      apiKey: bob.apiKey,
      body: { output_path: "/tmp/tachi-demo/review-output.md" },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("delivered");
  });

  test("alice approves → escrow math matches demo expectations", async () => {
    const res = await api("POST", `/tasks/${taskId}/approve`, { apiKey: alice.apiKey });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");

    // Demo expects: alice balance = $90 (100 - 10.80 + 0.80), bob = $9.30
    const aliceBal = getBalance(alice.id);
    const bobBal = getBalance(bob.id);
    expect(aliceBal).toBeCloseTo(90, 2);
    expect(bobBal).toBeCloseTo(9.30, 2);
  });

  test("alice rates bob 5/5", async () => {
    const res = await api("POST", `/tasks/${taskId}/rate`, {
      apiKey: alice.apiKey,
      body: { rating: 5, comment: "Thorough findings with actionable remediation steps." },
    });
    expect(res.status).toBe(201);
    expect(res.body.reviewee_id).toBe(bob.id);
    expect(res.body.reviewee_rating.avg).toBe(5);
  });

  test("bob rates alice 4/5", async () => {
    const res = await api("POST", `/tasks/${taskId}/rate`, {
      apiKey: bob.apiKey,
      body: { rating: 4, comment: "Clear task spec and fast approval." },
    });
    expect(res.status).toBe(201);
    expect(res.body.reviewee_id).toBe(alice.id);
    expect(res.body.reviewee_rating.avg).toBe(4);
  });

  // Phase 9 reads — exactly what the demo's "Final State" section does
  test("alice wallet balance via API matches $90", async () => {
    const res = await api("GET", "/wallet/balance", { apiKey: alice.apiKey });
    expect(res.status).toBe(200);
    expect(res.body.balance).toBeCloseTo(90, 2);
  });

  test("bob wallet balance via API matches $9.30", async () => {
    const res = await api("GET", "/wallet/balance", { apiKey: bob.apiKey });
    expect(res.status).toBe(200);
    expect(res.body.balance).toBeCloseTo(9.30, 2);
  });

  test("alice profile shows rating 4/5 with 1 review", async () => {
    const res = await api("GET", `/agents/${alice.id}`, { apiKey: bob.apiKey });
    expect(res.status).toBe(200);
    expect(res.body.rating_avg).toBe(4);
    expect(res.body.rating_count).toBe(1);
    expect(res.body.reviews.length).toBe(1);
    expect(res.body.reviews[0].reviewer_name).toBe("demo-bob");
  });

  test("bob profile shows rating 5/5 with 1 review", async () => {
    const res = await api("GET", `/agents/${bob.id}`, { apiKey: alice.apiKey });
    expect(res.status).toBe(200);
    expect(res.body.rating_avg).toBe(5);
    expect(res.body.rating_count).toBe(1);
    expect(res.body.reviews[0].reviewer_name).toBe("demo-alice");
  });

  test("alice task history shows 1 approved task", async () => {
    const res = await api("GET", "/history", { apiKey: alice.apiKey });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].status).toBe("approved");
    expect(res.body[0].id).toBe(taskId);
  });

  test("bob task history shows same task", async () => {
    const res = await api("GET", "/history", { apiKey: bob.apiKey });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].id).toBe(taskId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. CLI --help COMPLETENESS
// ═══════════════════════════════════════════════════════════════════════════════

describe("CLI --help completeness", () => {
  let helpOutput;

  beforeAll(() => {
    const cliPath = path.join(__dirname, "..", "cli", "index.js");
    helpOutput = execSync(`node ${cliPath} --help`, {
      env: { ...process.env, TACHI_HOME: "/tmp/tachi-help-test-" + Date.now() },
    }).toString();
  });

  const expectedCommands = [
    "register",
    "post",
    "find",
    "accept",
    "deliver",
    "review",
    "approve",
    "reject",
    "call",
    "watch",
    "history",
    "status",
    "agents",
    "agent",
    "rate",
    "wallet",
    "server",
  ];

  test.each(expectedCommands)("--help lists '%s' command", (cmd) => {
    expect(helpOutput).toContain(cmd);
  });

  test("every listed command has a non-empty description", () => {
    // Match lines like "  register [options]           Register a new agent..."
    const commandLines = helpOutput.split("\n").filter((l) => /^\s{2}\w/.test(l));
    for (const line of commandLines) {
      // After the command name+args, there should be descriptive text
      const parts = line.trim().split(/\s{2,}/);
      expect(parts.length).toBeGreaterThanOrEqual(2);
      expect(parts[parts.length - 1].length).toBeGreaterThan(5);
    }
  });

  test("top-level description is not the old generic one", () => {
    expect(helpOutput).not.toContain("Hire specialist AI agents from the command line");
    expect(helpOutput).toContain("marketplace");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. DOCS FILE EXISTENCE & CONTENT CHECKS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Documentation files", () => {
  const docsDir = path.join(__dirname, "..", "docs");
  const scriptsDir = path.join(__dirname, "..", "scripts");

  test("scripts/demo.sh exists and is executable", () => {
    const demoPath = path.join(scriptsDir, "demo.sh");
    expect(fs.existsSync(demoPath)).toBe(true);
    const stats = fs.statSync(demoPath);
    // Check executable bit (owner)
    expect(stats.mode & 0o100).toBeTruthy();
  });

  test("README.md exists and documents all endpoints", () => {
    const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
    const requiredEndpoints = [
      "/health",
      "/agents/register",
      "/agents",
      "/agents/:id",
      "/tasks",
      "/tasks/mine",
      "/tasks/:id",
      "/tasks/:id/accept",
      "/tasks/:id/deliver",
      "/tasks/:id/approve",
      "/tasks/:id/reject",
      "/tasks/:id/rate",
      "/wallet/balance",
      "/wallet/topup",
      "/wallet/history",
      "/history",
    ];
    for (const endpoint of requiredEndpoints) {
      expect(readme).toContain(endpoint);
    }
  });

  test("README.md documents escrow math correctly", () => {
    const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
    expect(readme).toContain("1.08");
    expect(readme).toContain("93%");
    expect(readme).toContain("7%");
    // Check example numbers
    expect(readme).toContain("$10.80");
    expect(readme).toContain("$9.30");
    expect(readme).toContain("$0.70");
    expect(readme).toContain("$0.80");
  });

  test("README.md documents rejection flow", () => {
    const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
    expect(readme).toContain("revision");
    expect(readme).toContain("disputed");
    expect(readme).toContain("25%");
  });

  test("README.md documents PII masking", () => {
    const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
    expect(readme).toContain("PII");
    expect(readme).toContain("--no-pii-mask");
  });

  test("README.md documents rating formula", () => {
    const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
    expect(readme).toContain("rating_avg");
    expect(readme).toContain("rating_count");
  });

  test("docs/AGENT_GUIDE.md exists and covers full lifecycle", () => {
    const guide = fs.readFileSync(path.join(docsDir, "AGENT_GUIDE.md"), "utf8");
    // Must cover all lifecycle steps
    expect(guide).toContain("Register");
    expect(guide).toContain("Accept");
    expect(guide).toContain("Deliver");
    expect(guide).toContain("Approve");
    expect(guide).toContain("rate");
    // Must document error codes
    expect(guide).toContain("400");
    expect(guide).toContain("401");
    expect(guide).toContain("402");
    expect(guide).toContain("403");
    expect(guide).toContain("404");
    expect(guide).toContain("409");
  });

  test("docs/AGENT_GUIDE.md documents security/PII", () => {
    const guide = fs.readFileSync(path.join(docsDir, "AGENT_GUIDE.md"), "utf8");
    expect(guide).toContain("PII");
    expect(guide).toContain("X-API-Key");
  });

  test("docs/QUICKSTART.md exists and references the demo", () => {
    const qs = fs.readFileSync(path.join(docsDir, "QUICKSTART.md"), "utf8");
    expect(qs).toContain("demo.sh");
    expect(qs).toContain("npm install");
    expect(qs).toContain("Alice");
    expect(qs).toContain("Bob");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. DEMO EDGE CASES — verify the demo handles multi-agent isolation correctly
// ═══════════════════════════════════════════════════════════════════════════════

describe("Demo edge cases: multi-agent wallet isolation", () => {
  let buyer, seller, uninvolved;
  let taskId;

  beforeAll(async () => {
    buyer = registerAgent("edge-buyer", ["ops"], 0, 100);
    seller = registerAgent("edge-seller", ["code-review"], 1, 50);
    uninvolved = registerAgent("edge-spectator", ["translation"], 0, 25);
    topup(buyer.id, 200);
    topup(uninvolved.id, 50);

    // Run a complete task cycle
    let res = await api("POST", "/tasks", {
      apiKey: buyer.apiKey,
      body: { capability: "code-review", spec: "Edge test task", budget_max: 8 },
    });
    taskId = res.body.id;

    await api("POST", `/tasks/${taskId}/accept`, { apiKey: seller.apiKey });
    await api("POST", `/tasks/${taskId}/deliver`, {
      apiKey: seller.apiKey,
      body: { output_path: "/tmp/edge.md" },
    });
    await api("POST", `/tasks/${taskId}/approve`, { apiKey: buyer.apiKey });
  });

  test("uninvolved agent wallet unaffected by task between buyer and seller", async () => {
    const res = await api("GET", "/wallet/balance", { apiKey: uninvolved.apiKey });
    expect(res.body.balance).toBe(50);
  });

  test("uninvolved agent sees zero tasks in history", async () => {
    const res = await api("GET", "/history", { apiKey: uninvolved.apiKey });
    expect(res.body.length).toBe(0);
  });

  test("uninvolved agent sees zero wallet transactions (except topup)", async () => {
    const res = await api("GET", "/wallet/history", { apiKey: uninvolved.apiKey });
    expect(res.body.length).toBe(1);
    expect(res.body[0].type).toBe("topup");
  });

  test("buyer and seller both see the task in history", async () => {
    const buyerHistory = await api("GET", "/history", { apiKey: buyer.apiKey });
    const sellerHistory = await api("GET", "/history", { apiKey: seller.apiKey });
    expect(buyerHistory.body.some((t) => t.id === taskId)).toBe(true);
    expect(sellerHistory.body.some((t) => t.id === taskId)).toBe(true);
  });

  test("GET /agents lists all agents including uninvolved", async () => {
    const res = await api("GET", "/agents", { apiKey: uninvolved.apiKey });
    const names = res.body.map((a) => a.name);
    expect(names).toContain("edge-buyer");
    expect(names).toContain("edge-seller");
    expect(names).toContain("edge-spectator");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. README ENDPOINT TABLE vs ACTUAL ROUTES — verify docs match code
// ═══════════════════════════════════════════════════════════════════════════════

describe("README endpoint table matches actual server routes", () => {
  // All documented endpoints should return non-404 when called with valid auth
  const agent = { apiKey: null, id: null };

  beforeAll(() => {
    const registered = registerAgent("readme-check-agent", ["code-review"], 0, 50);
    agent.apiKey = registered.apiKey;
    agent.id = registered.id;
    topup(registered.id, 100);
  });

  test("GET /health returns 200", async () => {
    const res = await api("GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  test("GET /agents returns 200", async () => {
    const res = await api("GET", "/agents", { apiKey: agent.apiKey });
    expect(res.status).toBe(200);
  });

  test("GET /agents/:id returns 200 for existing agent", async () => {
    const res = await api("GET", `/agents/${agent.id}`, { apiKey: agent.apiKey });
    expect(res.status).toBe(200);
  });

  test("GET /tasks returns 200", async () => {
    const res = await api("GET", "/tasks", { apiKey: agent.apiKey });
    expect(res.status).toBe(200);
  });

  test("GET /tasks/mine returns 200", async () => {
    const res = await api("GET", "/tasks/mine", { apiKey: agent.apiKey });
    expect(res.status).toBe(200);
  });

  test("GET /wallet/balance returns 200", async () => {
    const res = await api("GET", "/wallet/balance", { apiKey: agent.apiKey });
    expect(res.status).toBe(200);
    expect(typeof res.body.balance).toBe("number");
  });

  test("GET /wallet/history returns 200", async () => {
    const res = await api("GET", "/wallet/history", { apiKey: agent.apiKey });
    expect(res.status).toBe(200);
  });

  test("GET /history returns 200", async () => {
    const res = await api("GET", "/history", { apiKey: agent.apiKey });
    expect(res.status).toBe(200);
  });

  test("POST /wallet/topup returns 200", async () => {
    const res = await api("POST", "/wallet/topup", {
      apiKey: agent.apiKey,
      body: { amount: 1 },
    });
    expect(res.status).toBe(200);
  });

  test("non-existent route returns 404 with error message", async () => {
    const res = await api("GET", "/nonexistent", { apiKey: agent.apiKey });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });
});
