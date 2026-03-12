const { openDatabase } = require("./index");
const { ensureConfig } = require("../lib/config");
const { DB_PATH } = require("../lib/paths");

function runMigrations() {
  ensureConfig();
  const db = openDatabase();

  try {
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          api_key_hash TEXT NOT NULL,
          capabilities TEXT,
          rate_min REAL DEFAULT 0,
          rate_max REAL DEFAULT 0,
          description TEXT,
          rating_avg REAL DEFAULT 0,
          rating_count INTEGER DEFAULT 0,
          wallet_balance REAL DEFAULT 0,
          status TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
          created_at TEXT
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          buyer_id TEXT NOT NULL,
          seller_id TEXT,
          capability TEXT NOT NULL,
          description TEXT,
          spec TEXT NOT NULL,
          pii_mask INTEGER DEFAULT 1,
          budget_max REAL NOT NULL,
          agreed_price REAL,
          review_window_ms INTEGER DEFAULT 7200000,
          status TEXT DEFAULT 'open' CHECK (
            status IN (
              'open',
              'matched',
              'in-progress',
              'delivered',
              'approved',
              'rejected',
              'disputed',
              'expired',
              'revision'
            )
          ),
          input_path TEXT,
          output_path TEXT,
          rejection_reason TEXT,
          revision_count INTEGER DEFAULT 0,
          created_at TEXT,
          accepted_at TEXT,
          delivered_at TEXT,
          completed_at TEXT,
          FOREIGN KEY (buyer_id) REFERENCES agents (id),
          FOREIGN KEY (seller_id) REFERENCES agents (id)
        );

        CREATE TABLE IF NOT EXISTS transactions (
          id TEXT PRIMARY KEY,
          task_id TEXT,
          from_agent TEXT,
          to_agent TEXT,
          amount REAL NOT NULL,
          type TEXT NOT NULL CHECK (
            type IN (
              'topup',
              'escrow_hold',
              'escrow_release',
              'escrow_refund',
              'compute_fee',
              'platform_fee'
            )
          ),
          created_at TEXT,
          FOREIGN KEY (task_id) REFERENCES tasks (id),
          FOREIGN KEY (from_agent) REFERENCES agents (id),
          FOREIGN KEY (to_agent) REFERENCES agents (id)
        );

        CREATE TABLE IF NOT EXISTS reviews (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          reviewer_id TEXT NOT NULL,
          reviewee_id TEXT NOT NULL,
          rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
          comment TEXT,
          role TEXT NOT NULL CHECK (role IN ('buyer', 'seller')),
          created_at TEXT,
          FOREIGN KEY (task_id) REFERENCES tasks (id),
          FOREIGN KEY (reviewer_id) REFERENCES agents (id),
          FOREIGN KEY (reviewee_id) REFERENCES agents (id)
        );
      `);
    });

    migrate();
  } catch (error) {
    throw new Error(`Database migration failed: ${error.message}`);
  } finally {
    db.close();
  }

  return DB_PATH;
}

if (require.main === module) {
  try {
    const dbPath = runMigrations();
    console.log(`Migrations completed: ${dbPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  runMigrations,
};
