const Database = require("better-sqlite3");

const { DB_PATH, ensureTachiDir } = require("../lib/paths");

function openDatabase() {
  ensureTachiDir();

  try {
    const db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return db;
  } catch (error) {
    throw new Error(`Failed to open database at ${DB_PATH}: ${error.message}`);
  }
}

module.exports = {
  openDatabase,
};
