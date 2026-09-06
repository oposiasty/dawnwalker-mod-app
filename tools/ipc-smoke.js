// Harness: loads index.js under plain Node with a stubbed `electron` module, then drives the
// registered IPC handlers exactly like the renderer would. Backs up and restores the live
// command.txt so the user's real settings are untouched. Run: node tools/ipc-smoke.js
const Module = require("module");
const fs = require("fs");
const path = require("path");

const handlers = {};
const electronStub = {
  app: {
    whenReady: () => Promise.resolve(),
    on() {},
    getPath: () => path.join(__dirname, "..", ".tmp-userdata"),
  },
  BrowserWindow: class {
    constructor() { this.webContents = { on() {} }; }
    once() {}
    show() {}
    focus() {}
    loadURL() {}
    loadFile() {}
    static getAllWindows() { return [1]; }
    static getFocusedWindow() { return null; }
  },
  dialog: {
    showErrorBox() {},
    showOpenDialogSync() { return []; },
    showMessageBoxSync() { return 1; },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "electron") return "electron-stub";
  return originalResolve.call(this, request, ...rest);
};
require.cache["electron-stub"] = { id: "electron-stub", filename: "electron-stub", loaded: true, exports: electronStub };

require(path.join(__dirname, "..", "index.js"));

(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  const scan = await handlers["game:scan"]();
  if (!scan.installed) throw new Error("game install not found");
  const modsInfo = handlers["game:get-mods-dir"] ? await handlers["game:get-mods-dir"]() : null;
  const modsDir = modsInfo?.modsDir || scan.modsDir || path.join(scan.gameRoot, "Binaries", "Win64", "ue4ss", "Mods");
  const commandFile = path.join(modsDir, "DawnwalkerModBridge", "command.txt");
  const statusFile = path.join(modsDir, "DawnwalkerModBridge", "status.txt");
  const backup = fs.existsSync(commandFile) ? fs.readFileSync(commandFile, "utf8") : null;
  const statusBackup = fs.existsSync(statusFile) ? fs.readFileSync(statusFile, "utf8") : null;
  const results = [];
  try {
    results.push(["startup command.txt (reset at app start)", fs.existsSync(commandFile) ? fs.readFileSync(commandFile, "utf8") : "(missing)"]);
    results.push(["apply-field before handshake (no bootId line expected)", await handlers["bridge:apply-field"](null, "infiniteBlood", true)]);
    results.push(["command.txt", fs.readFileSync(commandFile, "utf8")]);
    // Simulate the game advertising a boot id; status sync only trusts it while the game runs, so
    // the handshake itself can't be exercised here unless Dawnwalker.exe is up.
    fs.writeFileSync(statusFile, "bridgeLoaded=1\nok=1\nbootId=TEST-BOOT-1\nawaitingHandshake=1\n");
    const status = await handlers["bridge:status"]();
    results.push(["status (bootResets, handshake acknowledged only if game running)", { gameRunning: status.gameRunning, bootId: status.bootId, bootResets: status.bootResets, awaitingHandshake: status.awaitingHandshake }]);
    results.push(["command.txt after status", fs.readFileSync(commandFile, "utf8")]);
    results.push(["apply-field bogus", await handlers["bridge:apply-field"](null, "bogus", 1)]);
    results.push(["apply-field speed=99 (clamps to 5)", await handlers["bridge:apply-field"](null, "speedMultiplier", 99)]);
    results.push(["action grantXP 5", await handlers["bridge:action"](null, "grantXP", 5)]);
    results.push(["action addCoins 0 (rejected)", await handlers["bridge:action"](null, "addCoins", 0)]);
    results.push(["action unknown", await handlers["bridge:action"](null, "formatDisk", null)]);
    results.push(["apply-preset", await handlers["bridge:apply-preset"](null, { infiniteHealth: 1, gameSpeed: "2", requestId: 999, junk: true })]);
    results.push(["get-command", await handlers["bridge:get-command"]()]);
    results.push(["command.txt", fs.readFileSync(commandFile, "utf8")]);
    results.push(["reset", await handlers["bridge:reset"]()]);
    results.push(["command.txt after reset", fs.readFileSync(commandFile, "utf8")]);
    results.push(["get-command after reset", await handlers["bridge:get-command"]()]);
    results.push(["mods-dir info", await handlers["game:get-mods-dir"]()]);
    results.push(["set-ask-mods-dir-on-launch", await handlers["game:set-ask-mods-dir-on-launch"](null, true)]);
  } finally {
    if (backup !== null) fs.writeFileSync(commandFile, backup);
    else fs.rmSync(commandFile, { force: true });
    if (statusBackup !== null && !statusBackup.includes("TEST-BOOT-1")) fs.writeFileSync(statusFile, statusBackup);
    else if (statusBackup === null || statusBackup.includes("TEST-BOOT-1")) fs.rmSync(statusFile, { force: true });
  }
  for (const [label, value] of results) {
    console.log(`== ${label}\n${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  console.log("== command.txt restored:", fs.readFileSync(commandFile, "utf8") === backup);
  // index.js starts a heartbeat interval that would otherwise keep this harness alive forever.
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
