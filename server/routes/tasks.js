const { v4: uuidv4 } = require("uuid");

const { findBestMatch } = require("../../lib/matching");
const { maskPii } = require("../../lib/pii-masker");
const { scrubEnv } = require("../../lib/env-scrubber");
const { detectInjection } = require("../../lib/injection-guard");

const DEFAULT_REVIEW_WINDOW_MS = 7_200_000;
const NEW_AGENT_TASK_CAP = 10;
const BUYER_SURCHARGE_MULTIPLIER = 1.08;


function parseBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === undefined) {
    return fallback;
  }

  return Boolean(value);
}

function normalizeTask(task) {
  if (!task) {
    return null;
  }

  return {
    ...task,
    pii_mask: Boolean(task.pii_mask),
  };
}

function toPublicTask(task) {
  const normalized = normalizeTask(task);

  if (!normalized) {
    return null;
  }

  const { input_path, output_path, ...publicTask } = normalized;
  return publicTask;
}

function getQueryValue(req, key) {
  if (req.query && req.query[key] !== undefined) {
    return req.query[key];
  }

  try {
    const url = new URL(req.originalUrl || req.url || req.path, "http://localhost");
    return url.searchParams.get(key);
  } catch (_error) {
    return null;
  }
}

function getTaskIdParam(req) {
  if (req.params && req.params.id) {
    return req.params.id;
  }

  const path = req.path || req.url || "";
  const match = path.match(/^\/tasks\/([^/]+)/);
  return match ? match[1] : null;
}

function roundCurrency(amount) {
  return Number(amount.toFixed(2));
}

function createTaskRow(taskId, agentId, body, createdAt) {
  return {
    id: taskId,
    buyer_id: agentId,
    seller_id: null,
    capability: body.capability.trim(),
    description: body.description ?? null,
    spec: body.spec.trim(),
    pii_mask: parseBoolean(body.pii_mask, true) ? 1 : 0,
    budget_max: Number(body.budget_max),
    agreed_price: null,
    review_window_ms: body.review_window_ms === undefined ? DEFAULT_REVIEW_WINDOW_MS : Number(body.review_window_ms),
    status: "open",
    input_path: body.input_path ?? null,
    output_path: null,
    rejection_reason: null,
    revision_count: 0,
    created_at: createdAt,
    accepted_at: null,
    delivered_at: null,
    completed_at: null,
  };
}

function createTasksHandlers(db) {
  const countApprovedBuyerTasks = db.prepare(`
    SELECT COUNT(*) AS completed_count
    FROM tasks
    WHERE buyer_id = ? AND status = 'approved'
  `);

  const findBuyerBalance = db.prepare("SELECT wallet_balance FROM agents WHERE id = ? LIMIT 1");

  const insertTask = db.prepare(`
    INSERT INTO tasks (
      id,
      buyer_id,
      seller_id,
      capability,
      description,
      spec,
      pii_mask,
      budget_max,
      agreed_price,
      review_window_ms,
      status,
      input_path,
      output_path,
      rejection_reason,
      revision_count,
      created_at,
      accepted_at,
      delivered_at,
      completed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertTransaction = db.prepare(`
    INSERT INTO transactions (id, task_id, from_agent, to_agent, amount, type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const createTaskWithEscrow = db.transaction((task, totalHold, createdAt) => {
    db.prepare("UPDATE agents SET wallet_balance = wallet_balance - ? WHERE id = ?").run(totalHold, task.buyer_id);

    insertTask.run(
      task.id,
      task.buyer_id,
      task.seller_id,
      task.capability,
      task.description,
      task.spec,
      task.pii_mask,
      task.budget_max,
      task.agreed_price,
      task.review_window_ms,
      task.status,
      task.input_path,
      task.output_path,
      task.rejection_reason,
      task.revision_count,
      task.created_at,
      task.accepted_at,
      task.delivered_at,
      task.completed_at,
    );

    insertTransaction.run(uuidv4(), task.id, task.buyer_id, null, totalHold, "escrow_hold", createdAt);
  });

  const findTaskById = db.prepare("SELECT * FROM tasks WHERE id = ? LIMIT 1");

  const findTasksStatement = db.prepare(`
    SELECT *
    FROM tasks
    WHERE (@status IS NULL OR status = @status)
      AND (@capability IS NULL OR capability = @capability)
    ORDER BY created_at DESC, id DESC
  `);

  const findAgentForAccept = db.prepare(`
    SELECT id, rate_min, capabilities
    FROM agents
    WHERE id = ?
    LIMIT 1
  `);

  const findExistingReview = db.prepare(
    "SELECT id FROM reviews WHERE task_id = ? AND reviewer_id = ? LIMIT 1"
  );

  const insertReview = db.prepare(`
    INSERT INTO reviews (id, task_id, reviewer_id, reviewee_id, rating, comment, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getAgentRating = db.prepare(
    "SELECT rating_avg, rating_count FROM agents WHERE id = ? LIMIT 1"
  );

  const updateAgentRating = db.prepare(
    "UPDATE agents SET rating_avg = ?, rating_count = ? WHERE id = ?"
  );

  const acceptTask = db.transaction((taskId, sellerId, agreedPrice, acceptedAt) => {
    const task = findTaskById.get(taskId);

    if (!task) {
      return { error: { status: 404, message: "Task not found" } };
    }

    if (!["open", "matched"].includes(task.status)) {
      return { error: { status: 409, message: `Task ${task.id} is already ${task.status}` } };
    }

    db.prepare(`
      UPDATE tasks
      SET seller_id = ?, status = 'in-progress', agreed_price = ?, accepted_at = ?
      WHERE id = ?
    `).run(sellerId, agreedPrice, acceptedAt, taskId);

    return { task: findTaskById.get(taskId) };
  });

  const releaseEscrowForApprovedTask = db.transaction((task, completedAt) => {
    const totalHold = roundCurrency(Number(task.budget_max) * BUYER_SURCHARGE_MULTIPLIER);
    const sellerPayout = roundCurrency(Number(task.agreed_price) * 0.93);
    const platformFee = roundCurrency(Number(task.agreed_price) * 0.07);
    const buyerRefund = roundCurrency(totalHold - Number(task.agreed_price));

    db.prepare("UPDATE agents SET wallet_balance = wallet_balance + ? WHERE id = ?").run(sellerPayout, task.seller_id);
    insertTransaction.run(uuidv4(), task.id, null, task.seller_id, sellerPayout, "escrow_release", completedAt);
    insertTransaction.run(uuidv4(), task.id, null, null, platformFee, "platform_fee", completedAt);

    if (buyerRefund > 0) {
      db.prepare("UPDATE agents SET wallet_balance = wallet_balance + ? WHERE id = ?").run(buyerRefund, task.buyer_id);
      insertTransaction.run(uuidv4(), task.id, null, task.buyer_id, buyerRefund, "escrow_refund", completedAt);
    }

    db.prepare(`
      UPDATE tasks
      SET status = 'approved', completed_at = ?
      WHERE id = ?
    `).run(completedAt, task.id);

    return findTaskById.get(task.id);
  });

  const rejectDeliveredTask = db.transaction((task, reason) => {
    const nextStatus = Number(task.revision_count) < 1 ? "revision" : "disputed";
    const nextRevisionCount = Number(task.revision_count) < 1 ? Number(task.revision_count) + 1 : Number(task.revision_count);

    db.prepare(`
      UPDATE tasks
      SET status = ?, rejection_reason = ?, revision_count = ?
      WHERE id = ?
    `).run(nextStatus, reason, nextRevisionCount, task.id);

    if (nextStatus === "revision") {
      const computeFee = roundCurrency(Number(task.agreed_price) * 0.25);
      const createdAt = new Date().toISOString();

      // Deduct compute fee from buyer's wallet (anti-griefing cost)
      db.prepare("UPDATE agents SET wallet_balance = wallet_balance - ? WHERE id = ?").run(computeFee, task.buyer_id);
      db.prepare("UPDATE agents SET wallet_balance = wallet_balance + ? WHERE id = ?").run(computeFee, task.seller_id);
      insertTransaction.run(uuidv4(), task.id, task.buyer_id, task.seller_id, computeFee, "compute_fee", createdAt);
    }

    return findTaskById.get(task.id);
  });

  const createReviewAndUpdateRating = db.transaction((review) => {
    insertReview.run(
      review.id,
      review.task_id,
      review.reviewer_id,
      review.reviewee_id,
      review.rating,
      review.comment,
      review.role,
      review.created_at,
    );

    const currentRating = getAgentRating.get(review.reviewee_id) || { rating_avg: 0, rating_count: 0 };
    const oldAvg = Number(currentRating.rating_avg || 0);
    const oldCount = Number(currentRating.rating_count || 0);
    const newCount = oldCount + 1;
    const newAvg = Number((((oldAvg * oldCount) + review.rating) / newCount).toFixed(2));

    updateAgentRating.run(newAvg, newCount, review.reviewee_id);

    return { avg: newAvg, count: newCount };
  });

  function postTask(req, res) {
    const body = req.body ?? {};
    const capability = typeof body.capability === "string" ? body.capability.trim() : "";
    const spec = typeof body.spec === "string" ? body.spec.trim() : "";
    const budgetMax = Number(body.budget_max);
    const reviewWindowMs =
      body.review_window_ms === undefined ? DEFAULT_REVIEW_WINDOW_MS : Number(body.review_window_ms);

    if (!capability) {
      return res.status(400).json({ error: "Field 'capability' is required" });
    }

    if (!spec) {
      return res.status(400).json({ error: "Field 'spec' is required" });
    }

    if (!Number.isFinite(budgetMax) || budgetMax <= 0) {
      return res.status(400).json({ error: "Field 'budget_max' must be a positive number" });
    }

    if (!Number.isInteger(reviewWindowMs) || reviewWindowMs <= 0) {
      return res.status(400).json({ error: "Field 'review_window_ms' must be a positive integer" });
    }

    const completedCount = countApprovedBuyerTasks.get(req.agent.id).completed_count;
    if (completedCount < 3 && budgetMax > NEW_AGENT_TASK_CAP) {
      return res.status(400).json({
        error: `New buyers are limited to $${NEW_AGENT_TASK_CAP} budgets until they complete 3 approved tasks`,
      });
    }

    const totalHold = Number((budgetMax * BUYER_SURCHARGE_MULTIPLIER).toFixed(2));
    const buyerBalance = findBuyerBalance.get(req.agent.id)?.wallet_balance ?? 0;

    if (buyerBalance < totalHold) {
      return res.status(402).json({
        error: `Insufficient wallet balance. Need $${totalHold} to cover escrow and fees`,
      });
    }

    const descriptionText = typeof body.description === "string" ? body.description : "";
    const specInjectionResult = detectInjection(spec);
    const descriptionInjectionResult = detectInjection(descriptionText);
    const injectionFlags = [...specInjectionResult.threats, ...descriptionInjectionResult.threats];

    if (parseBoolean(body.pii_mask, true)) {
      const maskedSpec = scrubEnv(maskPii(spec).masked).scrubbed;
      body.spec = maskedSpec;

      if (typeof body.description === "string") {
        body.description = scrubEnv(maskPii(body.description).masked).scrubbed;
      }
    }

    const createdAt = new Date().toISOString();
    const taskId = uuidv4();
    const task = createTaskRow(taskId, req.agent.id, body, createdAt);

    createTaskWithEscrow(task, totalHold, createdAt);

    const matchedAgent = findBestMatch(db, task);
    const savedTask = normalizeTask(findTaskById.get(taskId));

    return res.status(201).json({
      ...savedTask,
      matched_agent_id: matchedAgent ? matchedAgent.id : null,
      ...(injectionFlags.length > 0 ? { injection_flags: injectionFlags } : {}),
    });
  }

  function findTasks(req, res) {
    const status = getQueryValue(req, "status") || "open";
    const capability = getQueryValue(req, "capability");
    const tasks = findTasksStatement
      .all({
        status: status || null,
        capability: capability || null,
      })
      .map(toPublicTask);

    return res.status(200).json(tasks);
  }

  function findMyTasks(req, res) {
    const agentId = req.agent.id;
    const status = getQueryValue(req, "status");
    const tasks = db.prepare(`
      SELECT * FROM tasks
      WHERE (buyer_id = @agentId OR seller_id = @agentId)
        AND (@status IS NULL OR status = @status)
      ORDER BY created_at DESC, id DESC
    `).all({ agentId, status: status || null });

    return res.status(200).json(tasks.map(normalizeTask));
  }

  function acceptTaskHandler(req, res) {
    const taskId = getTaskIdParam(req);

    if (!taskId) {
      return res.status(400).json({ error: "Task id is required" });
    }

    const task = findTaskById.get(taskId);

    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    if (task.buyer_id === req.agent.id) {
      return res.status(403).json({ error: "You cannot accept your own task" });
    }

    if (!["open", "matched"].includes(task.status)) {
      return res.status(409).json({ error: `Task ${task.id} is already ${task.status}` });
    }

    const specialist = findAgentForAccept.get(req.agent.id);
    const capabilities = specialist?.capabilities ? JSON.parse(specialist.capabilities) : [];

    if (!Array.isArray(capabilities) || !capabilities.includes(task.capability)) {
      return res.status(403).json({ error: `You do not have the '${task.capability}' capability required for this task` });
    }

    if (Number(specialist.rate_min) > Number(task.budget_max)) {
      return res.status(400).json({ error: "Your minimum rate exceeds this task's budget" });
    }

    const acceptedAt = new Date().toISOString();
    const result = acceptTask(task.id, req.agent.id, task.budget_max, acceptedAt);

    if (result.error) {
      return res.status(result.error.status).json({ error: result.error.message });
    }

    return res.status(200).json(normalizeTask(result.task));
  }

  function deliverTask(req, res) {
    const taskId = getTaskIdParam(req);
    const outputPath = typeof req.body?.output_path === "string" ? req.body.output_path.trim() : "";

    if (!outputPath) {
      return res.status(400).json({ error: "Field 'output_path' is required" });
    }

    const task = findTaskById.get(taskId);

    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    if (task.seller_id !== req.agent.id) {
      return res.status(403).json({ error: "Only the seller can deliver this task" });
    }

    if (!["in-progress", "revision"].includes(task.status)) {
      return res.status(409).json({ error: `Task ${task.id} is already ${task.status}` });
    }

    const deliveredAt = new Date().toISOString();
    db.prepare(`
      UPDATE tasks
      SET output_path = ?, status = 'delivered', delivered_at = ?
      WHERE id = ?
    `).run(outputPath, deliveredAt, task.id);

    return res.status(200).json(normalizeTask(findTaskById.get(task.id)));
  }

  function approveTask(req, res) {
    const taskId = getTaskIdParam(req);
    const task = findTaskById.get(taskId);

    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    if (task.buyer_id !== req.agent.id) {
      return res.status(403).json({ error: "Only the buyer can approve this task" });
    }

    if (task.status !== "delivered") {
      return res.status(409).json({ error: `Task ${task.id} is already ${task.status}` });
    }

    const completedAt = new Date().toISOString();
    const updatedTask = releaseEscrowForApprovedTask(task, completedAt);
    return res.status(200).json(normalizeTask(updatedTask));
  }

  function rejectTask(req, res) {
    const taskId = getTaskIdParam(req);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    const task = findTaskById.get(taskId);

    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    if (!reason) {
      return res.status(400).json({ error: "Field 'reason' is required" });
    }

    if (task.buyer_id !== req.agent.id) {
      return res.status(403).json({ error: "Only the buyer can reject this task" });
    }

    if (task.status !== "delivered") {
      return res.status(409).json({ error: `Task ${task.id} is already ${task.status}` });
    }

    // Check buyer has enough balance for compute fee on first rejection
    if (Number(task.revision_count) < 1) {
      const computeFee = roundCurrency(Number(task.agreed_price) * 0.25);
      const buyerBalance = findBuyerBalance.get(task.buyer_id)?.wallet_balance ?? 0;
      if (buyerBalance < computeFee) {
        return res.status(402).json({
          error: `Insufficient wallet balance for compute fee. Need $${computeFee} to compensate seller for rejected work`,
        });
      }
    }

    return res.status(200).json(normalizeTask(rejectDeliveredTask(task, reason)));
  }

  function getTaskDetail(req, res) {
    const taskId = getTaskIdParam(req);
    const task = findTaskById.get(taskId);

    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    return res.status(200).json(normalizeTask(task));
  }

  function rateTask(req, res) {
    const taskId = getTaskIdParam(req);
    const rating = req.body?.rating;
    const comment = req.body?.comment === undefined ? null : req.body?.comment;

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "Field 'rating' must be an integer between 1 and 5" });
    }

    if (comment !== null && typeof comment !== "string") {
      return res.status(400).json({ error: "Field 'comment' must be a string" });
    }

    const task = findTaskById.get(taskId);

    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    if (task.status !== "approved") {
      return res.status(409).json({ error: "Task must be approved before rating" });
    }

    const isBuyer = task.buyer_id === req.agent.id;
    const isSeller = task.seller_id === req.agent.id;

    if (!isBuyer && !isSeller) {
      return res.status(403).json({ error: "Only task participants can rate" });
    }

    const existingReview = findExistingReview.get(task.id, req.agent.id);
    if (existingReview) {
      return res.status(409).json({ error: "You have already rated this task" });
    }

    const role = isBuyer ? "buyer" : "seller";
    const revieweeId = isBuyer ? task.seller_id : task.buyer_id;
    const createdAt = new Date().toISOString();
    const review = {
      id: uuidv4(),
      task_id: task.id,
      reviewer_id: req.agent.id,
      reviewee_id: revieweeId,
      rating,
      comment: comment === null ? null : comment,
      role,
      created_at: createdAt,
    };

    const revieweeRating = createReviewAndUpdateRating(review);

    return res.status(201).json({
      ...review,
      reviewee_rating: revieweeRating,
    });
  }

  return {
    postTask,
    findTasks,
    findMyTasks,
    acceptTask: acceptTaskHandler,
    approveTask,
    deliverTask,
    getTaskDetail,
    rejectTask,
    rateTask,
  };
}

module.exports = {
  BUYER_SURCHARGE_MULTIPLIER,
  DEFAULT_REVIEW_WINDOW_MS,
  NEW_AGENT_TASK_CAP,
  createTasksHandlers,
  toPublicTask,
};
