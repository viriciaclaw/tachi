const os = require("os");
const path = require("path");
const fs = require("fs");

const TACHI_DIR = process.env.TACHI_HOME || path.join(os.homedir(), ".tachi");
const CONFIG_PATH = path.join(TACHI_DIR, "config.json");
const DB_PATH = path.join(TACHI_DIR, "tachi.db");
const PID_PATH = path.join(TACHI_DIR, "server.pid");

function ensureTachiDir() {
  fs.mkdirSync(TACHI_DIR, { recursive: true });
}

module.exports = {
  TACHI_DIR,
  CONFIG_PATH,
  DB_PATH,
  PID_PATH,
  ensureTachiDir,
};
