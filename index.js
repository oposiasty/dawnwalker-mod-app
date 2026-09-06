const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { sanitizeField, sanitizePreset, sanitizeAction } = require("./bridge-protocol");
const {
  parseLaunchArgs,
  resolveAutoModsDir,
  resolveGameRootFromModsDir,
  readAppConfig,
  writeAppConfig,
  resolveActiveModsDir,
} = require("./mods-dir-resolver");

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const STEAM_APP_ID = "3751260";

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function isDawnwalkerRunning() {
  try {
    const output = require("child_process").execFileSync(
      "tasklist",
      ["/FI", "IMAGENAME eq Dawnwalker.exe", "/NH"],
      { encoding: "utf8" }
    );
    return output.toLowerCase().includes("dawnwalker.exe");
  } catch {
    return false;
  }
}

function vdfValue(content, key) {
  const match = content?.match(new RegExp(`"${key}"\\s*"([^"]+)"`, "i"));
  return match?.[1] ?? null;
}

function resolveGameRoot(installPath) {
  const candidates = [installPath, path.join(installPath, "Dawnwalker")];
  return candidates.find((candidate) => (
    fs.existsSync(path.join(candidate, "Content", "Paks"))
    || fs.existsSync(path.join(candidate, "Binaries", "Win64"))
  )) || installPath;
}

function steamLibraryPaths() {
  const steamRoots = [
    path.join(process.env.PROGRAMFILES_X86 || "C:\\Program Files (x86)", "Steam"),
    path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Steam"),
    path.join(os.homedir(), "AppData", "Local", "Steam"),
  ];
  const libraries = new Set(steamRoots.filter((steamPath) => fs.existsSync(steamPath)));

  for (const steamPath of steamRoots) {
    const libraryFile = path.join(steamPath, "steamapps", "libraryfolders.vdf");
    const content = readText(libraryFile);
    const pathPattern = /"path"\s*"([^"]+)"/gi;
    for (const match of content?.matchAll(pathPattern) || []) {
      libraries.add(match[1].replace(/\\\\/g, "\\"));
    }
  }

  return [...libraries];
}

function collectModdingFiles(gameRoot) {
  const extensions = new Set([".pak", ".utoc", ".ucas", ".ini", ".uplugin", ".exe", ".dll"]);
  const files = [];

  function visit(directory) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (!entry.isFile() || !extensions.has(extension)) continue;

      try {
        const stats = fs.statSync(absolutePath);
        files.push({
          relativePath: path.relative(gameRoot, absolutePath).split(path.sep).join("/"),
          extension,
          sizeBytes: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        });
      } catch {
        // A file can disappear while the read-only scan is in progress.
      }
    }
  }

  visit(gameRoot);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function inspectUserData() {
  const userRoot = path.join(process.env.LOCALAPPDATA || "", "Dawnwalker");
  const saveRoot = path.join(userRoot, "Saved");
  const configRoot = path.join(saveRoot, "Config", "Windows");
  const saveDirectory = path.join(saveRoot, "SaveGames");
  const saveFiles = fs.existsSync(saveDirectory)
    ? fs.readdirSync(saveDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sav"))
      .map((entry) => {
        const filePath = path.join(saveDirectory, entry.name);
        let sizeBytes = 0;
        let format = "Unknown";
        try {
          sizeBytes = fs.statSync(filePath).size;
          const signature = Buffer.alloc(4);
          const descriptor = fs.openSync(filePath, "r");
          try {
            fs.readSync(descriptor, signature, 0, signature.length, 0);
          } finally {
            fs.closeSync(descriptor);
          }
          if (signature.toString("ascii") === "GVAS") format = "Unreal GVAS";
          if (signature.toString("ascii") === "DSAV") format = "Dawnwalker DSAV";
        } catch {
          format = "Unreadable";
        }
        return { name: entry.name, sizeBytes, format };
      })
    : [];
  const configFiles = fs.existsSync(configRoot)
    ? fs.readdirSync(configRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".ini"))
      .map((entry) => entry.name)
    : [];
  const settingsSave = saveFiles.find((file) => file.name === "RebelSettings.sav");
  const settingsPath = settingsSave ? path.join(saveDirectory, settingsSave.name) : null;
  const settingsProperties = [];
  if (settingsPath) {
    try {
      const settingsText = fs.readFileSync(settingsPath, "latin1");
      const propertyPattern = /(?:Game|Controls|Video|Audio)_[A-Za-z0-9_]+/g;
      for (const match of settingsText.matchAll(propertyPattern)) {
        if (!settingsProperties.includes(match[0])) settingsProperties.push(match[0]);
      }
    } catch {
      // Property names are optional metadata for the read-only scan.
    }
  }
  const settingsCandidates = [
    ["Difficulty", "Game_Difficulty_DifficultyLevel"],
    ["Combat rules", "Game_Difficulty_Combat"],
    ["Time limit", "Game_Difficulty_TimeLimit"],
    ["Inventory during combat", "Game_Difficulty_AllowInventoryConsumptionDuringCombat"],
  ].map(([label, property]) => ({
    label,
    property,
    present: settingsProperties.includes(property),
  }));

  return {
    root: userRoot,
    exists: fs.existsSync(userRoot),
    saveRoot,
    saveFiles,
    configRoot,
    configFiles,
    settingsProperties,
    settingsCandidates,
  };
}

// --- Live mod bridge (UE4SS) & Mods Directory ---
// Cached so apply/status calls don't have to re-run a full install scan every time.
let cachedGameRoot = null;
let modsDir = null;
let customModsDir = null;
let askModsDirOnLaunch = false;

function resolveCachedGameRoot() {
  if (cachedGameRoot && fs.existsSync(cachedGameRoot)) return cachedGameRoot;
  const scan = scanSteamInstall();
  if (scan.installed && scan.gameRoot) {
    cachedGameRoot = scan.gameRoot;
    return cachedGameRoot;
  }
  if (customModsDir) {
    const inferred = resolveGameRootFromModsDir(customModsDir, resolveGameRoot);
    if (inferred) {
      cachedGameRoot = inferred;
      return cachedGameRoot;
    }
  }
  return null;
}

function getActiveModsDir(optionalGameRoot = null) {
  if (customModsDir) {
    modsDir = customModsDir;
    return modsDir;
  }
  const root = optionalGameRoot || (cachedGameRoot && fs.existsSync(cachedGameRoot) ? cachedGameRoot : null);
  if (root) {
    modsDir = resolveActiveModsDir({ customModsDir: null, gameRoot: root });
    return modsDir;
  }
  return modsDir;
}

function setCustomModsDir(targetPath) {
  customModsDir = targetPath ? path.normalize(targetPath) : null;
  modsDir = getActiveModsDir();
  try {
    writeAppConfig(app.getPath("userData"), { modsDir: customModsDir });
  } catch {}
  return modsDir;
}

function promptSelectModsDir(parentWindow = null) {
  if (!dialog || typeof dialog.showOpenDialogSync !== "function") return { ok: false, canceled: true };
  const current = getActiveModsDir();
  const gameRoot = resolveCachedGameRoot();
  const defaultPath = (current && fs.existsSync(current))
    ? current
    : (gameRoot && fs.existsSync(gameRoot))
      ? path.join(gameRoot, "Binaries", "Win64")
      : undefined;

  try {
    const result = dialog.showOpenDialogSync(parentWindow || undefined, {
      title: "Select Dawnwalker UE4SS Mods Folder (e.g. ue4ss\\Mods)",
      defaultPath,
      properties: ["openDirectory", "createDirectory"],
    });

    if (result && result.length > 0) {
      const selected = result[0];
      setCustomModsDir(selected);
      return { ok: true, modsDir: selected };
    }
  } catch (error) {
    console.error("Failed to show open dialog:", error);
  }
  return { ok: false, canceled: true };
}

function inspectRuntimeLoader(gameRoot) {
  const binaryRoot = path.join(gameRoot, "Binaries", "Win64");
  const loaderRoot = fs.existsSync(path.join(binaryRoot, "ue4ss"))
    ? path.join(binaryRoot, "ue4ss")
    : binaryRoot;
  const markerNames = ["UE4SS.dll", "UE4SS-settings.ini", "UE4SS.log"];
  const foundMarkers = markerNames.filter((name) => fs.existsSync(path.join(loaderRoot, name)));
  const currentMods = getActiveModsDir(gameRoot);
  const modDirectories = [
    currentMods,
    path.join(loaderRoot, "Mods"),
    path.join(binaryRoot, "Mods"),
    path.join(gameRoot, "Mods"),
    path.join(gameRoot, "~mods"),
  ].filter((name) => name && fs.existsSync(name));
  const uniqueModDirs = [...new Set(modDirectories)];

  return {
    binaryRoot,
    loaderRoot,
    modsDir: currentMods,
    foundMarkers,
    modDirectories: uniqueModDirs,
    detected: foundMarkers.includes("UE4SS.dll") || Boolean(currentMods && fs.existsSync(currentMods)),
    supported: foundMarkers.includes("UE4SS.dll") || Boolean(currentMods && fs.existsSync(currentMods)),
    status: foundMarkers.includes("UE4SS.log") && readText(path.join(loaderRoot, "UE4SS.log"))?.includes("PS scan successful")
      ? "Runtime loader initialized successfully"
      : foundMarkers.includes("UE4SS.dll")
        ? "Runtime loader detected; game-specific hooks are not configured"
      : uniqueModDirs.length > 0
        ? "Mod directory detected, but no supported runtime loader was found"
        : "No supported runtime loader detected",
  };
}

function findGameplaySymbols(gameRoot) {
  const executablePath = path.join(gameRoot, "Binaries", "Win64", "Dawnwalker.exe");
  const symbols = [
    ["Experience gained event", "OnExperienceGained", "Experience / progression"],
    ["Experience changed event", "OnExperienceChanged", "Experience / progression"],
    ["Experience notification", "PushExperienceNotification", "Experience / progression"],
    ["Skill tree setter", "SetOpenedSkillTree", "Skill tree / abilities"],
    ["Skill tree getter", "GetOpenedSkillTree", "Skill tree / abilities"],
    ["Quest skill rewards", "ReceiveQuestSkillRewards", "Skill tree / abilities"],
    ["Skill unlock property", "bUnlockSkills", "Skill tree / abilities"],
    ["Level XP table", "LevelExperienceRequirementTable", "Experience / progression"],
  ];
  try {
    const executableText = fs.readFileSync(executablePath).toString("ascii");
    return symbols.map(([label, symbol, targetGroup]) => ({ label, symbol, targetGroup, present: executableText.includes(symbol) }));
  } catch {
    return symbols.map(([label, symbol, targetGroup]) => ({ label, symbol, targetGroup, present: false }));
  }
}

function backupUserData() {
  const userRoot = path.join(process.env.LOCALAPPDATA || "", "Dawnwalker");
  const saveRoot = path.join(userRoot, "Saved");
  if (!fs.existsSync(saveRoot)) {
    return { ok: false, error: "Dawnwalker user data was not found" };
  }

  const gameProcess = require("child_process").execFileSync("tasklist", ["/FI", "IMAGENAME eq Dawnwalker.exe", "/NH"], { encoding: "utf8" });
  if (gameProcess.toLowerCase().includes("dawnwalker.exe")) {
    return { ok: false, error: "Close Dawnwalker before creating a backup" };
  }

  const backupRoot = path.join(app.getPath("userData"), "backups", `Dawnwalker-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const copiedFiles = [];
  const directories = [path.join(saveRoot, "SaveGames"), path.join(saveRoot, "Config", "Windows")];
  for (const sourceDirectory of directories) {
    if (!fs.existsSync(sourceDirectory)) continue;
    const relativeDirectory = path.relative(saveRoot, sourceDirectory);
    const destinationDirectory = path.join(backupRoot, relativeDirectory);
    fs.mkdirSync(destinationDirectory, { recursive: true });
    for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const source = path.join(sourceDirectory, entry.name);
      const destination = path.join(destinationDirectory, entry.name);
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      copiedFiles.push(path.relative(backupRoot, destination).split(path.sep).join("/"));
    }
  }

  return { ok: true, backupRoot, copiedFiles };
}

function compareSaves(leftName, rightName) {
  const saveRoot = path.join(process.env.LOCALAPPDATA || "", "Dawnwalker", "Saved", "SaveGames");
  const safeName = (name) => typeof name === "string" && path.basename(name) === name && name.toLowerCase().endsWith(".sav");
  if (!safeName(leftName) || !safeName(rightName)) return { ok: false, error: "Invalid save selection" };

  const leftPath = path.join(saveRoot, leftName);
  const rightPath = path.join(saveRoot, rightName);
  if (!fs.existsSync(leftPath) || !fs.existsSync(rightPath)) return { ok: false, error: "Selected save was not found" };

  const left = fs.readFileSync(leftPath);
  const right = fs.readFileSync(rightPath);
  const limit = Math.min(left.length, right.length);
  const ranges = [];
  let changedBytes = 0;
  let rangeStart = -1;
  for (let offset = 0; offset < limit; offset++) {
    if (left[offset] !== right[offset]) {
      changedBytes += 1;
      if (rangeStart < 0) rangeStart = offset;
    } else if (rangeStart >= 0) {
      ranges.push({ start: rangeStart, end: offset - 1, length: offset - rangeStart });
      rangeStart = -1;
    }
  }
  if (rangeStart >= 0) ranges.push({ start: rangeStart, end: limit - 1, length: limit - rangeStart });

  return {
    ok: true,
    left: { name: leftName, sizeBytes: left.length },
    right: { name: rightName, sizeBytes: right.length },
    changedRanges: ranges.slice(0, 100),
    totalChangedRanges: ranges.length,
    changedBytes,
    trailingBytes: Math.abs(left.length - right.length),
  };
}

function inspectIoStoreToc(gameRoot, tocPath) {
  const header = Buffer.alloc(108);
  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(tocPath, "r");
    fs.readSync(fileDescriptor, header, 0, header.length, 0);
  } catch (error) {
    return {
      relativePath: path.relative(gameRoot, tocPath).split(path.sep).join("/"),
      readable: false,
      error: error.code || "read-failed",
    };
  } finally {
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
  }

  const magic = header.subarray(0, 4).toString("ascii");
  const relativePath = path.relative(gameRoot, tocPath).split(path.sep).join("/");
  if (magic !== "-==-" || header.readUInt32LE(20) < 108) {
    return {
      relativePath,
      readable: false,
      magic,
      error: "unsupported-toc-header",
    };
  }

  return {
    relativePath,
    readable: true,
    magic,
    version: header.readUInt32LE(16),
    headerSize: header.readUInt32LE(20),
    tocEntryCount: header.readUInt32LE(24),
    compressedBlockCount: header.readUInt32LE(28),
    compressedBlockEntrySize: header.readUInt32LE(32),
    compressionMethodCount: header.readUInt32LE(36),
    compressionMethodNameLength: header.readUInt32LE(40),
    compressionBlockSize: header.readUInt32LE(44),
    directoryIndexSize: header.readUInt32LE(48),
    partitionCount: header.readUInt32LE(52),
    containerFlags: header.readUInt8(80),
    encryptionMethod: header.readUInt8(81),
    perfectHashSeedCount: header.readUInt32LE(84),
    partitionSize: Number(header.readBigUInt64LE(88)),
    chunksWithoutPerfectHashCount: header.readUInt32LE(96),
    compressed: (header.readUInt8(80) & 1) !== 0,
    encrypted: (header.readUInt8(80) & 2) !== 0,
    signed: (header.readUInt8(80) & 4) !== 0,
    indexed: (header.readUInt8(80) & 8) !== 0,
    directoryIndex: "Directory index is present; package-path decoding is not enabled",
  };
}

function inspectInstall(installPath, manifestPath = null) {
  const gameRoot = resolveGameRoot(installPath);
  const binaryPath = path.join(gameRoot, "Binaries", "Win64");
  const executableFiles = fs.existsSync(binaryPath)
    ? fs.readdirSync(binaryPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"))
      .map((entry) => path.join("Binaries", "Win64", entry.name))
    : [];
  const paksPath = path.join(gameRoot, "Content", "Paks");
  const pakFiles = fs.existsSync(paksPath)
    ? fs.readdirSync(paksPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
    : [];
  const extensionCount = (extension) => pakFiles.filter((file) => file.toLowerCase().endsWith(extension)).length;
  const savedConfigPath = path.join(gameRoot, "Saved", "Config", "Windows");
  const manifest = manifestPath ? readText(manifestPath) : null;
  const inventory = collectModdingFiles(gameRoot);
  const userData = inspectUserData();
  const runtimeLoader = inspectRuntimeLoader(gameRoot);
  const gameplaySymbols = findGameplaySymbols(gameRoot);
  const tocInspections = fs.existsSync(paksPath)
    ? pakFiles
      .filter((file) => file.toLowerCase().endsWith(".utoc"))
      .map((file) => inspectIoStoreToc(gameRoot, path.join(paksPath, file)))
    : [];
  const inventorySummary = inventory.reduce((summary, file) => {
    summary[file.extension] = (summary[file.extension] || 0) + 1;
    return summary;
  }, {});

  return {
    installed: true,
    appId: STEAM_APP_ID,
    path: installPath,
    gameRoot,
    modsDir: getActiveModsDir(gameRoot),
    gameName: vdfValue(manifest, "name") || path.basename(installPath),
    buildId: vdfValue(manifest, "buildid"),
    gameRunning: isDawnwalkerRunning(),
    executableFiles,
    inventory,
    inventorySummary,
    userData,
    runtimeLoader,
    gameplaySymbols,
    tocInspections,
    signals: {
      unrealPackDirectory: fs.existsSync(paksPath),
      pakFiles: extensionCount(".pak"),
      ioStoreTocFiles: extensionCount(".utoc"),
      ioStoreDataFiles: extensionCount(".ucas"),
      pluginsDirectory: fs.existsSync(path.join(gameRoot, "Plugins")),
      modDirectory: (getActiveModsDir(gameRoot) && fs.existsSync(getActiveModsDir(gameRoot)))
        ? getActiveModsDir(gameRoot)
        : ["Mods", "~mods"].find((directory) => fs.existsSync(path.join(gameRoot, directory))) || null,
      userConfigDirectory: userData.configFiles.length > 0 || fs.existsSync(savedConfigPath),
      easyAntiCheat: fs.existsSync(path.join(installPath, "EasyAntiCheat")),
    },
  };
}

function scanSteamInstall() {
  for (const libraryPath of steamLibraryPaths()) {
    const steamAppsPath = path.join(libraryPath, "steamapps");
    const manifestPath = path.join(steamAppsPath, `appmanifest_${STEAM_APP_ID}.acf`);
    const manifest = readText(manifestPath);
    if (!manifest) continue;

    const installDirectory = vdfValue(manifest, "installdir");
    if (!installDirectory) continue;
    const installPath = path.join(steamAppsPath, "common", installDirectory);
    if (fs.existsSync(installPath)) {
      cachedGameRoot = resolveGameRoot(installPath);
      return inspectInstall(installPath, manifestPath);
    }
  }

  return { installed: false, appId: STEAM_APP_ID, path: null };
}

function getBridgePaths() {
  const gameRoot = resolveCachedGameRoot();
  const currentModsDir = getActiveModsDir(gameRoot);
  if (!currentModsDir) return null;
  const bridgeDir = path.join(currentModsDir, "DawnwalkerModBridge");
  return {
    gameRoot: gameRoot || path.dirname(currentModsDir),
    modsDir: currentModsDir,
    bridgeDir,
    scriptsDir: path.join(bridgeDir, "Scripts"),
    commandFile: path.join(bridgeDir, "command.txt"),
    statusFile: path.join(bridgeDir, "status.txt"),
    mainLuaSource: path.join(__dirname, "runtime-mods", "DawnwalkerModBridge", "Scripts", "main.lua"),
  };
}

function ensureBridgeEnabledInModsTxt(modsDir) {
  const modsTxtPath = path.join(modsDir, "mods.txt");
  const content = readText(modsTxtPath) || "";
  if (/^\s*DawnwalkerModBridge\s*:/m.test(content)) {
    if (/^\s*DawnwalkerModBridge\s*:\s*0/m.test(content)) {
      fs.writeFileSync(modsTxtPath, content.replace(/^\s*DawnwalkerModBridge\s*:\s*0/m, "DawnwalkerModBridge : 1"));
    }
    return;
  }
  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(modsTxtPath, `${content}${separator}DawnwalkerModBridge : 1\n`);
}

function ensureModsJunction(gameRoot, modsDir) {
  if (!gameRoot || !modsDir || !fs.existsSync(modsDir)) return;
  try {
    const win64Dir = path.join(gameRoot, "Binaries", "Win64");
    if (!fs.existsSync(win64Dir)) return;
    const standardModsDir = path.join(win64Dir, "Mods");
    const normalizedMods = path.normalize(modsDir).toLowerCase();
    const normalizedStandard = path.normalize(standardModsDir).toLowerCase();

    // If modsDir is inside a subfolder (e.g. Binaries/Win64/ue4ss/Mods) and standard Binaries/Win64/Mods doesn't exist:
    if (normalizedMods !== normalizedStandard && !fs.existsSync(standardModsDir)) {
      fs.symlinkSync(modsDir, standardModsDir, "junction");
    }
  } catch {
    // Non-fatal if junction already exists or permissions restrict it
  }
}

function deployBridge() {
  const paths = getBridgePaths();
  if (!paths) return { ok: false, error: "Game install was not found" };
  if (!fs.existsSync(paths.modsDir)) {
    return { ok: false, error: "UE4SS Mods directory was not found; install UE4SS before deploying the bridge" };
  }

  try {
    ensureModsJunction(paths.gameRoot, paths.modsDir);
    fs.mkdirSync(paths.scriptsDir, { recursive: true });
    fs.copyFileSync(paths.mainLuaSource, path.join(paths.scriptsDir, "main.lua"));
    ensureBridgeEnabledInModsTxt(paths.modsDir);
    return { ok: true, bridgeDir: paths.bridgeDir };
  } catch (error) {
    return { ok: false, error: error.message || "Failed to deploy the bridge mod" };
  }
}

function isBridgeDeployed() {
  const paths = getBridgePaths();
  if (!paths) return false;
  return fs.existsSync(path.join(paths.scriptsDir, "main.lua"));
}

// Desired game state, always written in full so one apply call never clobbers another's fields.
// Deliberately NOT restored from disk: every app start (and every game launch) begins at the
// game's own defaults, and the user opts into changes via controls/presets.
let bridgeState = {};
// The Lua mod ignores command.txt until it carries the id of the CURRENT game boot (advertised
// in status.txt), so settings from a previous session can never apply during a new load.
let knownBootId = null;
let bootResets = 0;
let lastNonce = 0;

// One-shot request ids only need to differ from whatever the Lua side last handled; time-based
// ids stay unique across app restarts without persisting a counter.
function nextNonce() {
  lastNonce = Math.max(Date.now(), lastNonce + 1);
  return lastNonce;
}

function getBridgeCommandState() {
  return { ...bridgeState, bootId: knownBootId, bootResets };
}

// Every write carries the current boot id (handshake) and a fresh heartbeat; the Lua mod releases
// all settings when the heartbeat stops changing (~20 s) or when it sees appClosed=1, so a closed
// (or crashed) app always hands the game back to its defaults. Written via temp-file + rename so
// the mod never reads a half-written file.
function writeCommandFile(paths, entries) {
  fs.mkdirSync(paths.bridgeDir, { recursive: true });
  const lines = Object.entries(entries)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`);
  const data = `${lines.join("\n")}\n`;
  const tmpFile = `${paths.commandFile}.tmp`;
  try {
    fs.writeFileSync(tmpFile, data);
    fs.renameSync(tmpFile, paths.commandFile);
  } catch {
    fs.writeFileSync(paths.commandFile, data);
  }
}

function writeBridgeCommand(patch) {
  const paths = getBridgePaths();
  if (!paths) return { ok: false, error: "Game install was not found" };
  if (!isBridgeDeployed()) return { ok: false, error: "Bridge mod is not deployed yet" };

  bridgeState = { ...bridgeState, ...patch };

  try {
    writeCommandFile(paths, { bootId: knownBootId, heartbeat: Date.now(), ...bridgeState });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || "Failed to write bridge command" };
  }
}

// Periodic proof-of-life for the Lua mod (see writeCommandFile). Only meaningful once a boot has
// been acknowledged; rewriting the same state with a new heartbeat changes nothing else.
function writeHeartbeat() {
  if (!knownBootId) return;
  const paths = getBridgePaths();
  if (!paths || !isBridgeDeployed()) return;
  try {
    writeCommandFile(paths, { bootId: knownBootId, heartbeat: Date.now(), ...bridgeState });
  } catch {
    // Best effort - the next heartbeat retries.
  }
}

// Back to game defaults: forget every desired setting and hand the Lua mod an empty (but
// acknowledged) command file so it releases anything it's currently holding. `closing` marks the
// file so the mod releases immediately instead of waiting for the heartbeat to time out.
function resetBridgeState(closing = false) {
  bridgeState = {};
  const paths = getBridgePaths();
  if (!paths || !isBridgeDeployed()) return { ok: true };
  try {
    if (!knownBootId) {
      writeCommandFile(paths, {});
    } else if (closing) {
      writeCommandFile(paths, { bootId: knownBootId, appClosed: 1 });
    } else {
      writeCommandFile(paths, { bootId: knownBootId, heartbeat: Date.now() });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || "Failed to reset bridge command" };
  }
}

// Called with every status.txt read: a bootId we haven't acknowledged means the game (re)started,
// so drop back to game defaults and acknowledge the new boot.
function syncBootId(status) {
  const bootId = status.bootId;
  if (!bootId || bootId === knownBootId) return;
  if (knownBootId !== null) bootResets += 1;
  knownBootId = bootId;
  resetBridgeState();
  clearNativeFixCommand();
}

function applyPlayerLevel(level) {
  // Clamped to 99: the game's level/XP requirement tables don't have entries above that,
  // and ForceLevelUpTo() with a higher level reads past the end of the table and crashes the game.
  const numericLevel = Math.max(1, Math.min(99, Math.floor(Number(level))));
  if (!Number.isFinite(numericLevel)) return { ok: false, error: "Invalid level" };
  return writeBridgeCommand({ requestId: nextNonce(), setLevel: numericLevel });
}

// Persistent (re-applied every tick by the Lua mod) command.txt fields and one-shot actions are
// validated by the shared bridge-protocol module (unit-tested, Electron-free).
function applyBridgeField(key, value) {
  const result = sanitizeField(key, value);
  if (!result.ok) return result;
  return writeBridgeCommand({ [result.key]: result.value });
}

// Applies a whole saved preset of persistent fields at once.
function applyBridgePreset(values) {
  const result = sanitizePreset(values);
  if (!result.ok) return result;
  return writeBridgeCommand(result.patch);
}

function applyLevelCap(cap) { return applyBridgeField("levelCap", cap); }
function applyInfiniteHealth(enabled) { return applyBridgeField("infiniteHealth", enabled); }
function applyInfiniteStamina(enabled) { return applyBridgeField("infiniteStamina", enabled); }
function applySpeedMultiplier(mult) { return applyBridgeField("speedMultiplier", mult); }
function applyJumpMultiplier(mult) { return applyBridgeField("jumpMultiplier", mult); }
function applyFovMultiplier(mult) { return applyBridgeField("fovMultiplier", mult); }
function applyGameSpeed(speed) { return applyBridgeField("gameSpeed", speed); }
function applyDamageAmplifier(value) { return applyBridgeField("damageAmplifier", value); }

// One-shot action executed once by the Lua mod (actionId nonce).
function applyBridgeAction(name, arg) {
  const result = sanitizeAction(name, arg);
  if (!result.ok) return result;
  return writeBridgeCommand({ actionId: nextNonce(), action: result.name, actionArg: result.arg });
}

function readBridgeStatus() {
  const paths = getBridgePaths();
  if (!paths) return { ok: false, error: "Game install was not found", deployed: false, gameRunning: isDawnwalkerRunning(), bootResets };
  const deployed = isBridgeDeployed();
  const content = readText(paths.statusFile);
  const gameRunning = isDawnwalkerRunning();
  if (!content) return { ok: false, deployed, gameRunning, bootResets, error: gameRunning ? "No status yet; is the game running with the bridge mod enabled?" : "Game is not running" };

  const status = {};
  for (const line of content.split(/\r?\n/)) {
    const [key, ...rest] = line.split("=");
    if (!key) continue;
    status[key] = rest.join("=");
  }
  // A stale status.txt from a closed game must not be mistaken for a live boot.
  if (gameRunning) syncBootId(status);
  return { ok: status.ok === "1", deployed, gameRunning, bootResets, ...status };
}

// DawnwalkerNativeFix: a native UE4SS C++ mod (native-mods/DawnwalkerNativeFix) that handles item
// granting/removal. Lua's UFunction marshalling turns the FItemHandle GetItemHandle returns into an
// empty table (it has zero reflected properties), so the native mod instead calls
// GetItemHandle/TryAddItem via raw ProcessEvent and memcpy's the struct's raw bytes directly - see
// native-mods/DawnwalkerNativeFix/dllmain.cpp.
// Uses its own command.txt/status.txt under Mods/DawnwalkerNativeFix, separate from the bridge mod.
const nativeFixDllSource = path.join(__dirname, "native-mods", "dist", "DawnwalkerNativeFix.dll");

function getNativeFixPaths() {
  const gameRoot = resolveCachedGameRoot();
  const currentModsDir = getActiveModsDir(gameRoot);
  if (!currentModsDir) return null;
  const modDir = path.join(currentModsDir, "DawnwalkerNativeFix");
  return {
    gameRoot: gameRoot || path.dirname(currentModsDir),
    modsDir: currentModsDir,
    modDir,
    dllFile: path.join(modDir, "dlls", "main.dll"),
    commandFile: path.join(modDir, "command.txt"),
    statusFile: path.join(modDir, "status.txt"),
  };
}

function ensureNativeFixEnabledInModsTxt(modsDir) {
  const modsTxtPath = path.join(modsDir, "mods.txt");
  const content = readText(modsTxtPath) || "";
  if (/^\s*DawnwalkerNativeFix\s*:/m.test(content)) {
    if (/^\s*DawnwalkerNativeFix\s*:\s*0/m.test(content)) {
      fs.writeFileSync(modsTxtPath, content.replace(/^\s*DawnwalkerNativeFix\s*:\s*0/m, "DawnwalkerNativeFix : 1"));
    }
    return;
  }
  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(modsTxtPath, `${content}${separator}DawnwalkerNativeFix : 1\n`);
}

function deployNativeFix() {
  const paths = getNativeFixPaths();
  if (!paths) return { ok: false, error: "Game install was not found" };
  if (!fs.existsSync(paths.modsDir)) {
    return { ok: false, error: "UE4SS Mods directory was not found; install UE4SS before deploying the native fix" };
  }
  if (!fs.existsSync(nativeFixDllSource)) {
    return { ok: false, error: "DawnwalkerNativeFix.dll was not found in the app bundle" };
  }

  try {
    ensureModsJunction(paths.gameRoot, paths.modsDir);
    fs.mkdirSync(path.dirname(paths.dllFile), { recursive: true });
    fs.copyFileSync(nativeFixDllSource, paths.dllFile);
    ensureNativeFixEnabledInModsTxt(paths.modsDir);
    return { ok: true, modDir: paths.modDir };
  } catch (error) {
    return { ok: false, error: error.message || "Failed to deploy the native fix mod" };
  }
}

function isNativeFixDeployed() {
  const paths = getNativeFixPaths();
  if (!paths) return false;
  return fs.existsSync(paths.dllFile);
}

// The native mod re-runs whatever request its command.txt last held on every game launch (its
// dedup id lives in process memory), so the file is removed at app start and on each new game boot.
function clearNativeFixCommand() {
  const paths = getNativeFixPaths();
  if (!paths) return;
  try {
    fs.rmSync(paths.commandFile, { force: true });
  } catch {
    // Best effort - a locked file just means the next boot clears it instead.
  }
}

let nativeFixRequestCounter = 0;

// Mirrors kMaxGrantQuantity in native-mods/DawnwalkerNativeFix/dllmain.cpp.
const MAX_GRANT_QUANTITY = 99;

function applyGiveGearNative(gearId, quantity = 1) {
  const paths = getNativeFixPaths();
  if (!paths) return { ok: false, error: "Game install was not found" };
  if (!isNativeFixDeployed()) return { ok: false, error: "Native fix mod is not deployed yet" };
  if (!gearId || typeof gearId !== "string") return { ok: false, error: "Invalid gear id" };

  const amount = Math.min(MAX_GRANT_QUANTITY, Math.max(1, Math.floor(Number(quantity) || 1)));
  nativeFixRequestCounter += 1;
  try {
    fs.mkdirSync(paths.modDir, { recursive: true });
    fs.writeFileSync(
      paths.commandFile,
      `requestId=${nativeFixRequestCounter}\ngiveGearId=${gearId}\ngiveGearQty=${amount}\n`,
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || "Failed to write native fix command" };
  }
}

function applyRemoveGearNative(gearId) {
  const paths = getNativeFixPaths();
  if (!paths) return { ok: false, error: "Game install was not found" };
  if (!isNativeFixDeployed()) return { ok: false, error: "Native fix mod is not deployed yet" };
  if (!gearId || typeof gearId !== "string") return { ok: false, error: "Invalid gear id" };

  nativeFixRequestCounter += 1;
  try {
    fs.mkdirSync(paths.modDir, { recursive: true });
    fs.writeFileSync(paths.commandFile, `requestId=${nativeFixRequestCounter}\nremoveGearId=${gearId}\n`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || "Failed to write native fix command" };
  }
}

function readNativeFixStatus() {
  const paths = getNativeFixPaths();
  if (!paths) return { ok: false, error: "Game install was not found", deployed: false, gameRunning: isDawnwalkerRunning() };
  const deployed = isNativeFixDeployed();
  const content = readText(paths.statusFile);
  const gameRunning = isDawnwalkerRunning();
  if (!content) return { ok: false, deployed, gameRunning, error: gameRunning ? "No status yet; is the game running with the native fix mod enabled?" : "Game is not running" };

  const status = {};
  for (const line of content.split(/\r?\n/)) {
    const [key, ...rest] = line.split("=");
    if (!key) continue;
    status[key] = rest.join("=");
  }
  return { ok: true, deployed, gameRunning, ...status };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0a0a0a",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    dialog.showErrorBox(
      "Dawnwalker Mod App could not load",
      `The app window could not load (${errorCode}: ${errorDescription}).\n\n${validatedURL}`
    );
  });

  if (devServerUrl) {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(path.join(__dirname, "ui", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  const launchOptions = parseLaunchArgs(process.argv, process.env);
  let configDir = null;
  try {
    configDir = app.getPath("userData");
  } catch {}
  const appConfig = configDir ? readAppConfig(configDir) : {};

  if (launchOptions.cliModsDir) {
    customModsDir = path.normalize(launchOptions.cliModsDir);
  } else if (appConfig.modsDir) {
    customModsDir = path.normalize(appConfig.modsDir);
  }
  askModsDirOnLaunch = Boolean(appConfig.askModsDirOnLaunch);
  modsDir = getActiveModsDir();

  // Option to select mods folder at launch:
  // 1. Force prompt if --select-mods-dir CLI argument was passed
  // 2. Or if user enabled askModsDirOnLaunch preference
  const shouldPrompt = launchOptions.forceSelectModsDir || askModsDirOnLaunch;
  if (shouldPrompt && typeof dialog?.showOpenDialogSync === "function") {
    promptSelectModsDir(null);
  }

  const initialGameRoot = resolveCachedGameRoot();
  if (initialGameRoot && modsDir) {
    ensureModsJunction(initialGameRoot, modsDir);
  }

  // Every app start begins at game defaults: nothing carried over from a previous run.
  resetBridgeState();
  clearNativeFixCommand();

  ipcMain.handle("game:scan", () => {
    const scan = scanSteamInstall();
    cachedGameRoot = scan.installed ? scan.gameRoot : null;
    return scan;
  });
  ipcMain.handle("game:get-mods-dir", () => {
    const gameRoot = resolveCachedGameRoot();
    const active = getActiveModsDir(gameRoot);
    return {
      modsDir: active,
      defaultModsDir: resolveAutoModsDir(gameRoot),
      isCustom: Boolean(customModsDir),
      exists: Boolean(active && fs.existsSync(active)),
      askModsDirOnLaunch: Boolean(askModsDirOnLaunch),
    };
  });
  ipcMain.handle("game:select-mods-dir", async () => {
    if (!dialog || typeof dialog.showOpenDialog !== "function") return { ok: false, error: "Dialog unavailable" };
    const focusedWin = BrowserWindow.getFocusedWindow();
    const current = getActiveModsDir();
    const gameRoot = resolveCachedGameRoot();
    const defaultPath = (current && fs.existsSync(current))
      ? current
      : (gameRoot && fs.existsSync(gameRoot))
        ? path.join(gameRoot, "Binaries", "Win64")
        : undefined;

    const result = await dialog.showOpenDialog(focusedWin || undefined, {
      title: "Select Dawnwalker UE4SS Mods Folder (e.g. ue4ss\\Mods)",
      defaultPath,
      properties: ["openDirectory", "createDirectory"],
    });

    if (!result.canceled && result.filePaths?.length > 0) {
      const selected = result.filePaths[0];
      setCustomModsDir(selected);
      return {
        ok: true,
        modsDir: selected,
        isCustom: true,
        exists: fs.existsSync(selected),
      };
    }
    return { ok: false, canceled: true };
  });
  ipcMain.handle("game:set-mods-dir", (_event, targetPath) => {
    setCustomModsDir(targetPath);
    const active = getActiveModsDir();
    return {
      ok: true,
      modsDir: active,
      isCustom: Boolean(customModsDir),
      exists: Boolean(active && fs.existsSync(active)),
    };
  });
  ipcMain.handle("game:set-ask-mods-dir-on-launch", (_event, enabled) => {
    askModsDirOnLaunch = Boolean(enabled);
    try {
      writeAppConfig(app.getPath("userData"), { askModsDirOnLaunch });
    } catch {}
    return { ok: true, askModsDirOnLaunch };
  });
  ipcMain.handle("game:backup-user-data", () => backupUserData());
  ipcMain.handle("game:compare-saves", (_event, leftName, rightName) => compareSaves(leftName, rightName));
  ipcMain.handle("bridge:deploy", () => deployBridge());
  ipcMain.handle("bridge:status", () => readBridgeStatus());
  ipcMain.handle("bridge:get-command", () => getBridgeCommandState());
  ipcMain.handle("bridge:apply-level", (_event, level) => applyPlayerLevel(level));
  ipcMain.handle("bridge:apply-level-cap", (_event, cap) => applyLevelCap(cap));
  ipcMain.handle("bridge:apply-field", (_event, key, value) => applyBridgeField(key, value));
  ipcMain.handle("bridge:apply-preset", (_event, values) => applyBridgePreset(values));
  ipcMain.handle("bridge:action", (_event, name, arg) => applyBridgeAction(name, arg));
  ipcMain.handle("bridge:reset", () => resetBridgeState());
  ipcMain.handle("nativefix:deploy", () => deployNativeFix());
  ipcMain.handle("nativefix:status", () => readNativeFixStatus());
  ipcMain.handle("nativefix:give-gear", (_event, gearId, quantity) => applyGiveGearNative(gearId, quantity));
  ipcMain.handle("nativefix:remove-gear", (_event, gearId) => applyRemoveGearNative(gearId));
  ipcMain.handle("bridge:apply-infinite-health", (_event, enabled) => applyInfiniteHealth(enabled));
  ipcMain.handle("bridge:apply-infinite-stamina", (_event, enabled) => applyInfiniteStamina(enabled));
  ipcMain.handle("bridge:apply-speed", (_event, mult) => applySpeedMultiplier(mult));
  ipcMain.handle("bridge:apply-jump", (_event, mult) => applyJumpMultiplier(mult));
  ipcMain.handle("bridge:apply-fov", (_event, mult) => applyFovMultiplier(mult));
  ipcMain.handle("bridge:apply-game-speed", (_event, speed) => applyGameSpeed(speed));
  ipcMain.handle("bridge:apply-damage-amplifier", (_event, value) => applyDamageAmplifier(value));
  createWindow();

  const heartbeatTimer = setInterval(writeHeartbeat, 5000);
  app.on("before-quit", () => {
    clearInterval(heartbeatTimer);
    // Closing the app hands the game back to its defaults immediately.
    resetBridgeState(true);
    clearNativeFixCommand();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
