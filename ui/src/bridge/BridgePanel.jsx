import { useTheme } from "../theme/useTheme";
import RuneSection from "../components/ui/RuneSection";
import DWButton from "../components/ui/DWButton";
import { formatReadout } from "./useBridge";

// Wraps a page's live controls: explains when the bridge isn't available (browser preview),
// offers the deploy button when the Lua mod isn't installed yet, and otherwise shows the
// connection state plus the last action result reported by the game.
export default function BridgePanel({ bridgeApi, title = "Live Game Bridge", intro, children }) {
  const { theme } = useTheme();
  const { bridge, status, message, busy, deploy, resetAll } = bridgeApi;

  if (!bridge) {
    return (
      <RuneSection title={title}>
        <p style={{ opacity: 0.78 }}>Live game controls are only available in the desktop app.</p>
      </RuneSection>
    );
  }

  const deployed = status?.deployed;
  const handshaken = status?.ok && status?.awaitingHandshake !== "1";
  const inCutscene = status?.cutsceneActive === "1";
  const appConnected = status?.appConnected === undefined ? true : status.appConnected === "1";
  const responding = !status?.ok ? "No" : inCutscene ? "Paused (cutscene)" : !handshaken ? "Connecting…" : !appConnected ? "Disconnected" : "Yes";
  const statusSummary = !status ? "Waiting for bridge status…" : !status.gameRunning
    ? "The game is not running."
    : !deployed
      ? "The bridge mod is not deployed yet."
      : inCutscene
        ? "Writes are paused while a cutscene or unsafe world state is active."
        : !handshaken
          ? "Waiting for the game to acknowledge the current boot."
          : !appConnected
            ? "The app connection dropped; writes are paused until the game reconnects."
            : "The bridge is connected and ready for live writes.";

  return (
    <>
      <RuneSection title={title}>
        {intro && <p style={{ opacity: 0.78, marginBottom: 12 }}>{intro}</p>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 22px", marginBottom: 6 }}>
          <span>Game running: <strong>{status?.gameRunning ? "Yes" : "No"}</strong></span>
          <span>Bridge mod: <strong>{deployed ? "Deployed" : "Not deployed"}</strong></span>
          <span>Mod responding: <strong>{responding}</strong></span>
        </div>
        <p style={{ opacity: 0.82, marginTop: 0, marginBottom: 8 }}>{statusSummary}</p>
        {status?.actionResult && (
          <p style={{ opacity: 0.85 }}>Last action: <span style={{ fontFamily: "var(--mono)" }}>{status.actionResult}</span></p>
        )}
        {message && <p style={{ color: theme.colors.gold }}>{message}</p>}
        {!deployed ? (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <DWButton label="Deploy Bridge Mod" onClick={deploy} disabled={busy} data-clickpulse data-glow />
            {typeof window !== "undefined" && window.dawnwalker?.selectModsDir && (
              <DWButton
                label="Select Mods Folder..."
                onClick={async () => {
                  const res = await window.dawnwalker.selectModsDir();
                  if (res?.ok) deploy();
                }}
                disabled={busy}
              />
            )}
          </div>
        ) : (
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
            <DWButton label="Reset to Game Defaults" onClick={resetAll} disabled={busy} />
            <span style={{ opacity: 0.7, fontSize: "0.85em" }}>
              Every game launch starts at defaults - apply a preset from Profiles & Backups once loaded in.
            </span>
          </div>
        )}
      </RuneSection>
      {deployed && children}
    </>
  );
}

// Compact key/value readouts sourced from status.txt.
export function Readouts({ items }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 22px", marginBottom: 14, opacity: 0.9 }}>
      {items.map(([label, value]) => (
        <span key={label}>
          {label}: <strong style={{ fontFamily: "var(--mono)" }}>{formatReadout(value)}</strong>
        </span>
      ))}
    </div>
  );
}

// A slider paired with an "Apply" button for one-shot actions that take a numeric argument.
export function ActionRow({ children, label, onClick, disabled }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 260px" }}>{children}</div>
      <DWButton label={label} onClick={onClick} disabled={disabled} data-clickpulse data-glow />
    </div>
  );
}

export function ButtonRow({ children }) {
  return <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>{children}</div>;
}

export function Note({ children, tone }) {
  const { theme } = useTheme();
  return (
    <p style={{ opacity: tone === "warn" ? 0.95 : 0.78, fontSize: "0.85em", marginTop: 6, color: tone === "warn" ? theme.colors.gold : undefined }}>
      {children}
    </p>
  );
}
