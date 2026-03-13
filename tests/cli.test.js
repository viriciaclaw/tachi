const fs = require("fs");
const os = require("os");
const path = require("path");
const CLI_PATH = path.join(__dirname, "..", "cli", "index.js");

function createTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tachi-cli-test-"));
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

async function runCli(args, homeDir) {
  return runCliWithEnv(args, homeDir);
}

async function runCliWithEnv(args, homeDir, extraEnv = {}) {
  const argv = args.length > 0 ? args.split(" ") : [];
  const originalHome = process.env.TACHI_HOME;
  const originalShim = process.env.TACHI_FETCH_SHIM_MODULE;
  const originalServerHome = process.env.TACHI_TEST_SERVER_HOME;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalExitCode = process.exitCode;
  let output = "";

  process.env.TACHI_HOME = homeDir;
  Object.assign(process.env, extraEnv);
  process.exitCode = 0;
  process.stdout.write = (chunk, encoding, callback) => {
    output += String(chunk);
    if (typeof callback === "function") {
      callback();
    }
    return true;
  };
  process.stderr.write = (chunk, encoding, callback) => {
    output += String(chunk);
    if (typeof callback === "function") {
      callback();
    }
    return true;
  };
  console.log = (...parts) => {
    output += `${parts.join(" ")}\n`;
  };
  console.error = (...parts) => {
    output += `${parts.join(" ")}\n`;
  };

  jest.resetModules();

  try {
    let program;
    jest.isolateModules(() => {
      jest.doMock("chalk", () => ({
        __esModule: true,
        default: {
          yellow: (value) => value,
        },
      }));
      ({ createProgram: program } = require(CLI_PATH));
    });
    const cliProgram = program();
    cliProgram.exitOverride();

    try {
      await cliProgram.parseAsync(argv, { from: "user" });
    } catch (error) {
      if (error.code !== "commander.helpDisplayed" && error.code !== "commander.version") {
        throw error;
      }
    }
  } finally {
    if (originalHome === undefined) {
      delete process.env.TACHI_HOME;
    } else {
      process.env.TACHI_HOME = originalHome;
    }
    if (originalShim === undefined) {
      delete process.env.TACHI_FETCH_SHIM_MODULE;
    } else {
      process.env.TACHI_FETCH_SHIM_MODULE = originalShim;
    }
    if (originalServerHome === undefined) {
      delete process.env.TACHI_TEST_SERVER_HOME;
    } else {
      process.env.TACHI_TEST_SERVER_HOME = originalServerHome;
    }
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exitCode = originalExitCode;
  }

  return stripAnsi(output);
}

describe("CLI", () => {
  let homeDir;
  let serverHomeDir;

  afterEach(() => {
    if (serverHomeDir) {
      fs.rmSync(serverHomeDir, { recursive: true, force: true });
      serverHomeDir = null;
    }

    if (homeDir) {
      fs.rmSync(homeDir, { recursive: true, force: true });
      homeDir = null;
    }
  });

  test("--help outputs all command names", async () => {
    homeDir = createTempHome();
    const output = await runCli("--help", homeDir);

    expect(output).toContain("register");
    expect(output).toContain("post");
    expect(output).toContain("find");
    expect(output).toContain("wallet");
    expect(output).toContain("server");
    expect(output).toContain("history");
  });

  test("--version outputs 0.1.0", async () => {
    homeDir = createTempHome();

    expect((await runCli("--version", homeDir)).trim()).toBe("0.1.0");
  });

  test("stub commands output coming soon messages", async () => {
    homeDir = createTempHome();

    expect(await runCli("post", homeDir)).toContain("Coming soon: post");
    expect(await runCli("find", homeDir)).toContain("Coming soon: find");
  });

  test("wallet subcommands exist", async () => {
    homeDir = createTempHome();
    const output = await runCli("wallet --help", homeDir);

    expect(output).toContain("balance");
    expect(output).toContain("topup");
    expect(output).toContain("history");
  });

  test("server subcommand exists with start and stop", async () => {
    homeDir = createTempHome();
    const output = await runCli("server --help", homeDir);

    expect(output).toContain("start");
    expect(output).toContain("stop");
  });

  test("tachi register --name test --capabilities code creates config with api_key", async () => {
    serverHomeDir = createTempHome();
    homeDir = createTempHome();
    const configPath = path.join(homeDir, "config.json");
    const shimPath = path.join(__dirname, "helpers", "cli-fetch-shim.js");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          server_url: "http://tachi.test",
          api_key: null,
          agent_id: null,
        },
        null,
        2,
      ),
    );

    const output = await runCliWithEnv("register --name test --capabilities code", homeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

    expect(output).toContain("Registered as test");
    expect(config.api_key).toMatch(/^tachi_[a-f0-9]{32}$/);
    expect(config.agent_id).toEqual(expect.any(String));
  });

  test("tachi wallet balance shows balance after registration", async () => {
    serverHomeDir = createTempHome();
    homeDir = createTempHome();
    const configPath = path.join(homeDir, "config.json");
    const shimPath = path.join(__dirname, "helpers", "cli-fetch-shim.js");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          server_url: "http://tachi.test",
          api_key: null,
          agent_id: null,
        },
        null,
        2,
      ),
    );

    await runCliWithEnv("register --name wallet-test --capabilities code", homeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });
    await runCliWithEnv("wallet topup 11", homeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });
    const output = await runCliWithEnv("wallet balance", homeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });

    expect(output.trim()).toBe("Balance: $11");
  });

  test("tachi agents lists registered agents", async () => {
    serverHomeDir = createTempHome();
    homeDir = createTempHome();
    const configPath = path.join(homeDir, "config.json");
    const otherHomeDir = createTempHome();
    const otherConfigPath = path.join(otherHomeDir, "config.json");
    const shimPath = path.join(__dirname, "helpers", "cli-fetch-shim.js");

    fs.writeFileSync(configPath, JSON.stringify({ server_url: "http://tachi.test", api_key: null, agent_id: null }, null, 2));
    fs.writeFileSync(otherConfigPath, JSON.stringify({ server_url: "http://tachi.test", api_key: null, agent_id: null }, null, 2));

    await runCliWithEnv("register --name alpha --capabilities code", homeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });
    await runCliWithEnv("register --name beta --capabilities design", otherHomeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });

    const output = await runCliWithEnv("agents", homeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });

    expect(output).toContain("ID | Name | Capabilities | Rating | Status");
    expect(output).toContain("alpha");
    expect(output).toContain("beta");

    fs.rmSync(otherHomeDir, { recursive: true, force: true });
  });

  test("tachi agent <id> shows profile and reviews", async () => {
    serverHomeDir = createTempHome();
    homeDir = createTempHome();
    const buyerConfigPath = path.join(homeDir, "config.json");
    const sellerHomeDir = createTempHome();
    const sellerConfigPath = path.join(sellerHomeDir, "config.json");
    const shimPath = path.join(__dirname, "helpers", "cli-fetch-shim.js");

    fs.writeFileSync(buyerConfigPath, JSON.stringify({ server_url: "http://tachi.test", api_key: null, agent_id: null }, null, 2));
    fs.writeFileSync(sellerConfigPath, JSON.stringify({ server_url: "http://tachi.test", api_key: null, agent_id: null }, null, 2));

    await runCliWithEnv("register --name buyer --capabilities code", homeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });
    await runCliWithEnv("register --name seller --capabilities code", sellerHomeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });

    const sellerConfig = JSON.parse(fs.readFileSync(sellerConfigPath, "utf8"));

    await runCliWithEnv("wallet topup 100", homeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });
    await runCliWithEnv("post --capability code --spec ship --budget 10", homeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });
    const taskId = global.__tachiTestDb.prepare("SELECT id FROM tasks ORDER BY created_at DESC, id DESC LIMIT 1").get().id;
    await runCliWithEnv(`accept ${taskId}`, sellerHomeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });
    await runCliWithEnv(`deliver ${taskId} --output /tmp/out.txt`, sellerHomeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });
    await runCliWithEnv(`approve ${taskId}`, homeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });
    await runCliWithEnv(`rate ${taskId} --rating 5 --comment Excellent`, homeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });

    const output = await runCliWithEnv(`agent ${sellerConfig.agent_id}`, homeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });

    expect(output).toContain(`ID: ${sellerConfig.agent_id}`);
    expect(output).toContain("Name: seller");
    expect(output).toContain("Excellent");
    expect(output).toContain("by buyer");

    fs.rmSync(sellerHomeDir, { recursive: true, force: true });
  });

  test("tachi wallet history shows transactions", async () => {
    serverHomeDir = createTempHome();
    homeDir = createTempHome();
    const configPath = path.join(homeDir, "config.json");
    const shimPath = path.join(__dirname, "helpers", "cli-fetch-shim.js");

    fs.writeFileSync(configPath, JSON.stringify({ server_url: "http://tachi.test", api_key: null, agent_id: null }, null, 2));

    await runCliWithEnv("register --name wallet-user --capabilities code", homeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });
    await runCliWithEnv("wallet topup 11", homeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });

    const output = await runCliWithEnv("wallet history", homeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });

    expect(output).toContain("ID | Type | Amount | Task | From | To");
    expect(output).toContain("topup");
    expect(output).toContain("$11");
  });

  test("tachi history shows task history", async () => {
    serverHomeDir = createTempHome();
    homeDir = createTempHome();
    const buyerConfigPath = path.join(homeDir, "config.json");
    const sellerHomeDir = createTempHome();
    const sellerConfigPath = path.join(sellerHomeDir, "config.json");
    const shimPath = path.join(__dirname, "helpers", "cli-fetch-shim.js");

    fs.writeFileSync(buyerConfigPath, JSON.stringify({ server_url: "http://tachi.test", api_key: null, agent_id: null }, null, 2));
    fs.writeFileSync(sellerConfigPath, JSON.stringify({ server_url: "http://tachi.test", api_key: null, agent_id: null }, null, 2));

    await runCliWithEnv("register --name buyer --capabilities code", homeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });
    await runCliWithEnv("register --name seller --capabilities code", sellerHomeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });
    await runCliWithEnv("wallet topup 100", homeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });
    await runCliWithEnv("post --capability code --spec ship --budget 10", homeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });
    const taskId = global.__tachiTestDb.prepare("SELECT id FROM tasks ORDER BY created_at DESC, id DESC LIMIT 1").get().id;
    await runCliWithEnv(`accept ${taskId}`, sellerHomeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });

    const output = await runCliWithEnv("history", homeDir, {
      TACHI_FETCH_SHIM_MODULE: shimPath,
      TACHI_TEST_SERVER_HOME: serverHomeDir,
    });

    expect(output).toContain("ID | Capability | Status | Buyer | Seller");
    expect(output).toContain(taskId);
    expect(output).toContain("in-progress");

    fs.rmSync(sellerHomeDir, { recursive: true, force: true });
  });
});
