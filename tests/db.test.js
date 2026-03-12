const fs = require("fs");
const os = require("os");
const path = require("path");

function createTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tachi-db-test-"));
}

function loadDbModules(homeDir) {
  process.env.TACHI_HOME = homeDir;
  jest.resetModules();

  return {
    paths: require("../lib/paths"),
    migrate: require("../db/migrate"),
    dbModule: require("../db"),
  };
}

function getCreateTableSql(db, tableName) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);

  return row ? row.sql : "";
}

describe("database and schema", () => {
  let homeDir;
  let db;

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }

    delete process.env.TACHI_HOME;
    jest.resetModules();

    if (homeDir) {
      fs.rmSync(homeDir, { recursive: true, force: true });
      homeDir = null;
    }
  });

  function setupDatabase() {
    homeDir = createTempHome();
    const { migrate, dbModule } = loadDbModules(homeDir);
    migrate.runMigrations();
    db = dbModule.openDatabase();
    return db;
  }

  test("migration creates all 4 tables", () => {
    const database = setupDatabase();
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);

    expect(tables).toEqual(expect.arrayContaining(["agents", "tasks", "transactions", "reviews"]));
  });

  test("agents table has correct columns and types", () => {
    const database = setupDatabase();
    const columns = database.prepare("PRAGMA table_info(agents)").all();

    expect(columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "id", type: "TEXT", pk: 1 }),
        expect.objectContaining({ name: "name", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "api_key_hash", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "capabilities", type: "TEXT" }),
        expect.objectContaining({ name: "rate_min", type: "REAL" }),
        expect.objectContaining({ name: "rate_max", type: "REAL" }),
        expect.objectContaining({ name: "description", type: "TEXT" }),
        expect.objectContaining({ name: "rating_avg", type: "REAL" }),
        expect.objectContaining({ name: "rating_count", type: "INTEGER" }),
        expect.objectContaining({ name: "wallet_balance", type: "REAL" }),
        expect.objectContaining({ name: "status", type: "TEXT" }),
        expect.objectContaining({ name: "created_at", type: "TEXT" }),
      ]),
    );
  });

  test("tasks table has correct columns, foreign keys, and status CHECK constraint", () => {
    const database = setupDatabase();
    const columns = database.prepare("PRAGMA table_info(tasks)").all();
    const foreignKeys = database.prepare("PRAGMA foreign_key_list(tasks)").all();
    const schemaSql = getCreateTableSql(database, "tasks");

    expect(columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "id", type: "TEXT", pk: 1 }),
        expect.objectContaining({ name: "buyer_id", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "seller_id", type: "TEXT" }),
        expect.objectContaining({ name: "capability", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "description", type: "TEXT" }),
        expect.objectContaining({ name: "spec", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "pii_mask", type: "INTEGER" }),
        expect.objectContaining({ name: "budget_max", type: "REAL", notnull: 1 }),
        expect.objectContaining({ name: "agreed_price", type: "REAL" }),
        expect.objectContaining({ name: "review_window_ms", type: "INTEGER" }),
        expect.objectContaining({ name: "status", type: "TEXT" }),
        expect.objectContaining({ name: "input_path", type: "TEXT" }),
        expect.objectContaining({ name: "output_path", type: "TEXT" }),
        expect.objectContaining({ name: "rejection_reason", type: "TEXT" }),
        expect.objectContaining({ name: "revision_count", type: "INTEGER" }),
        expect.objectContaining({ name: "created_at", type: "TEXT" }),
        expect.objectContaining({ name: "accepted_at", type: "TEXT" }),
        expect.objectContaining({ name: "delivered_at", type: "TEXT" }),
        expect.objectContaining({ name: "completed_at", type: "TEXT" }),
      ]),
    );

    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "buyer_id", table: "agents", to: "id" }),
        expect.objectContaining({ from: "seller_id", table: "agents", to: "id" }),
      ]),
    );
    expect(schemaSql).toContain("CHECK");
    expect(schemaSql).toContain("'open'");
    expect(schemaSql).toContain("'revision'");
  });

  test("transactions table has correct columns and type CHECK constraint", () => {
    const database = setupDatabase();
    const columns = database.prepare("PRAGMA table_info(transactions)").all();
    const schemaSql = getCreateTableSql(database, "transactions");

    expect(columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "id", type: "TEXT", pk: 1 }),
        expect.objectContaining({ name: "task_id", type: "TEXT" }),
        expect.objectContaining({ name: "from_agent", type: "TEXT" }),
        expect.objectContaining({ name: "to_agent", type: "TEXT" }),
        expect.objectContaining({ name: "amount", type: "REAL", notnull: 1 }),
        expect.objectContaining({ name: "type", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "created_at", type: "TEXT" }),
      ]),
    );
    expect(schemaSql).toContain("'topup'");
    expect(schemaSql).toContain("'platform_fee'");
  });

  test("reviews table has correct columns and rating CHECK constraint (1-5)", () => {
    const database = setupDatabase();
    const columns = database.prepare("PRAGMA table_info(reviews)").all();
    const schemaSql = getCreateTableSql(database, "reviews");

    expect(columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "id", type: "TEXT", pk: 1 }),
        expect.objectContaining({ name: "task_id", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "reviewer_id", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "reviewee_id", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "rating", type: "INTEGER", notnull: 1 }),
        expect.objectContaining({ name: "comment", type: "TEXT" }),
        expect.objectContaining({ name: "role", type: "TEXT", notnull: 1 }),
        expect.objectContaining({ name: "created_at", type: "TEXT" }),
      ]),
    );
    expect(schemaSql).toContain("rating BETWEEN 1 AND 5");
  });

  test("WAL journal mode is enabled", () => {
    const database = setupDatabase();

    const result = database.pragma("journal_mode", { simple: true });

    expect(String(result).toLowerCase()).toBe("wal");
  });

  test("foreign keys are enforced", () => {
    const database = setupDatabase();

    expect(() =>
      database
        .prepare(
          `
            INSERT INTO tasks (id, buyer_id, capability, spec, budget_max)
            VALUES (?, ?, ?, ?, ?)
          `,
        )
        .run("task-1", "missing-agent", "testing", "spec", 10),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  test("agents.name UNIQUE constraint works", () => {
    const database = setupDatabase();
    const insert = database.prepare(
      "INSERT INTO agents (id, name, api_key_hash, created_at) VALUES (?, ?, ?, ?)",
    );

    insert.run("agent-1", "alpha", "hash-1", "2026-03-12T00:00:00.000Z");

    expect(() =>
      insert.run("agent-2", "alpha", "hash-2", "2026-03-12T00:00:00.000Z"),
    ).toThrow(/UNIQUE constraint failed: agents.name/);
  });

  test("reviews.rating CHECK rejects values outside 1-5", () => {
    const database = setupDatabase();
    database
      .prepare("INSERT INTO agents (id, name, api_key_hash) VALUES (?, ?, ?)")
      .run("buyer-1", "buyer", "buyer-hash");
    database
      .prepare("INSERT INTO agents (id, name, api_key_hash) VALUES (?, ?, ?)")
      .run("seller-1", "seller", "seller-hash");
    database
      .prepare(
        "INSERT INTO tasks (id, buyer_id, seller_id, capability, spec, budget_max) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("task-1", "buyer-1", "seller-1", "testing", "spec", 25);

    expect(() =>
      database
        .prepare(
          `
            INSERT INTO reviews (id, task_id, reviewer_id, reviewee_id, rating, role)
            VALUES (?, ?, ?, ?, ?, ?)
          `,
        )
        .run("review-1", "task-1", "buyer-1", "seller-1", 6, "buyer"),
    ).toThrow(/CHECK constraint failed/);
  });

  test("tasks.status CHECK rejects invalid status values", () => {
    const database = setupDatabase();
    database
      .prepare("INSERT INTO agents (id, name, api_key_hash) VALUES (?, ?, ?)")
      .run("buyer-1", "buyer", "buyer-hash");

    expect(() =>
      database
        .prepare(
          `
            INSERT INTO tasks (id, buyer_id, capability, spec, budget_max, status)
            VALUES (?, ?, ?, ?, ?, ?)
          `,
        )
        .run("task-1", "buyer-1", "testing", "spec", 12, "broken"),
    ).toThrow(/CHECK constraint failed/);
  });
});
