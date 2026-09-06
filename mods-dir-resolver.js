const fs = require("fs");
const path = require("path");

function parseLaunchArgs(argv = process.argv, env = process.env) {
  const args = Array.isArray(argv) ? argv.slice(1) : [];
  let cliModsDir = null;
  let forceSelectModsDir = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== "string") continue;

    if (arg === "--select-mods-dir" || arg === "--choose-mods-dir" || arg === "-select-mods") {
      forceSelectModsDir = true;
    } else if (arg.startsWith("--mods-dir=")) {
      cliModsDir = arg.slice("--mods-dir=".length).replace(/^["']|["']$/g, "").trim();
    } else if ((arg === "--mods-dir" || arg === "-m") && i + 1 < args.length) {
      cliModsDir = String(args[i + 1]).replace(/^["']|["']$/g, "").trim();
      i++;
    }
  }

  if (!cliModsDir && env?.DAWNWALKER_MODS_DIR) {
    cliModsDir = String(env.DAWNWALKER_MODS_DIR).replace(/^["']|["']$/g, "").trim();
  }

  return { cliModsDir: cliModsDir || null, forceSelectModsDir };
}

function resolveAutoModsDir(gameRoot) {
  if (!gameRoot || typeof gameRoot !== "string") return null;
  const candidates = [
    path.join(gameRoot, "Binaries", "Win64", "ue4ss", "Mods"),
    path.join(gameRoot, "Binaries", "Win64", "Mods"),
    path.join(gameRoot, "Mods"),
  ];

  const found = candidates.find((cand) => fs.existsSync(cand));
  return found || candidates[0];
}

function resolveGameRootFromModsDir(targetModsDir, resolveGameRootFn = null) {
  if (!targetModsDir || typeof targetModsDir !== "string") return null;
  let current = path.resolve(targetModsDir);

  for (let i = 0; i < 6; i++) {
    const hasPaks = fs.existsSync(path.join(current, "Content", "Paks"));
    const hasBinaries = fs.existsSync(path.join(current, "Binaries", "Win64"));
    const hasExe = fs.existsSync(path.join(current, "Dawnwalker.exe")) || fs.existsSync(path.join(current, "Binaries", "Win64", "Dawnwalker.exe"));

    if (hasPaks || hasBinaries || hasExe) {
      if (typeof resolveGameRootFn === "function") {
        return resolveGameRootFn(current);
      }
      const candidates = [current, path.join(current, "Dawnwalker")];
      return candidates.find((cand) => (
        fs.existsSync(path.join(cand, "Content", "Paks"))
        || fs.existsSync(path.join(cand, "Binaries", "Win64"))
      )) || current;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function readAppConfig(userDataDir) {
  if (!userDataDir || typeof userDataDir !== "string") return {};
  const configFile = path.join(userDataDir, "config.json");
  try {
    const content = fs.readFileSync(configFile, "utf8");
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAppConfig(userDataDir, patch) {
  if (!userDataDir || typeof userDataDir !== "string") return null;
  const configFile = path.join(userDataDir, "config.json");
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    const current = readAppConfig(userDataDir);
    const updated = { ...current, ...patch };
    fs.writeFileSync(configFile, JSON.stringify(updated, null, 2), "utf8");
    return updated;
  } catch (error) {
    console.error("Failed to write config:", error);
    return null;
  }
}

function resolveActiveModsDir({ customModsDir, gameRoot }) {
  if (customModsDir && typeof customModsDir === "string") {
    return path.normalize(customModsDir);
  }
  if (gameRoot && typeof gameRoot === "string") {
    return resolveAutoModsDir(gameRoot);
  }
  return null;
}

module.exports = {
  parseLaunchArgs,
  resolveAutoModsDir,
  resolveGameRootFromModsDir,
  readAppConfig,
  writeAppConfig,
  resolveActiveModsDir,
};
