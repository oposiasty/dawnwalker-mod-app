const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const {
  parseLaunchArgs,
  resolveAutoModsDir,
  resolveGameRootFromModsDir,
  readAppConfig,
  writeAppConfig,
  resolveActiveModsDir,
} = require("../mods-dir-resolver");

test("parseLaunchArgs detects --select-mods-dir and variations", () => {
  assert.deepEqual(parseLaunchArgs(["node", "index.js", "--select-mods-dir"]), {
    cliModsDir: null,
    forceSelectModsDir: true,
  });

  assert.deepEqual(parseLaunchArgs(["node", "index.js", "--choose-mods-dir"]), {
    cliModsDir: null,
    forceSelectModsDir: true,
  });
});

test("parseLaunchArgs extracts --mods-dir paths", () => {
  assert.deepEqual(
    parseLaunchArgs(["node", "index.js", "--mods-dir=C:\\Games\\Mods"]),
    {
      cliModsDir: "C:\\Games\\Mods",
      forceSelectModsDir: false,
    }
  );

  assert.deepEqual(
    parseLaunchArgs(["node", "index.js", "--mods-dir", "D:\\UE4SS\\Mods"]),
    {
      cliModsDir: "D:\\UE4SS\\Mods",
      forceSelectModsDir: false,
    }
  );

  assert.deepEqual(
    parseLaunchArgs(["node", "index.js", "-m", "E:\\MyMods"]),
    {
      cliModsDir: "E:\\MyMods",
      forceSelectModsDir: false,
    }
  );
});

test("parseLaunchArgs supports DAWNWALKER_MODS_DIR environment variable", () => {
  const env = { DAWNWALKER_MODS_DIR: "C:\\EnvMods" };
  assert.deepEqual(parseLaunchArgs(["node", "index.js"], env), {
    cliModsDir: "C:\\EnvMods",
    forceSelectModsDir: false,
  });
});

test("resolveActiveModsDir favors customModsDir over auto-detected", () => {
  const custom = "C:\\CustomMods";
  const gameRoot = "C:\\GameRoot";
  assert.equal(
    resolveActiveModsDir({ customModsDir: custom, gameRoot }),
    path.normalize(custom)
  );
});

test("resolveAutoModsDir provides sensible defaults", () => {
  const fakeGameRoot = path.join(os.tmpdir(), `dawnwalker-test-${Date.now()}`);
  const ue4ssMods = path.join(fakeGameRoot, "Binaries", "Win64", "ue4ss", "Mods");
  const win64Mods = path.join(fakeGameRoot, "Binaries", "Win64", "Mods");

  try {
    fs.mkdirSync(win64Mods, { recursive: true });
    assert.equal(resolveAutoModsDir(fakeGameRoot), win64Mods);

    fs.mkdirSync(ue4ssMods, { recursive: true });
    assert.equal(resolveAutoModsDir(fakeGameRoot), ue4ssMods);
  } finally {
    try {
      fs.rmSync(fakeGameRoot, { recursive: true, force: true });
    } catch {}
  }
});

test("readAppConfig and writeAppConfig persist preferences safely", () => {
  const tempDir = path.join(os.tmpdir(), `dawnwalker-cfg-${Date.now()}`);
  try {
    assert.deepEqual(readAppConfig(tempDir), {});
    writeAppConfig(tempDir, { modsDir: "C:\\SavedMods", askModsDirOnLaunch: true });
    const loaded = readAppConfig(tempDir);
    assert.equal(loaded.modsDir, "C:\\SavedMods");
    assert.equal(loaded.askModsDirOnLaunch, true);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});
