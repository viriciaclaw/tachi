const fs = require("fs");
const os = require("os");
const path = require("path");

function createTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tachi-config-test-"));
}

function loadConfigModules(homeDir) {
  process.env.TACHI_HOME = homeDir;
  jest.resetModules();

  return {
    paths: require("../lib/paths"),
    config: require("../lib/config"),
    hash: require("../lib/hash"),
  };
}

describe("config and paths", () => {
  let homeDir;

  afterEach(() => {
    delete process.env.TACHI_HOME;
    jest.resetModules();

    if (homeDir) {
      fs.rmSync(homeDir, { recursive: true, force: true });
      homeDir = null;
    }
  });

  test("ensureConfig creates the TACHI_HOME directory if missing", () => {
    homeDir = createTempHome();
    fs.rmSync(homeDir, { recursive: true, force: true });

    const { config } = loadConfigModules(homeDir);
    config.ensureConfig();

    expect(fs.existsSync(homeDir)).toBe(true);
  });

  test("ensureConfig creates config.json with defaults if missing", () => {
    homeDir = createTempHome();
    const { config, paths } = loadConfigModules(homeDir);

    const result = config.ensureConfig();

    expect(result).toEqual(config.DEFAULT_CONFIG);
    expect(JSON.parse(fs.readFileSync(paths.CONFIG_PATH, "utf8"))).toEqual(config.DEFAULT_CONFIG);
  });

  test("ensureConfig merges missing keys into existing config", () => {
    homeDir = createTempHome();
    const { config, paths } = loadConfigModules(homeDir);
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(paths.CONFIG_PATH, JSON.stringify({ api_key: "abc123" }, null, 2));

    const result = config.ensureConfig();

    expect(result).toEqual({
      server_url: "http://localhost:7070",
      api_key: "abc123",
      agent_id: null,
    });
    expect(JSON.parse(fs.readFileSync(paths.CONFIG_PATH, "utf8"))).toEqual(result);
  });

  test("writeConfig writes and returns merged config", () => {
    homeDir = createTempHome();
    const { config, paths } = loadConfigModules(homeDir);

    const result = config.writeConfig({
      api_key: "secret",
      agent_id: "agent-1",
    });

    expect(result).toEqual({
      server_url: "http://localhost:7070",
      api_key: "secret",
      agent_id: "agent-1",
    });
    expect(JSON.parse(fs.readFileSync(paths.CONFIG_PATH, "utf8"))).toEqual(result);
  });

  test("TACHI_HOME env override changes all paths", () => {
    const firstHome = createTempHome();
    const secondHome = createTempHome();

    const first = loadConfigModules(firstHome).paths;
    const second = loadConfigModules(secondHome).paths;

    expect(first.TACHI_DIR).toBe(firstHome);
    expect(first.CONFIG_PATH).toBe(path.join(firstHome, "config.json"));
    expect(first.DB_PATH).toBe(path.join(firstHome, "tachi.db"));
    expect(first.PID_PATH).toBe(path.join(firstHome, "server.pid"));

    expect(second.TACHI_DIR).toBe(secondHome);
    expect(second.CONFIG_PATH).toBe(path.join(secondHome, "config.json"));
    expect(second.DB_PATH).toBe(path.join(secondHome, "tachi.db"));
    expect(second.PID_PATH).toBe(path.join(secondHome, "server.pid"));

    fs.rmSync(firstHome, { recursive: true, force: true });
    fs.rmSync(secondHome, { recursive: true, force: true });
  });

  test("hashApiKey returns consistent SHA-256 hex for the same input", () => {
    homeDir = createTempHome();
    const { hash } = loadConfigModules(homeDir);

    const first = hash.hashApiKey("same-input");
    const second = hash.hashApiKey("same-input");

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  test("hashApiKey returns different hashes for different inputs", () => {
    homeDir = createTempHome();
    const { hash } = loadConfigModules(homeDir);

    expect(hash.hashApiKey("input-one")).not.toBe(hash.hashApiKey("input-two"));
  });
});
