#!/usr/bin/env node

if (process.env.TACHI_FETCH_SHIM_MODULE) {
  require(process.env.TACHI_FETCH_SHIM_MODULE);
}

const { Command } = require("commander");
const chalkModule = require("chalk");
const fs = require("fs");

const pkg = require("../package.json");
const { ensureConfig } = require("../lib/config");
const { PID_PATH } = require("../lib/paths");
const { startServer } = require("../server");
const { registerCommand } = require("./commands/register");
const { acceptTaskCommand, findTasksCommand, postTaskCommand } = require("./commands/tasks");
const { walletBalanceCommand, walletTopupCommand } = require("./commands/wallet");
const chalk = chalkModule.default || chalkModule;

function comingSoon(commandName) {
  return function handleComingSoon() {
    ensureConfig();
    console.log(chalk.yellow(`Coming soon: ${commandName}`));
  };
}

function installCommonCommands(program) {
  program
    .command("register")
    .description("Register an agent profile")
    .requiredOption("--name <name>", "Agent name")
    .requiredOption("--capabilities <caps>", "Comma-separated capabilities")
    .option("--rate-min <min>", "Minimum rate", "0")
    .option("--rate-max <max>", "Maximum rate", "0")
    .option("--description <desc>", "Agent description")
    .action(registerCommand);
  program
    .command("post")
    .description("Post a new task to the marketplace")
    .option("--capability <cap>", "Required specialist capability")
    .option("--spec <spec>", "Acceptance criteria for the task")
    .option("--budget <amount>", "Maximum budget for the task")
    .option("--description <desc>", "Task description")
    .option("--pii-mask", "Mask PII in task artifacts", true)
    .option("--no-pii-mask", "Disable PII masking")
    .option("--review-window <ms>", "Review window in milliseconds")
    .option("--input <path>", "Path to the input artifact")
    .action(postTaskCommand);
  program
    .command("find")
    .description("Browse open tasks")
    .option("--capability <cap>", "Filter by capability")
    .option("--status <status>", "Filter by status", "open")
    .action(findTasksCommand);
  program.command("accept <id>").description("Accept a task").action(acceptTaskCommand);
  program.command("deliver <id>").description("Deliver work for a task").action(comingSoon("deliver"));
  program.command("review <id>").description("Request or submit a revision review").action(comingSoon("review"));
  program.command("approve <id>").description("Approve a delivered task").action(comingSoon("approve"));
  program.command("reject <id>").description("Reject a delivered task").action(comingSoon("reject"));
  program.command("call <capability>").description("Find and hire an agent by capability").action(comingSoon("call"));
  program.command("watch").description("Watch marketplace activity").action(comingSoon("watch"));
  program.command("history").description("Show task history").action(comingSoon("history"));
  program.command("status <id>").description("Show task status").action(comingSoon("status"));
  program.command("agents").description("List agent profiles").action(comingSoon("agents"));
  program.command("agent <id>").description("Show a single agent profile").action(comingSoon("agent"));
  program.command("rate <task-id>").description("Rate an agent after task completion").action(comingSoon("rate"));

  const wallet = program.command("wallet").description("Wallet operations");
  wallet.command("balance").description("Show wallet balance").action(walletBalanceCommand);
  wallet.command("topup <amount>").description("Add funds to the wallet").action(walletTopupCommand);
  wallet.command("history").description("Show wallet transaction history").action(comingSoon("wallet history"));
}

function createProgram() {
  ensureConfig();

  const program = new Command();

  program
    .name("tachi")
    .description("Hire specialist AI agents from the command line.")
    .version(pkg.version);

  const server = program.command("server").description("Manage the local Tachi API server");

  server
    .command("start")
    .description("Start the Tachi server in the foreground")
    .action(() => {
      startServer();
    });

  server
    .command("stop")
    .description("Stop the local Tachi server")
    .action(() => {
      ensureConfig();

      if (!fs.existsSync(PID_PATH)) {
        console.log("No running Tachi server found. Start one with `tachi server start`.");
        return;
      }

      const pid = Number(fs.readFileSync(PID_PATH, "utf8").trim());

      if (!pid) {
        console.log("Unable to determine server PID. Remove ~/.tachi/server.pid and try again.");
        return;
      }

      try {
        process.kill(pid, "SIGTERM");
        console.log(`Sent shutdown signal to Tachi server (PID ${pid}).`);
      } catch (error) {
        console.log(`Failed to stop server: ${error.message}`);
      }
    });

  installCommonCommands(program);

  return program;
}

if (require.main === module) {
  createProgram().parseAsync(process.argv);
}

module.exports = {
  createProgram,
};
