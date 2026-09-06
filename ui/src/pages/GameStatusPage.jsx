import { useTheme } from "../theme/useTheme";
import { useGameData } from "../data/useGameData";
import DWButton from "../components/ui/DWButton";
import DWSelect from "../components/ui/DWSelect";
import PageHeader from "../components/ui/PageHeader";
import RuneSection from "../components/ui/RuneSection";
import { useState, useEffect } from "react";

const signalLabels = {
  unrealPackDirectory: "Unreal Content/Paks directory",
  pakFiles: ".pak archives",
  ioStoreTocFiles: ".utoc tables of contents",
  ioStoreDataFiles: ".ucas data containers",
  pluginsDirectory: "Plugins directory",
  modDirectory: "Existing mod directory",
  userConfigDirectory: "Saved/Config/Windows directory",
  easyAntiCheat: "Easy Anti-Cheat directory",
};

function signalValue(key, value) {
  if (key === "modDirectory") return value || "Not found";
  if (["pakFiles", "ioStoreTocFiles", "ioStoreDataFiles"].includes(key)) return String(value);
  return value ? "Found" : "Not found";
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function GameStatusPage() {
  const { theme } = useTheme();
  const game = useGameData();
  const [backupMessage, setBackupMessage] = useState("");
  const [leftSave, setLeftSave] = useState("");
  const [rightSave, setRightSave] = useState("");
  const [comparison, setComparison] = useState(null);
  const [modsDirInfo, setModsDirInfo] = useState({
    modsDir: "",
    defaultModsDir: "",
    isCustom: false,
    exists: false,
    askModsDirOnLaunch: false,
    loading: true,
  });
  const [modsMessage, setModsMessage] = useState("");

  const refreshModsDir = async () => {
    if (window.dawnwalker?.getModsDir) {
      try {
        const info = await window.dawnwalker.getModsDir();
        setModsDirInfo({ ...info, loading: false });
      } catch {
        setModsDirInfo((prev) => ({ ...prev, loading: false }));
      }
    }
  };

  useEffect(() => {
    refreshModsDir();
  }, []);

  async function handleSelectMods() {
    if (!window.dawnwalker?.selectModsDir) return;
    const result = await window.dawnwalker.selectModsDir();
    if (result?.ok) {
      setModsMessage(`Mods folder updated: ${result.modsDir}`);
      await refreshModsDir();
      game.refresh();
    }
  }

  async function handleResetMods() {
    if (!window.dawnwalker?.setModsDir) return;
    await window.dawnwalker.setModsDir(null);
    setModsMessage("Mods folder reset to auto-detected default.");
    await refreshModsDir();
    game.refresh();
  }

  async function handleToggleAsk(enabled) {
    if (!window.dawnwalker?.setAskModsDirOnLaunch) return;
    await window.dawnwalker.setAskModsDirOnLaunch(enabled);
    setModsDirInfo((prev) => ({ ...prev, askModsDirOnLaunch: enabled }));
  }

  async function handleBackup() {
    if (!window.dawnwalker?.backupUserData) {
      setBackupMessage("Backups are available in the desktop app only.");
      return;
    }
    const result = await window.dawnwalker.backupUserData();
    setBackupMessage(result.ok ? `Backup created: ${result.copiedFiles.length} files` : result.error);
  }

  return (
    <div>
      <PageHeader title="Install & Capabilities" />

      {game.loading ? (
        <p style={{ opacity: 0.8 }}>Scanning Steam libraries for The Blood of Dawnwalker...</p>
      ) : game.unavailable ? (
        <RuneSection title="Desktop Integration Required">
          <p>This scan is available only in the Electron desktop app, not the Vite browser preview.</p>
        </RuneSection>
      ) : !game.installed ? (
        <RuneSection title="Steam Installation Not Found">
          <p>Steam app ID 3751260 was not found in the standard Steam library locations.</p>
          <p style={{ opacity: 0.78 }}>No game files were changed. Install the game through Steam, then rescan, or select your UE4SS Mods folder below.</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
            <DWButton label="Scan Steam Libraries" onClick={game.refresh} />
            <DWButton label="Select Mods Folder..." onClick={handleSelectMods} />
          </div>
          {modsDirInfo.modsDir && (
            <p style={{ marginTop: 10, overflowWrap: "anywhere", fontFamily: "var(--mono)" }}>
              Selected mods folder: {modsDirInfo.modsDir}
            </p>
          )}
          {modsMessage && <p style={{ color: theme.colors.gold, marginTop: 8 }}>{modsMessage}</p>}
        </RuneSection>
      ) : (
        <>
          <RuneSection title="Detected Installation">
            <p><strong>{game.scan.gameName}</strong> was found through Steam app ID {game.appId}.</p>
            <p style={{ overflowWrap: "anywhere" }}>{game.path}</p>
            <p style={{ overflowWrap: "anywhere" }}>Game root: {game.scan.gameRoot}</p>
            <p>Build ID: {game.scan.buildId || "Not reported by Steam"}</p>
            <p>Game process: {game.scan.gameRunning ? "Running" : "Not running"}</p>
            <p>Executables: {game.scan.executableFiles.length ? game.scan.executableFiles.join(", ") : "None found at install root"}</p>
            <DWButton label="Rescan Installation" onClick={game.refresh} />
          </RuneSection>

          <div style={{ marginTop: 16 }}>
            <RuneSection title="Read-Only UE5 Packaging Scan">
              <div style={{ display: "grid", gap: 9 }}>
                {Object.entries(game.scan.signals).map(([key, value]) => (
                  <div key={key} style={{ display: "flex", justifyContent: "space-between", gap: 16, borderBottom: `1px solid ${theme.colors.divider}`, paddingBottom: 7 }}>
                    <span>{signalLabels[key]}</span>
                    <strong>{signalValue(key, value)}</strong>
                  </div>
                ))}
              </div>
            </RuneSection>
          </div>

          <div style={{ marginTop: 16 }}>
            <RuneSection title="Mod-Relevant Files">
              <p style={{ opacity: 0.78 }}>
                Files below are detected under the game root only. The scan is read-only and does not include Unreal Engine files.
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                {Object.entries(game.scan.inventorySummary).map(([extension, count]) => (
                  <strong key={extension} style={{ border: `1px solid ${theme.colors.divider}`, padding: "6px 9px" }}>
                    {extension}: {count}
                  </strong>
                ))}
              </div>
              <div style={{ display: "grid", gap: 7, maxHeight: 360, overflowY: "auto" }}>
                {game.scan.inventory.map((file) => (
                  <div key={file.relativePath} style={{ display: "flex", justifyContent: "space-between", gap: 16, borderBottom: `1px solid ${theme.colors.divider}`, paddingBottom: 6 }}>
                    <span style={{ overflowWrap: "anywhere" }}>{file.relativePath}</span>
                    <strong style={{ whiteSpace: "nowrap" }}>{formatBytes(file.sizeBytes)}</strong>
                  </div>
                ))}
              </div>
            </RuneSection>
          </div>

          <div style={{ marginTop: 16 }}>
            <RuneSection title="IoStore Archive Inspection">
              <p style={{ opacity: 0.78 }}>
                The TOC headers are read-only and verified without opening the large UCAS containers for writing.
              </p>
              <div style={{ display: "grid", gap: 9 }}>
                {game.scan.tocInspections.map((toc) => (
                  <div key={toc.relativePath} style={{ borderBottom: `1px solid ${theme.colors.divider}`, paddingBottom: 9 }}>
                    <strong style={{ overflowWrap: "anywhere" }}>{toc.relativePath}</strong>
                    {toc.readable ? (
                      <div style={{ display: "grid", gap: 4, marginTop: 5, opacity: 0.82 }}>
                        <span>Format: {toc.magic}, version {toc.version}</span>
                        <span>Header: {toc.headerSize} bytes; TOC entries: {toc.tocEntryCount.toLocaleString()}</span>
                        <span>Compression blocks: {toc.compressedBlockCount.toLocaleString()} at {formatBytes(toc.compressionBlockSize)}; directory index: {formatBytes(toc.directoryIndexSize)}</span>
                        <span>Partitions: {toc.partitionCount}; container flags: 0x{toc.containerFlags.toString(16).padStart(2, "0")}</span>
                        <span>Indexed: {toc.indexed ? "yes" : "no"}; encrypted: {toc.encrypted ? "yes" : "no"}; compressed: {toc.compressed ? "yes" : "no"}; signed: {toc.signed ? "yes" : "no"}</span>
                        <span>{toc.directoryIndex}</span>
                      </div>
                    ) : (
                      <div style={{ marginTop: 5, opacity: 0.82 }}>Unable to read this TOC header: {toc.error}</div>
                    )}
                  </div>
                ))}
              </div>
            </RuneSection>
          </div>

          <div style={{ marginTop: 16 }}>
            <RuneSection title="User Data Discovery">
              <p style={{ overflowWrap: "anywhere" }}>Profile root: {game.scan.userData.root}</p>
              <p style={{ overflowWrap: "anywhere" }}>Save directory: {game.scan.userData.saveRoot}</p>
              <p>Save files: {game.scan.userData.saveFiles.length ? `${game.scan.userData.saveFiles.length} found` : "None found"}</p>
              {game.scan.userData.saveFiles.length > 0 && (
                <div style={{ display: "grid", gap: 7 }}>
                  {game.scan.userData.saveFiles.map((file) => (
                    <div key={file.name} style={{ display: "flex", justifyContent: "space-between", gap: 16, borderBottom: `1px solid ${theme.colors.divider}`, paddingBottom: 6 }}>
                      <span style={{ overflowWrap: "anywhere" }}>{file.name}</span>
                      <strong style={{ whiteSpace: "nowrap" }}>{file.format}, {formatBytes(file.sizeBytes)}</strong>
                    </div>
                  ))}
                </div>
              )}
              {game.scan.userData.settingsProperties.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <strong>Detected RebelSettings properties</strong>
                  <p style={{ overflowWrap: "anywhere", opacity: 0.82 }}>{game.scan.userData.settingsProperties.join(", ")}</p>
                </div>
              )}
              <div style={{ display: "grid", gap: 7, marginTop: 10 }}>
                <strong>Gameplay setting candidates</strong>
                {game.scan.userData.settingsCandidates.map((candidate) => (
                  <div key={candidate.property} style={{ display: "flex", justifyContent: "space-between", gap: 16, borderBottom: `1px solid ${theme.colors.divider}`, paddingBottom: 6 }}>
                    <span>{candidate.label}</span>
                    <strong>{candidate.present ? "Present in GVAS" : "Not present"}</strong>
                  </div>
                ))}
                <p style={{ opacity: 0.78 }}>XP and skill unlock fields were not found in RebelSettings.sav; they are expected to require DSAV parsing or runtime integration.</p>
              </div>
              <p style={{ overflowWrap: "anywhere" }}>Config directory: {game.scan.userData.configRoot}</p>
              <p>Config files: {game.scan.userData.configFiles.length ? game.scan.userData.configFiles.join(", ") : "None found"}</p>
              <DWButton label="Create Read-Only Backup" onClick={handleBackup} />
              {backupMessage && <p style={{ opacity: 0.82 }}>{backupMessage}</p>}
              <p style={{ opacity: 0.78 }}>User data is detected read-only. No saves or configuration files have been changed.</p>
              {game.scan.userData.saveFiles.length > 1 && (
                <div style={{ marginTop: 14 }}>
                  <strong>Compare DSAV saves</strong>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "end", marginTop: 8 }}>
                    <DWSelect label="Before" value={leftSave} onChange={setLeftSave} options={["", ...game.scan.userData.saveFiles.map((file) => file.name)]} />
                    <DWSelect label="After" value={rightSave} onChange={setRightSave} options={["", ...game.scan.userData.saveFiles.map((file) => file.name)]} />
                    <DWButton label="Compare" onClick={async () => setComparison(await window.dawnwalker.compareSaves(leftSave, rightSave))} />
                  </div>
                  {comparison && (comparison.ok ? (
                    <p style={{ opacity: 0.82 }}>{comparison.left.name} to {comparison.right.name}: {comparison.changedBytes.toLocaleString()} changed bytes across {comparison.totalChangedRanges} ranges; size difference: {comparison.trailingBytes} bytes. First ranges: {comparison.changedRanges.slice(0, 5).map((range) => `${range.start}-${range.end}`).join(", ") || "none"}</p>
                  ) : <p style={{ opacity: 0.82 }}>{comparison.error}</p>)}
                </div>
              )}
            </RuneSection>
          </div>

          <div style={{ marginTop: 16 }}>
            <RuneSection title="Mods Directory Configuration">
              <p style={{ opacity: 0.78 }}>
                The folder where UE4SS loads runtime mods (DawnwalkerModBridge and DawnwalkerNativeFix).
              </p>
              <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, borderBottom: `1px solid ${theme.colors.divider}`, paddingBottom: 6 }}>
                  <span>Active mods directory:</span>
                  <strong>{modsDirInfo.isCustom ? "Custom override" : "Auto-detected"}</strong>
                </div>
                <p style={{ fontFamily: "var(--mono)", background: "rgba(0,0,0,0.3)", padding: "8px 12px", borderRadius: 4, overflowWrap: "anywhere", margin: "4px 0" }}>
                  {modsDirInfo.modsDir || "Not resolved"}
                </p>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
                  <span>Status on disk:</span>
                  <strong style={{ color: modsDirInfo.exists ? theme.colors.gold : "#e57373" }}>
                    {modsDirInfo.exists ? "Directory verified on disk" : "Directory not found"}
                  </strong>
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <DWButton label="Select Mods Folder..." onClick={handleSelectMods} />
                {modsDirInfo.isCustom && (
                  <DWButton label="Reset to Auto-Detected" onClick={handleResetMods} />
                )}
              </div>

              <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "0.9em" }}>
                  <input
                    type="checkbox"
                    checked={modsDirInfo.askModsDirOnLaunch}
                    onChange={(e) => handleToggleAsk(e.target.checked)}
                  />
                  <span>Ask to select mods folder at app launch</span>
                </label>
              </div>
              {modsMessage && <p style={{ color: theme.colors.gold, marginTop: 8 }}>{modsMessage}</p>}
            </RuneSection>
          </div>

          <div style={{ marginTop: 16 }}>
            <RuneSection title="Runtime Mod Loader">
              <p style={{ overflowWrap: "anywhere" }}>Binary directory: {game.scan.runtimeLoader.binaryRoot}</p>
              <p style={{ overflowWrap: "anywhere" }}>Loader directory: {game.scan.runtimeLoader.loaderRoot}</p>
              <p>Status: {game.scan.runtimeLoader.status}</p>
              <p>Loader markers: {game.scan.runtimeLoader.foundMarkers.length ? game.scan.runtimeLoader.foundMarkers.join(", ") : "None found"}</p>
              <p>Runtime mod directories: {game.scan.runtimeLoader.modDirectories.length ? game.scan.runtimeLoader.modDirectories.join(", ") : "None found"}</p>
              <p>Live gameplay controls: {game.scan.runtimeLoader.supported ? "Available - deploy the bridge mod from any gameplay page" : "Unavailable until UE4SS is installed"}</p>
              <p style={{ opacity: 0.78 }}>
                This app never patches game binaries. It installs two UE4SS mods (DawnwalkerModBridge Lua script and
                the DawnwalkerNativeFix DLL) into the existing UE4SS Mods folder and talks to them through text files.
              </p>
            </RuneSection>
          </div>

          <div style={{ marginTop: 16 }}>
            <RuneSection title="Gameplay Runtime Candidates">
              <p style={{ opacity: 0.78 }}>Symbols present in Dawnwalker.exe that identify the runtime systems the bridge mod targets.</p>
              <div style={{ display: "grid", gap: 7 }}>
                {game.scan.gameplaySymbols.map((candidate) => (
                  <div key={candidate.symbol} style={{ display: "flex", justifyContent: "space-between", gap: 16, borderBottom: `1px solid ${theme.colors.divider}`, paddingBottom: 6 }}>
                    <span>{candidate.label} <small style={{ opacity: 0.7 }}>({candidate.symbol})</small><small style={{ display: "block", opacity: 0.62 }}>{candidate.targetGroup}</small></span>
                    <strong>{candidate.present ? "Found" : "Not found"}</strong>
                  </div>
                ))}
              </div>
            </RuneSection>
          </div>

          <p style={{ marginTop: 16, opacity: 0.78 }}>
            This scan does not install, unpack, patch, or alter any game files.
          </p>
        </>
      )}
    </div>
  );
}