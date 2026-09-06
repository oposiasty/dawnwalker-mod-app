// Shared validation for everything the app writes into the DawnwalkerModBridge command.txt.
// Kept free of Electron imports so it can be unit-tested directly. Every clamp here is mirrored
// by an independent bounds check in runtime-mods/DawnwalkerModBridge/Scripts/main.lua.

const clampNumber = (min, max, integer = false) => (value) => {
  const numeric = Number(value);
  if (value === null || value === "" || typeof value === "boolean" || !Number.isFinite(numeric)) return undefined;
  const clamped = Math.max(min, Math.min(max, numeric));
  return integer ? Math.floor(clamped) : clamped;
};
const toggle = (value) => (value === true || value === 1 || value === "1" ? 1 : 0);
const oneOf = (allowed) => (value) => (allowed.includes(value) ? value : undefined);

// Persistent fields: re-applied by the Lua mod every tick for as long as they're in command.txt.
const BRIDGE_FIELD_SANITIZERS = {
  levelCap: clampNumber(1, 99, true),
  infiniteHealth: toggle,
  infiniteStamina: toggle,
  infiniteBlood: toggle,
  keepActionSlotsCharged: toggle,
  noCooldowns: toggle,
  speedMultiplier: clampNumber(0.1, 5),
  jumpMultiplier: clampNumber(0.1, 5),
  fovMultiplier: clampNumber(0.1, 5),
  gameSpeed: clampNumber(0.1, 4),
  damageAmplifier: clampNumber(1, 20),
  carryWeightMultiplier: clampNumber(0.1, 100),
  actionDifficulty: clampNumber(0, 3, true),
  rpgDifficulty: clampNumber(0, 3, true),
  movementMode: oneOf(["walk", "fly", "ghost"]),
};

// One-shot actions: executed exactly once by the Lua mod per actionId nonce. `null` = no argument.
const BRIDGE_ACTIONS = {
  grantXP: clampNumber(1, 5, true),
  addTraitPoints: clampNumber(-999, 999, true),
  setTraitPoints: clampNumber(0, 999, true),
  unlockAllTraits: null,
  resetAllTraits: null,
  addMutationCharges: clampNumber(-999, 999, true),
  addCoins: clampNumber(-999999, 999999, true),
  unlockAllRecipes: null,
  dumpItemNames: null,
  selfCheck: null,
  setNpcLevelOverride: clampNumber(0, 99, true),
  setAlertLevel: clampNumber(0, 9, true),
  unlockAllFastTravel: null,
  revealAllMappins: null,
  killAllAggressive: null,
  teleport: null,
  setTimeOfDay: (value) => (typeof value === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(value) ? value : undefined),
  refillBlood: null,
  healNow: null,
};

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function sanitizeField(key, value) {
  if (!hasOwn(BRIDGE_FIELD_SANITIZERS, key)) return { ok: false, error: `Unknown bridge field: ${key}` };
  const sanitized = BRIDGE_FIELD_SANITIZERS[key](value);
  if (sanitized === undefined) return { ok: false, error: `Invalid value for ${key}` };
  return { ok: true, key, value: sanitized };
}

// Unknown/invalid entries are skipped rather than failing the whole preset.
function sanitizePreset(values) {
  if (!values || typeof values !== "object") return { ok: false, error: "Invalid preset" };
  const patch = {};
  for (const [key, value] of Object.entries(values)) {
    if (!hasOwn(BRIDGE_FIELD_SANITIZERS, key)) continue;
    const sanitized = BRIDGE_FIELD_SANITIZERS[key](value);
    if (sanitized !== undefined) patch[key] = sanitized;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "Preset contains no applicable settings" };
  return { ok: true, patch };
}

function sanitizeAction(name, arg) {
  if (!hasOwn(BRIDGE_ACTIONS, name)) {
    return { ok: false, error: `Unknown action: ${name}` };
  }
  const sanitize = BRIDGE_ACTIONS[name];
  if (!sanitize) return { ok: true, name, arg: "" };
  const sanitized = sanitize(arg);
  // "add N" with N=0 would be a no-op that still consumes a nonce - reject it up front.
  const zeroIsNoOp = name.startsWith("add") && sanitized === 0;
  if (sanitized === undefined || zeroIsNoOp) return { ok: false, error: `Invalid value for ${name}` };
  return { ok: true, name, arg: sanitized };
}

// Every key the app may legitimately write to command.txt: persistent fields plus the one-shot
// nonces/payloads. Anything else found on disk is a leftover from a removed feature.
const KNOWN_COMMAND_KEYS = new Set([
  ...Object.keys(BRIDGE_FIELD_SANITIZERS),
  "requestId",
  "setLevel",
  "actionId",
  "action",
  "actionArg",
]);

module.exports = {
  BRIDGE_FIELD_SANITIZERS,
  BRIDGE_ACTIONS,
  KNOWN_COMMAND_KEYS,
  sanitizeField,
  sanitizePreset,
  sanitizeAction,
};
