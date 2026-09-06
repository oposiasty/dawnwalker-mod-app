/**
 * Public API exposed to the renderer via the Electron preload bridge.
 *
 * This is intentionally a narrow, IPC-backed surface: the renderer can call
 * these methods, but it cannot access Node, the filesystem, or the game install
 * directly. All live gameplay writes still flow through the main process and
 * the verified bridge protocol.
 *
 * @typedef {Object} DawnwalkerAPI
 * @property {() => Promise<Object>} scanInstall
 * @property {() => Promise<Object>} backupUserData
 * @property {(leftName: string, rightName: string) => Promise<Object>} compareSaves
 * @property {() => Promise<Object>} deployBridge
 * @property {() => Promise<Object>} bridgeStatus
 * @property {() => Promise<Object>} getBridgeCommandState
 * @property {(level: number) => Promise<Object>} applyLevel
 * @property {(cap: number) => Promise<Object>} applyLevelCap
 * @property {(enabled: boolean) => Promise<Object>} applyInfiniteHealth
 * @property {(enabled: boolean) => Promise<Object>} applyInfiniteStamina
 * @property {(mult: number) => Promise<Object>} applySpeedMultiplier
 * @property {(mult: number) => Promise<Object>} applyJumpMultiplier
 * @property {(mult: number) => Promise<Object>} applyFovMultiplier
 * @property {(speed: number) => Promise<Object>} applyGameSpeed
 * @property {(value: number) => Promise<Object>} applyDamageAmplifier
 * @property {(key: string, value: any) => Promise<Object>} applyBridgeField
 * @property {(values: Object) => Promise<Object>} applyBridgePreset
 * @property {() => Promise<Object>} resetBridge
 * @property {(name: string, arg: any) => Promise<Object>} runBridgeAction
 * @property {() => Promise<Object>} deployNativeFix
 * @property {() => Promise<Object>} nativeFixStatus
 * @property {(gearId: string, quantity?: number) => Promise<Object>} giveGearNative
 * @property {(gearId: string) => Promise<Object>} removeGearNative
 * @property {() => Promise<Object>} getModsDir
 * @property {() => Promise<Object>} selectModsDir
 * @property {(modsDir: string | null) => Promise<Object>} setModsDir
 * @property {(enabled: boolean) => Promise<Object>} setAskModsDirOnLaunch
 */
const { contextBridge, ipcRenderer } = require("electron");

function deepFreeze(value) {
	if (value && (typeof value === "object" || typeof value === "function") && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const nestedValue of Object.values(value)) deepFreeze(nestedValue);
	}
	return value;
}

const dawnwalkerApi = {
	scanInstall: () => ipcRenderer.invoke("game:scan"),
	backupUserData: () => ipcRenderer.invoke("game:backup-user-data"),
	compareSaves: (leftName, rightName) => ipcRenderer.invoke("game:compare-saves", leftName, rightName),
	deployBridge: () => ipcRenderer.invoke("bridge:deploy"),
	bridgeStatus: () => ipcRenderer.invoke("bridge:status"),
	getBridgeCommandState: () => ipcRenderer.invoke("bridge:get-command"),
	applyLevel: (level) => ipcRenderer.invoke("bridge:apply-level", level),
	applyLevelCap: (cap) => ipcRenderer.invoke("bridge:apply-level-cap", cap),
	applyInfiniteHealth: (enabled) => ipcRenderer.invoke("bridge:apply-infinite-health", enabled),
	applyInfiniteStamina: (enabled) => ipcRenderer.invoke("bridge:apply-infinite-stamina", enabled),
	applySpeedMultiplier: (mult) => ipcRenderer.invoke("bridge:apply-speed", mult),
	applyJumpMultiplier: (mult) => ipcRenderer.invoke("bridge:apply-jump", mult),
	applyFovMultiplier: (mult) => ipcRenderer.invoke("bridge:apply-fov", mult),
	applyGameSpeed: (speed) => ipcRenderer.invoke("bridge:apply-game-speed", speed),
	applyDamageAmplifier: (value) => ipcRenderer.invoke("bridge:apply-damage-amplifier", value),
	// Generic persistent field (infiniteBlood, noCooldowns, movementMode, difficulty, ...) - the
	// main process validates the key against an allowlist and clamps the value.
	applyBridgeField: (key, value) => ipcRenderer.invoke("bridge:apply-field", key, value),
	applyBridgePreset: (values) => ipcRenderer.invoke("bridge:apply-preset", values),
	// Forget every live setting and hand the game back its defaults.
	resetBridge: () => ipcRenderer.invoke("bridge:reset"),
	// One-shot action executed once by the Lua mod (grantXP, addCoins, killTarget, ...).
	runBridgeAction: (name, arg) => ipcRenderer.invoke("bridge:action", name, arg),
	deployNativeFix: () => ipcRenderer.invoke("nativefix:deploy"),
	nativeFixStatus: () => ipcRenderer.invoke("nativefix:status"),
	giveGearNative: (gearId, quantity) => ipcRenderer.invoke("nativefix:give-gear", gearId, quantity),
	removeGearNative: (gearId) => ipcRenderer.invoke("nativefix:remove-gear", gearId),
	getModsDir: () => ipcRenderer.invoke("game:get-mods-dir"),
	selectModsDir: () => ipcRenderer.invoke("game:select-mods-dir"),
	setModsDir: (modsDir) => ipcRenderer.invoke("game:set-mods-dir", modsDir),
	setAskModsDirOnLaunch: (enabled) => ipcRenderer.invoke("game:set-ask-mods-dir-on-launch", enabled),
};

contextBridge.exposeInMainWorld("dawnwalker", deepFreeze(dawnwalkerApi));
