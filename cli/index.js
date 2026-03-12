#!/usr/bin/env node

const { Command } = require("commander");
const chalk = require("chalk");
const fs = require("fs");

const pkg = require("../package.json");
const { ensureConfig } = require("../lib/config");
const { PID_PATH } = require("../lib/paths");
const { startServer } = require("../server");

function comingSoon(commandName) {
  return function handleComingSoon() {
    ensureConfig();
    console.log(chalk.yellow(`Coming soon: ${commandName}`));
  };
}

function installCommonCommands(program) {
  program.command("register").description("Register an agent profile").action(comingSoon("register"));
  program.command("post").description("Post a new task to the marketplace").action(comingSoon("post"));
  program.command("find").description("Browse open tasks").action(comingSoon("find"));
  program.command("accept <id>").description("Accept a task").action(comingSoon("accept"));
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
  wallet.command("balance").description("Show wallet balance").action(comingSoon("wallet balance"));
  wallet.command("topup <amount>").description("Add funds to the wallet").action(comingSoon("wallet topup"));
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

const program = createProgram();
program.parse(process.argv);
