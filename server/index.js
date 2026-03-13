const express = require("express");
const fs = require("fs");

const pkg = require("../package.json");
const { runMigrations } = require("../db/migrate");
const { openDatabase } = require("../db");
const { ensureConfig } = require("../lib/config");
const { hashApiKey } = require("../lib/hash");
const { notImplemented } = require("../lib/notImplemented");
const { PID_PATH, ensureTachiDir } = require("../lib/paths");
const { createRegisterAgentHandler } = require("./routes/agents");
const { createTasksHandlers } = require("./routes/tasks");
const { createWalletBalanceHandler, createWalletTopupHandler } = require("./routes/wallet");

function createAuthMiddleware(db) {
  return function authMiddleware(req, res, next) {
    if (req.path === "/health" || req.path === "/agents/register") {
      return next();
    }

    const apiKey = req.header("X-API-Key");

    if (!apiKey) {
      return res.status(401).json({ error: "Missing X-API-Key header" });
    }

    try {
      const agent = db
        .prepare(
          `
            SELECT id, name, status
            FROM agents
            WHERE api_key_hash = ?
            LIMIT 1
          `,
        )
        .get(hashApiKey(apiKey));

      if (!agent) {
        return res.status(401).json({ error: "Invalid API key" });
      }

      if (agent.status !== "active") {
        return res.status(403).json({ error: "Agent account is not active" });
      }

      req.agent = agent;
      return next();
    } catch (error) {
      return res.status(500).json({ error: `Authentication failed: ${error.message}` });
    }
  };
}

function createApp(db) {
  const app = express();
  const tasksHandlers = createTasksHandlers(db);

  app.use(express.json());
  app.use(createAuthMiddleware(db));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: pkg.version });
  });

  app.post("/agents/register", createRegisterAgentHandler(db));
  app.get("/agents", notImplemented("GET /agents"));
  app.get("/agents/:id", notImplemented("GET /agents/:id"));
  app.post("/tasks", tasksHandlers.postTask);
  app.get("/tasks", tasksHandlers.findTasks);
  app.get("/tasks/mine", tasksHandlers.findMyTasks);
  app.post("/tasks/:id/accept", tasksHandlers.acceptTask);
  app.post("/tasks/:id/deliver", tasksHandlers.deliverTask);
  app.get("/tasks/:id", tasksHandlers.getTaskDetail);
  app.post("/tasks/:id/approve", tasksHandlers.approveTask);
  app.post("/tasks/:id/reject", tasksHandlers.rejectTask);
  app.post("/tasks/:id/rate", tasksHandlers.rateTask);
  app.get("/wallet/balance", createWalletBalanceHandler(db));
  app.post("/wallet/topup", createWalletTopupHandler(db));
  app.get("/wallet/history", notImplemented("GET /wallet/history"));
  app.get("/history", notImplemented("GET /history"));

  app.use((req, res) => {
    res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
  });

  return app;
}

function writePidFile() {
  ensureTachiDir();
  fs.writeFileSync(PID_PATH, String(process.pid));
}

function removePidFile() {
  if (fs.existsSync(PID_PATH)) {
    fs.unlinkSync(PID_PATH);
  }
}

function startServer(port = Number(process.env.TACHI_PORT) || 7070) {
  ensureConfig();
  runMigrations();

  const db = openDatabase();
  const app = createApp(db);
  const server = app.listen(port, () => {
    writePidFile();
    console.log(`Tachi server running on http://localhost:${port}`);
  });

  const shutdown = () => {
    removePidFile();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.on("error", (error) => {
    removePidFile();
    db.close();
    console.error(`Server failed to start: ${error.message}`);
    process.exitCode = 1;
  });

  return { app, server, db };
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  createAuthMiddleware,
  startServer,
};
