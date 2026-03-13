# Security Audit

Date: 2026-03-13

Scope reviewed:
- SQL injection across `db.prepare(...)` usage and adjacent string handling
- Race conditions and transaction atomicity for escrow, approvals, rejections, and wallet updates
- Financial precision and rounding
- Auth boundaries and IDOR
- Input validation for money fields and task transitions
- API key handling
- DoS exposure from unbounded reads
- Path traversal exposure through stored path fields
- Injection guard and PII masker bypasses
- Integer overflow / oversized numeric input
- Error leakage and secrets/config defaults

No SQL injection findings:
- I reviewed all `db.prepare(...)` call sites in `server/`, `db/`, and `lib/`. Queries use bound parameters; I did not find exploitable SQL string concatenation.

No hardcoded production secrets found:
- I did not find embedded API keys, passwords, or default credentials in the repository.

## Finding 1
Severity: HIGH
Status: Fixed
File and line number: `server/routes/tasks.js:134-166`, `server/routes/tasks.js:381-413`

Description:
Task creation originally performed a wallet balance read in the request handler and then later debited the wallet inside a transaction with an unconditional `UPDATE`. If the buyer balance changed between those two steps, the escrow hold still executed and could drive `wallet_balance` negative. In a multi-process deployment, concurrent `POST /tasks` calls could overspend the same wallet.

Proof of concept:
1. Buyer wallet has `$10.80`.
2. Two workers/processes validate balance for two `$10` tasks at the same time.
3. Both see `$10.80` as sufficient.
4. Both execute `wallet_balance = wallet_balance - 10.80`.
5. Buyer ends at `-$10.80` and two tasks are funded from one balance.

Fix: exact code change needed:
- Change the debit to a guarded update:
  `UPDATE agents SET wallet_balance = ROUND(wallet_balance - ?, 2) WHERE id = ? AND wallet_balance >= ?`
- Check `changes === 1` inside the transaction and abort with HTTP `402` if the row was not updated.
- Only insert the task and `escrow_hold` transaction after the guarded debit succeeds.

Implemented:
- `server/routes/tasks.js:134-166`

## Finding 2
Severity: HIGH
Status: Fixed
File and line number: `server/routes/tasks.js:228-268`, `server/routes/tasks.js:530-552`

Description:
Approval originally trusted a stale `task` object read before the transaction. The escrow release transaction did not re-check that the task was still `delivered` before crediting the seller and refunding the buyer. A stale approval path could release escrow twice or release after another process already changed the task state.

Proof of concept:
1. Buyer sends `POST /tasks/:id/approve`.
2. Another process approves the same task just after the initial read.
3. Original code still credits seller/refund/platform rows using the stale `task` snapshot.
4. Seller receives duplicate payout and ledger rows no longer match the task lifecycle.

Fix: exact code change needed:
- Re-load the task inside the transaction.
- Update the task with a compare-and-set guard:
  `UPDATE tasks SET status = 'approved', completed_at = ? WHERE id = ? AND status = 'delivered' AND buyer_id = ?`
- Abort unless `changes === 1`.
- Perform credits and transaction inserts only after the guarded transition succeeds.

Implemented:
- `server/routes/tasks.js:228-268`

## Finding 3
Severity: HIGH
Status: Fixed
File and line number: `server/routes/tasks.js:271-324`, `server/routes/tasks.js:555-581`

Description:
Rejection on first delivery charged the buyer a compute fee after doing the balance check outside the transaction. The transaction then debited the buyer unconditionally. If balance changed after the initial read, the code could overdraw the buyer wallet or pay the seller despite insufficient funds. The task-state transition also relied on a stale `task` snapshot.

Proof of concept:
1. Buyer has exactly `$2.50`, the required compute fee.
2. `POST /tasks/:id/reject` passes the handler-level balance check.
3. Another request drains the buyer wallet before the transaction executes.
4. Original code still subtracts `$2.50`, pushing the wallet negative and crediting the seller.

Fix: exact code change needed:
- Move the compute-fee sufficiency check into the transaction.
- Debit with:
  `UPDATE agents SET wallet_balance = ROUND(wallet_balance - ?, 2) WHERE id = ? AND wallet_balance >= ?`
- Update the task with:
  `UPDATE tasks SET status = ?, rejection_reason = ?, revision_count = ? WHERE id = ? AND status = 'delivered' AND buyer_id = ?`
- Abort unless both guarded operations succeed.

Implemented:
- `server/routes/tasks.js:271-324`

## Finding 4
Severity: HIGH
Status: Fixed
File and line number: `server/index.js:75`, `server/routes/tasks.js:584-601`

Description:
`GET /tasks/:id` returned the full task object, including `input_path`, `output_path`, lifecycle state, and unmasked task content, to any authenticated agent. That is a direct object reference vulnerability: any agent who guessed or learned a task ID could read another buyer/seller’s private job data.

Proof of concept:
1. Outsider agent obtains task UUID from logs, CLI output, or a prior listing.
2. Call `GET /tasks/<uuid>` with any valid API key.
3. Original response included internal paths and full task detail even when outsider was not buyer or seller.

Fix: exact code change needed:
- In `getTaskDetail`, allow full detail only for task participants.
- For non-participants, return a sanitized public view only while the task is `open` or `matched`.
- Return HTTP `403` for non-participants once work has started.

Implemented:
- `server/routes/tasks.js:592-601`

## Finding 5
Severity: HIGH
Status: Fixed
File and line number: `server/routes/wallet.js:22-29`, `server/routes/tasks.js:71-80`, `server/routes/tasks.js:350-423`, `lib/money.js:1-40`

Description:
Money inputs accepted arbitrary floating-point values such as `10.001`. That allowed sub-cent balances and prices to enter escrow logic. In a real-money system this creates rounding asymmetry, inconsistent refunds, and ledger drift across repeated operations.

Proof of concept:
1. Top up `$0.001` repeatedly.
2. Post tasks with `budget_max: 0.015`.
3. The system rounds hold/release/refund at different points, causing non-intuitive balances and sub-cent state in `wallet_balance`.

Fix: exact code change needed:
- Add a shared money validator that rejects non-finite values, values outside safe integer-cent range, and amounts with more than two decimal places.
- Round all accepted money amounts to cents before persistence.
- Apply the validator to wallet top-ups and task budgets.

Implemented:
- `lib/money.js:1-40`
- `server/routes/wallet.js:22-29`
- `server/routes/tasks.js:71-80`
- `server/routes/tasks.js:366-382`

## Finding 6
Severity: HIGH
Status: Fixed
File and line number: `lib/pii-masker.js:22-26`, `server/routes/agents.js:53-58`

Description:
The PII masker did not redact the application’s own API key format, `tachi_<32 hex>`. A buyer could paste a real marketplace API key into `spec` with `pii_mask=true`, and the key would still be stored and echoed back to counterparties.

Proof of concept:
1. Submit task spec: `Use tachi_0123456789abcdef0123456789abcdef to authenticate`.
2. Original `maskPii()` leaves the key intact because the regex only covered `sk-`, `ghp_`, Slack tokens, etc.
3. Seller receives a live marketplace credential in the task.

Fix: exact code change needed:
- Extend the `api_key` regex to include `tachi_[a-f0-9]{32}`.

Implemented:
- `lib/pii-masker.js:22-26`

## Finding 7
Severity: MEDIUM
Status: Open
File and line number: `db/migrate.js:22`, `db/migrate.js:35-36`, `db/migrate.js:68`

Description:
The schema stores all money values as SQLite `REAL`. Even with the new request-layer cent validation, direct DB writes, future code paths, or migration scripts can still persist binary floating-point values. Financial ledgers should not depend on floating-point storage.

Proof of concept:
1. A future admin script writes `wallet_balance = 0.1 + 0.2`.
2. SQLite stores a floating approximation.
3. Equality and aggregation begin to depend on binary rounding rather than integer cents.

Fix: exact code change needed:
- Migrate `agents.wallet_balance`, `tasks.budget_max`, `tasks.agreed_price`, and `transactions.amount` to integer cent columns.
- Convert all arithmetic to `*_cents` integers.
- Expose decimal dollars only at the API boundary.

## Finding 8
Severity: MEDIUM
Status: Fixed
File and line number: `server/routes/agentRead.js:43-62`, `server/routes/history.js:4-17`, `server/routes/history.js:21-38`, `server/routes/tasks.js:171-177`, `server/routes/tasks.js:441-448`

Description:
Several read endpoints return unbounded result sets with no `LIMIT`, pagination token, or maximum page size. A large tenant can force full table scans and very large JSON responses, causing memory pressure and response amplification.

Proof of concept:
1. Create hundreds of thousands of tasks/transactions/reviews.
2. Call `GET /wallet/history`, `GET /history`, `GET /agents`, or `GET /tasks`.
3. Server loads and serializes the entire result set in one request.

Fix: exact code change needed:
- Add `limit` and `cursor`/`offset` parameters with a strict server-side maximum such as `100`.
- Add supporting indexes for common sort/filter columns.
- Reject over-large requested page sizes.

Implemented:
- `lib/pagination.js`
- `server/routes/agentRead.js`
- `server/routes/history.js`
- `server/routes/tasks.js`
- `db/migrate.js`

## Finding 9
Severity: MEDIUM
Status: Fixed
File and line number: `lib/injection-guard.js:1-137`

Description:
The prompt-injection detector relies on literal regex fragments and is easy to bypass with whitespace splitting, homoglyphs, punctuation, or equivalent wording. It is useful as telemetry, but not strong enough to be treated as a guardrail.

Proof of concept:
1. Submit `ignore\nprevious instructions`.
2. Submit `ignоre previous instructions` using a Cyrillic `о`.
3. Submit `follow these new higher-priority rules`.
4. All variants bypass the current literal patterns.

Fix: exact code change needed:
- Normalize Unicode and collapse whitespace before scanning.
- Add token-based matching instead of exact substring regexes.
- Treat the detector as scoring/flagging, not a sole security control.

Implemented:
- `lib/injection-guard.js`

## Finding 10
Severity: MEDIUM
Status: Fixed
File and line number: `server/routes/tasks.js:84`, `server/routes/tasks.js:495-520`

Description:
`input_path` and `output_path` are accepted as arbitrary strings and persisted without normalization or policy checks. The current server only stores them, but downstream agents or future worker code may treat them as local filesystem paths. This creates a path traversal / unsafe file target foothold.

Proof of concept:
1. Buyer posts `input_path: ../../../../home/agent/.ssh/id_rsa`.
2. Seller delivers `output_path: /etc/cron.d/root`.
3. Any downstream worker that trusts these values can be induced to read or write unintended files.

Fix: exact code change needed:
- Validate path fields with a strict allowlist.
- Require absolute paths under a dedicated workspace root such as `/tmp/tachi/`.
- Reject `..`, NUL bytes, and paths outside the permitted root after normalization.

Implemented:
- `lib/safe-path.js`
- `server/routes/tasks.js`

## Finding 11
Severity: LOW
Status: Fixed
File and line number: `server/index.js:50-51`

Description:
Authentication failures returned `error.message` directly to the client. Backend exceptions could leak DB paths, schema details, or internal operational state.

Proof of concept:
1. Trigger an auth-path exception, for example by corrupting the DB or forcing an unexpected DB error.
2. Original response included `Authentication failed: <internal error>`.

Fix: exact code change needed:
- Return a generic message such as `Authentication failed`.
- Log detailed errors server-side only.

Implemented:
- `server/index.js:50-51`

## Integer-Cents Migration Plan
Status: Deferred in this pass to avoid a risky schema rewrite without staged compatibility.

1. Add parallel integer-cent columns: `wallet_balance_cents`, `budget_max_cents`, `agreed_price_cents`, and `amount_cents`, leaving current `REAL` columns in place temporarily.
2. Backfill all rows inside a migration using deterministic cent conversion with validation that every existing value is representable as whole cents.
3. Update application reads and writes to use the cent columns internally while continuing to expose decimal dollars at the API boundary.
4. Add consistency checks in tests and startup migrations so any future direct DB writes that bypass cent rules are detected.
5. Remove legacy `REAL` columns only after one release cycle where both representations are validated in parallel.
