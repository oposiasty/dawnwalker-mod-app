-- DawnwalkerModBridge: applies gameplay changes requested by the Dawnwalker Mod App.
-- Protocol: the Electron app writes Mods/DawnwalkerModBridge/command.txt (simple key=value lines).
-- This mod polls that file, applies changes via live reflection, and writes
-- Mods/DawnwalkerModBridge/status.txt so the app can show the result back to the user.
--
-- Verified live targets (from UE4SS_ObjectDump.txt):
--   /Script/DogwoodCharacterDevelopment.DogwoodCharacterDevelopmentSettings:LevelCap (Int8Property)
--   /Script/DogwoodCharacterDevelopment.CharacterDevelopmentSubsystem:ForceLevelUpTo(Level, bReceiveTraitPoints)
--   /Script/DogwoodCharacterDevelopment.CharacterDevelopmentSubsystem:GetCurrentLevel() / GetCurrentXP()
--   /Script/DogwoodCombat.CombatComponentBase:SetHealthPercent(InPercent) / SetStaminaPercent(InPercent)
--   /Script/DogwoodCombat.CombatComponentBase:GetHealthPercentage() / GetStaminaPercentage()
--   /Script/Engine.CharacterMovementComponent:MaxWalkSpeed / JumpZVelocity (FloatProperty)
--   /Script/Engine.PlayerCameraManager:DefaultFOV (FloatProperty)
--   /Script/Engine.CheatManager:Slomo(NewTimeDilation)
--   /Script/Engine.CheatManager:God() (toggle, no return value/getter)
--   /Script/DogwoodStats.CharacterBaseAttributeSet:Health / MaxHealth (FGameplayAttributeData
--     struct properties with CurrentValue/BaseValue floats) via
--     AbilitySystemComponent:GetAttributeSet(AttributeSetClass)
--   /Script/DogwoodCharacterDevelopment.CharacterDevelopmentSubsystem:AddQuestXP(RewardAmount enum 1-5)
--     / GetTraitPointAmount() / ReceiveTraitPoints(Value) / SetTraitPointsAmount(Value)
--     / UnlockAllTraits(bUnlock, bUnblock, bUnhide, bUnblockNextLevelOnly) / ResetAllTraits()
--     / AddMutationCharges(ChargeValue) / GetCurrentMutationCharges() / GetCurrentMutationLevel()
--   /Script/DogwoodSystem.TimeSystemImpl:SetTime(Hour, Minute, Second, bAbsoluteTime) / GetCurrentDay()
--     / GetMainGoalDay() / GetCurrentDayTimeAsFloat()
--   /Script/DogwoodInventory.InventoryComponent:AddCurrency(Currency enum, Quantity) / GetCurrencyAmount(Type)
--     / WeightLimit (FloatProperty) / GetWeightLimit() / GetCurrentWeight()
--   /Script/DogwoodCombat.CombatSubsystem:SetActionDifficulty(enum) / SetRPGDifficulty(enum)
--     / GetActionDifficultyLevel() / GetAllAggressiveNPCActors() / GetAggressiveNpcCount() / GetIsInCombat()
--   /Script/DogwoodCombat.CombatComponentBase:GetTargetedEnemy() / Kill()
--   /Script/DogwoodStats.BloodBarComponent:SetBloodPercent(InBloodPercent) / LockBlood() / UnlockBlood()
--     / HealAndReplenishAllSegments()
--   /Script/DogwoodInventory.CraftingSubsystem:UnlockAllCraftingRecipes() / AddIngredientsForAllCraftingRecipes(N)
--   /Script/DogwoodFocus.FocusAbilitiesSubsystem:ToggleDisablingAllCooldowns_Debug() / AreCooldownsEnabled_Debug()
--   /Script/DogwoodMap.OpenWorldJournalInterface:RevealAllMappins (called via UFunction(context) on OpenWorldJournalImpl)
--   /Script/DogwoodMap.MappinSystemBlueprintLibrary:DebugUnlockAllFastTravelDestinations(OpenWorldJournal)
--   /Script/Engine.CheatManager:Fly() / Ghost() / Walk() / Teleport() / DamageTarget(DamageAmount)
--   /Script/DogwoodStats.PlayerAttributeSet:ChargedActionSlots / UnlockedActionSlots (GAS attributes)

local UEHelpers = require("UEHelpers")

local function ResolveModDir()
    local info = debug.getinfo(1, "S")
    local scriptSource = info and info.source
    if scriptSource and scriptSource:sub(1, 1) == "@" then
        local scriptPath = scriptSource:sub(2)
        local modDir = scriptPath:match("^(.*[/\\])[Ss]cripts[/\\][^/\\]+$")
        if modDir then
            return modDir
        end
    end
    local testDirs = {
        "ue4ss/Mods/DawnwalkerModBridge/",
        "Mods/DawnwalkerModBridge/",
    }
    for _, dir in ipairs(testDirs) do
        local f = io.open(dir .. "Scripts/main.lua", "r")
        if f then
            f:close()
            return dir
        end
    end
    return "Mods/DawnwalkerModBridge/"
end

local MOD_DIR = ResolveModDir()
local COMMAND_PATH = MOD_DIR .. "command.txt"
local STATUS_PATH = MOD_DIR .. "status.txt"

local LastRequestId = nil
local WasCombatFound = false
local ReportedLockHealthError = false
local ReportedUnlockHealthError = false
local ReportedLockStaminaError = false
local ReportedUnlockStaminaError = false
-- LockHealth() alone does not stop combat damage; the call that actually blocks it is
-- RebelAISubsystem:AddPlayerInvulnerability(Source).
local WasHealthInvulnerable = false
local ReportedAddInvulnerabilityError = false
local ReportedRemoveInvulnerabilityError = false
local WasRebelAIFound = false
-- Infinite Health/Stamina is intentionally layered across several redundant mechanisms
-- (AddPlayerInvulnerability, the GAS GE_Invulnerability effect below, native CheatManager:God(),
-- and CombatComponentBase's own LockHealth/SetHealthPercent). The real crash-on-respawn bug (see
-- repo memory) turned out to be a settle-window race condition, not any one of these mechanisms -
-- do not remove any of them without reason, they're kept as belt-and-suspenders, not because any
-- single one was proven necessary or sufficient.
local InvulnerabilityGEClass = nil
local WasGodModeApplied = false
local ReportedGodModeApplyError = false
local ReportedGodModeRemoveError = false
local WasNativeGodModeApplied = false
local ReportedNativeGodModeError = false

-- One-shot actions (actionId nonce + action name + optional actionArg). The nonce only marks a
-- request as noticed; execution is retried each tick until preconditions are met or it times out,
-- so a click that lands during a post-respawn settle window is never silently dropped.
local LastActionId = nil
local PendingAction = nil
local LastActionResult = nil
local ACTION_TIMEOUT_TICKS = 15

-- Boot handshake: command.txt outlives both the game and the app, so nothing in it is trusted
-- until the app echoes this boot's id back (`bootId=` line). Every game launch therefore starts
-- at the game's own defaults, and a stale one-shot request can never replay on relaunch.
local BootId = (function()
    local ok, now = pcall(os.time)
    return string.format("%s-%d", (ok and now) and tostring(now) or "0", math.random(100000, 999999))
end)()
-- Shared between the 1s and 100ms loops so the fast loop also stands down mid-cutscene.
local CutsceneActive = false
-- The app rewrites command.txt with a fresh `heartbeat=` every few seconds and writes
-- `appClosed=1` on quit; without either for APP_TIMEOUT_TICKS the app is gone (closed, crashed
-- or force-killed) and every setting is released so the game returns to its defaults.
local AppConnected = false
local LastHeartbeat = nil
local TicksSinceHeartbeat = 0
local APP_TIMEOUT_TICKS = 20

local function RefreshAppConnection(command)
    if command.appClosed == "1" then
        AppConnected = false
        LastHeartbeat = nil
        return
    end
    if command.heartbeat ~= nil and command.heartbeat ~= LastHeartbeat then
        LastHeartbeat = command.heartbeat
        TicksSinceHeartbeat = 0
        AppConnected = true
        return
    end
    TicksSinceHeartbeat = TicksSinceHeartbeat + 1
    if TicksSinceHeartbeat >= APP_TIMEOUT_TICKS then AppConnected = false end
end

local function IsHandshaken(command)
    return command ~= nil and command.bootId == BootId
end

-- Persistent toggles/values added alongside the original health/stamina/movement set.
local WasBloodLocked = false
local ReportedLockBloodError = false
local ReportedUnlockBloodError = false
local LastAppliedActionDifficulty = nil
local OriginalActionDifficulty = nil
local LastAppliedRPGDifficulty = nil
local LastAppliedMovementMode = nil
local LastAppliedGameSpeed = nil
local OriginalLevelCap = nil
local CooldownsDisabledByUs = false
local ReportedMovementModeError = false
local ReportedCooldownToggleError = false
local PlayerAttributeSetClass = nil
local ReportedActionSlotsWriteError = false
local WasActionSlotsOverridden = false
-- Fallback when UnlockedActionSlots can't be read; the UI never exposes more than this many slots.
local MAX_ACTION_SLOTS = 5
-- Damage amplifier: last seen health percent per enemy actor address, so the next tick can tell
-- how much damage the game just dealt and re-apply it scaled. SharedAmplifier is published by the
-- 1s command tick and consumed by the dedicated fast loop, so that hot path never reads a file.
local AmpHealth = {}
local SharedAmplifier = 1
local LastAmplifiedCount = 0
local AmpLoopLastPawnAddress = nil
local AmpLoopSettleTicks = 0
local ReportedCarryWeightError = false

local function ReadCommandFile()
    local file = io.open(COMMAND_PATH, "r")
    if not file then return nil end
    local data = {}
    for line in file:lines() do
        local key, value = line:match("^(%w+)=(.-)%s*$")
        if key then data[key] = value end
    end
    file:close()
    return data
end

local function WriteStatusFile(fields)
    local file = io.open(STATUS_PATH, "w")
    if not file then return end
    for key, value in pairs(fields) do
        file:write(string.format("%s=%s\n", key, tostring(value)))
    end
    file:close()
end

local function GetSettings()
    return FindFirstOf("DogwoodCharacterDevelopmentSettings")
end

local function GetSubsystem()
    return FindFirstOf("CharacterDevelopmentSubsystem")
end

local function GetRebelAISubsystem()
    return FindFirstOf("RebelAISubsystem")
end

-- Crash dump analysis (exception 0xC0000005, read at offset 0x230 from a near-null pointer,
-- SAME faulting instruction address both before and after this pcall wrapper was added) proved
-- pcall does NOT protect against this: it's a native access violation (a real hardware fault),
-- not a Lua error, so pcall can't catch it - the only real fix is to not touch the object at all
-- while it might be in this state (see the settle-window changes below). Kept for defense in depth.
local function SafeIsValid(object)
    if not object then return false end
    local ok, valid = pcall(function() return object:IsValid() end)
    return ok and valid == true
end

-- Two Lua proxies for the same UObject aren't guaranteed to compare equal with ==;
-- compare the underlying memory address instead.
local function SameObject(a, b)
    local okA, addrA = pcall(function() return a:GetAddress() end)
    local okB, addrB = pcall(function() return b:GetAddress() end)
    return okA and okB and addrA == addrB
end

-- CombatComponentBase is an ActorComponent; find the one attached to the local player pawn
-- rather than FindFirstOf, which could return an AI's combat component instead.
-- NOTE: an earlier version cached the resolved component across ticks to avoid rescanning, but
-- that made the bridge's poll loop silently hang after ~1 tick (holding a Lua handle to a
-- component across ticks seems to be the actual hazard, not the FindAllOf scan cost itself).
-- Re-scan fresh every tick; this is the version that ran reliably for minutes across multiple
-- respawns before that regression.
-- A full session on 2026-09-03 19:37 never printed "Combat component found for player" even
-- once in ~45s of active, non-settling gameplay (including a death) - meaning every protection
-- gated on this lookup (health lock, stamina lock, direct GAS write) silently never ran. Log the
-- first few lookups unconditionally (found or not) to see whether components are found at all,
-- and whether the player's own address ever appears among their owners.
local CombatLookupDiagLogCount = 0
local function FindOwnedComponent(className, player)
    local componentsOk, components = pcall(FindAllOf, className)
    if not componentsOk or not components then
        if className == "CombatComponentBase" and CombatLookupDiagLogCount < 5 then
            CombatLookupDiagLogCount = CombatLookupDiagLogCount + 1
            print("[DawnwalkerModBridge] FindAllOf(CombatComponentBase) failed: " .. tostring(components))
        end
        return nil
    end

    local playerAddrOk, playerAddr = pcall(function() return player:GetAddress() end)
    local matched = nil
    local validCount, ownerMatchAttempted = 0, 0
    for _, component in ipairs(components) do
        if SafeIsValid(component) then
            validCount = validCount + 1
            local ownerOk, owner = pcall(function() return component:GetOwner() end)
            if ownerOk and owner and SafeIsValid(owner) then
                ownerMatchAttempted = ownerMatchAttempted + 1
                if SameObject(owner, player) then
                    matched = component
                    break
                end
            end
        end
    end

    if className == "CombatComponentBase" and CombatLookupDiagLogCount < 5 then
        CombatLookupDiagLogCount = CombatLookupDiagLogCount + 1
        print(string.format(
            "[DawnwalkerModBridge] CombatComponentBase scan: total=%d valid=%d ownerChecked=%d matched=%s playerAddr=%s",
            #components, validCount, ownerMatchAttempted, tostring(matched ~= nil), playerAddrOk and tostring(playerAddr) or "unknown"))
    end

    return matched
end

local function GetPlayerCombatComponent(player)
    if not player or not SafeIsValid(player) then return nil end
    return FindOwnedComponent("CombatComponentBase", player)
end

-- Same pattern as combat component: CharacterMovementComponent is an ActorComponent, find the player's.
local function GetPlayerMovementComponent(player)
    if not player or not SafeIsValid(player) then return nil end
    return FindOwnedComponent("CharacterMovementComponent", player)
end

-- Same pattern again: the player's InventoryComponent (currency, carry weight).
-- NOTE: granting specific items is NOT done from Lua - FItemHandle has zero reflected properties,
-- so UE4SS Lua can't round-trip it (every grant landed a placeholder "Bee Smoker" item). Item
-- granting lives in the native DawnwalkerNativeFix C++ mod instead.
local function GetPlayerInventoryComponent(player)
    if not player or not SafeIsValid(player) then return nil end
    return FindOwnedComponent("InventoryComponent", player)
end

local function GetCameraManager()
    return FindFirstOf("PlayerCameraManager")
end

local function GetCheatManager()
    return FindFirstOf("CheatManager")
end

-- Game-instance-level singletons (one live instance each, same FindFirstOf pattern as the
-- character development subsystem). BloodBarComponent lives on the PlayerState, which only the
-- local player has in single-player, so FindFirstOf is unambiguous for it too.
local function GetTimeSystem()
    return FindFirstOf("TimeSystemImpl")
end

local function GetCombatSubsystem()
    return FindFirstOf("CombatSubsystem")
end

local function GetCraftingSubsystem()
    return FindFirstOf("CraftingSubsystem")
end

local function GetCourtSubsystem()
    return FindFirstOf("CourtSubsystem")
end

local function GetFocusAbilitiesSubsystem()
    return FindFirstOf("FocusAbilitiesSubsystem")
end

local function GetBloodBarComponent()
    return FindFirstOf("BloodBarComponent")
end

local function GetOpenWorldJournal()
    return FindFirstOf("OpenWorldJournalImpl")
end

local function GetCinematicSubsystem()
    return FindFirstOf("CinematicSubsystem")
end

local function FindValid(getter)
    local ok, object = pcall(getter)
    if ok and object and SafeIsValid(object) then return object end
    return nil
end

-- Cutscenes and dialogues swap/tear down actors (cinematic characters, cameras) under the mod's
-- feet; a crash mid-cutscene with only game frames on the stack pointed at our per-tick writes
-- landing on objects being destroyed. Both loops go fully quiet while any of these report true.
local function IsCutsceneActive(player)
    local cinematic = FindValid(GetCinematicSubsystem)
    if cinematic then
        local ok, active = pcall(function() return cinematic:IsDialogueActive() end)
        if ok and active == true then return true end
        if player then
            local inOk, inCutscene = pcall(function() return cinematic:IsCharacterInCinematicDialogueOrCutscene(player) end)
            if inOk and inCutscene == true then return true end
        end
    end
    local focus = FindValid(GetFocusAbilitiesSubsystem)
    if focus then
        local ok, mode = pcall(function() return focus:GetIsInFocusAbilityCinematicMode() end)
        if ok and mode == true then return true end
    end
    return false
end

-- Keeps the player's ability activation charges topped up via CombatFocusComponent's own
-- SetSlotsChargedOverride/ResetSlotsChargedOverride, the game's supported override for exactly
-- this - no raw GAS struct write. UnlockedActionSlots is only READ, to know how many to grant.
local function ApplyActionSlotsOverride(player, enabled)
    local focus = FindOwnedComponent("CombatFocusComponent", player)
    if not focus or not SafeIsValid(focus) then return false end

    if not enabled then
        local resetOk = pcall(function() focus:ResetSlotsChargedOverride() end)
        if resetOk then WasActionSlotsOverridden = false end
        return false
    end

    local slots = 0
    local ascOk, asc = pcall(function() return player.AbilitySystemComponent end)
    if ascOk and asc and SafeIsValid(asc) then
        if not PlayerAttributeSetClass or not SafeIsValid(PlayerAttributeSetClass) then
            local classOk, class = pcall(function()
                return StaticFindObject("/Script/DogwoodStats.PlayerAttributeSet")
            end)
            if classOk and class then PlayerAttributeSetClass = class end
        end
        if PlayerAttributeSetClass then
            local attrSetOk, attrSet = pcall(function() return asc:GetAttributeSet(PlayerAttributeSetClass) end)
            if attrSetOk and attrSet and SafeIsValid(attrSet) then
                local readOk, unlocked = pcall(function() return attrSet.UnlockedActionSlots.CurrentValue end)
                if readOk and unlocked and unlocked > 0 then slots = unlocked end
            end
        end
    end
    if slots <= 0 then slots = MAX_ACTION_SLOTS end

    local writeOk, writeErr = pcall(function() focus:SetSlotsChargedOverride(slots) end)
    if writeOk then
        WasActionSlotsOverridden = true
    elseif not ReportedActionSlotsWriteError then
        print("[DawnwalkerModBridge] SetSlotsChargedOverride failed: " .. tostring(writeErr))
        ReportedActionSlotsWriteError = true
    end
    return writeOk
end

-- Kills every combat component whose owner address is in `ownerAddresses`, using ONE FindAllOf
-- scan for all of them (rather than one scan per actor). Returns the number killed.
local function KillCombatComponentsOwnedBy(ownerAddresses, skipAddress)
    local componentsOk, components = pcall(FindAllOf, "CombatComponentBase")
    if not componentsOk or not components then return 0 end
    local killed = 0
    for _, component in ipairs(components) do
        if SafeIsValid(component) then
            local ownerOk, owner = pcall(function() return component:GetOwner() end)
            if ownerOk and owner and SafeIsValid(owner) then
                local addrOk, addr = pcall(function() return owner:GetAddress() end)
                if addrOk and addr ~= skipAddress and ownerAddresses[addr] then
                    local aliveOk, alive = pcall(function() return component:IsAlive() end)
                    if not (aliveOk and alive == false) then
                        if pcall(function() component:Kill() end) then killed = killed + 1 end
                    end
                end
            end
        end
    end
    return killed
end

-- Every item data asset class whose display names the app's catalogs need.
local ITEM_NAME_DUMP_CLASSES = {
    "ItemConsumableDataAsset",
    "ItemIngredientDataAsset",
    "ItemWeaponDataAsset",
    "ItemClothingDataAsset",
}

-- Everything this app binds to by name. A game update can rename or remove any of it, and because
-- every call site fails soft (pcall / nil checks), the symptom would otherwise be a control that
-- silently does nothing. selfCheck resolves the whole list in one pass so a patch turns into a
-- list of names instead of a debugging session.
local SELF_CHECK_CLASSES = {
    "CharacterDevelopmentSubsystem", "CombatSubsystem", "CraftingSubsystem", "CinematicSubsystem",
    "FocusAbilitiesSubsystem", "TimeSystemImpl", "BloodBarComponent", "OpenWorldJournalImpl",
    "PlayerCameraManager", "CheatManager", "RebelAISubsystem", "InventoryComponent",
    "CombatComponentBase", "CombatFocusComponent", "CharacterMovementComponent",
}

local SELF_CHECK_OBJECTS = {
    "/Script/DogwoodStats.PlayerAttributeSet",
    "/Script/DogwoodInventory.ItemHandle",
    "/Script/DogwoodInventory.Default__InventoryBlueprintFunctionLibrary",
    "/Script/DogwoodMap.Default__MappinSystemBlueprintLibrary",
    "/Script/DogwoodCombat.CombatComponentBase:SetHealthPercent",
    "/Script/DogwoodCombat.CombatComponentBase:GetHealthPercentage",
    "/Script/DogwoodCombat.CombatComponentBase:LockHealth",
    "/Script/DogwoodCombat.CombatComponentBase:LockStamina",
    "/Script/DogwoodCombat.CombatComponentBase:Kill",
    "/Script/DogwoodCombat.CombatComponentBase:IsAlive",
    "/Script/DogwoodCombat.CombatFocusComponent:SetSlotsChargedOverride",
    "/Script/DogwoodCombat.CombatFocusComponent:ResetSlotsChargedOverride",
    "/Script/DogwoodCombat.CombatSubsystem:GetAllAggressiveNPCActors",
    "/Script/DogwoodCombat.CombatSubsystem:SetActionDifficulty",
    "/Script/DogwoodInventory.CraftingSubsystem:UnlockAllCraftingRecipes",
    "/Script/DogwoodInventory.InventoryComponent:TryAddItem",
    "/Script/DogwoodInventory.InventoryComponent:TryAddAndEquipItem",
    "/Script/DogwoodInventory.InventoryComponent:RemoveItem",
    "/Script/DogwoodInventory.InventoryComponent:GetItemQuantity",
    "/Script/DogwoodInventory.InventoryComponent:GetHandleForAssetInInventory",
    "/Script/DogwoodInventory.InventoryComponent:AddCurrency",
    "/Script/DogwoodInventory.InventoryBlueprintFunctionLibrary:GetItemHandle",
    "/Script/DogwoodCharacterDevelopment.CharacterDevelopmentSubsystem:GetCurrentLevel",
    "/Script/DogwoodCharacterDevelopment.CharacterDevelopmentSubsystem:ForceLevelUpTo",
    "/Script/DogwoodCharacterDevelopment.CharacterDevelopmentSubsystem:AddQuestXP",
    "/Script/DogwoodCharacterDevelopment.CharacterDevelopmentSubsystem:UnlockAllTraits",
    "/Script/DogwoodCharacterDevelopment.CharacterDevelopmentSubsystem:AddMutationCharges",
    "/Script/DogwoodMap.MappinSystemBlueprintLibrary:DebugUnlockAllFastTravelDestinations",
    "/Script/DogwoodMap.OpenWorldJournalInterface:RevealAllMappins",
    "/Script/Engine.CheatManager:God",
    "/Script/Engine.CheatManager:Slomo",
    "/Script/Engine.CheatManager:Fly",
    "/Script/Engine.CheatManager:Teleport",
}

-- ItemName is an FText; UE4SS exposes it as either a userdata with ToString() or a plain string
-- depending on the property, so try both before giving up. The game's item string table populates
-- lazily, so an asset the UI hasn't displayed yet resolves to a missing-entry marker rather than a
-- name - treat that as unresolved and fall back to the ItemId FName.
local function ReadItemDisplayName(asset)
    local function usable(value)
        return type(value) == "string" and value ~= "" and not value:find("MISSING STRING TABLE ENTRY", 1, true)
    end
    local ok, text = pcall(function() return asset.ItemName end)
    if ok and text ~= nil then
        if usable(text) then return text end
        local strOk, str = pcall(function() return text:ToString() end)
        if strOk and usable(str) then return str end
    end
    local idOk, id = pcall(function() return asset.ItemId:ToString() end)
    if idOk and usable(id) then return id end
    return nil
end

-- Names already written to the log this session, so a repeat scan only reports what is new.
local LoggedItemNames = {}
local LoggedItemNameCount = 0
-- Latches while a menu stays open so the passive scan runs once per visit, not once per tick.
local MenuScanDone = false

-- Walks the item data assets and logs any display name not already seen. Cheap to call repeatedly
-- once the catalog is warm: the expensive part is the FindAllOf scans, and every asset whose name
-- has already been captured is skipped without touching its properties.
local function DumpNewItemNames()
    local dumped = 0
    for _, className in ipairs(ITEM_NAME_DUMP_CLASSES) do
        local listOk, assets = pcall(FindAllOf, className)
        if listOk and assets then
            for _, asset in ipairs(assets) do
                if SafeIsValid(asset) then
                    local pathOk, fullName = pcall(function() return asset:GetFullName() end)
                    if pathOk and fullName and not LoggedItemNames[fullName] then
                        local label = ReadItemDisplayName(asset)
                        if label then
                            LoggedItemNames[fullName] = true
                            LoggedItemNameCount = LoggedItemNameCount + 1
                            dumped = dumped + 1
                            print(string.format("[DawnwalkerModBridge] ItemName: %s = %s", tostring(fullName), label))
                        end
                    end
                end
            end
        end
    end
    return dumped
end

-- The item string table populates lazily, so names only resolve once the game has displayed them.
-- Menus are both when that happens and when the game has spare time, so the passive scan waits for
-- one: gameplay widgets hidden (or the HUD hidden) while a pawn exists means a full-screen UI.
local function IsMenuOpen()
    local ui = FindValid(function() return FindFirstOf("UIManagerSubsystem") end)
    if ui then
        local ok, showing = pcall(function() return ui:ShouldShowGameplayWidgets() end)
        if ok and showing == false then return true end
    end
    local hud = FindValid(function() return FindFirstOf("HUDManagerSubsystem") end)
    if hud then
        local ok, visible = pcall(function() return hud:IsHUDVisible() end)
        if ok and visible == false then return true end
    end
    return false
end

-- Collects the addresses of every actor the combat subsystem currently considers aggressive.
local function GetAggressiveNpcAddresses()
    local combatSubsystem = FindValid(GetCombatSubsystem)
    if not combatSubsystem then return nil, 0 end
    local actorsOk, actors = pcall(function() return combatSubsystem:GetAllAggressiveNPCActors() end)
    if not actorsOk or type(actors) ~= "table" then return nil, 0 end
    local addresses = {}
    local count = 0
    for _, param in ipairs(actors) do
        -- TArray elements arrive as RemoteUnrealParam wrappers (:get() yields the actor); fall
        -- back to treating the element as the actor itself if this UE4SS build differs.
        local getOk, actor = pcall(function() return param:get() end)
        if not getOk or not actor then actor = param end
        if actor and SafeIsValid(actor) then
            local addrOk, addr = pcall(function() return actor:GetAddress() end)
            if addrOk then
                addresses[addr] = true
                count = count + 1
            end
        end
    end
    return addresses, count
end

-- The game's real damage calculation was never found (see repo memory: seven separate attempts to
-- influence or hook it all failed), so this does not try to touch it. Instead it lets the game deal
-- its normal damage, then re-applies whatever health drop just happened, scaled by `multiplier` -
-- turning a normal hit into an Nx hit. Uses only GetHealthPercentage/SetHealthPercent/Kill on the
-- enemy's own combat component, the exact calls proven to work there by killAllAggressive.
-- Deliberately keyed off aggressive NPCs rather than the locked-on target: GetTargetedEnemy() was
-- confirmed not to resolve in this build, while GetAllAggressiveNPCActors() does.
local function AmplifyDamageToAggressiveNPCs(player, multiplier)
    local addresses, count = GetAggressiveNpcAddresses()
    if not addresses or count == 0 then
        if next(AmpHealth) ~= nil then AmpHealth = {} end
        return 0
    end

    local componentsOk, components = pcall(FindAllOf, "CombatComponentBase")
    if not componentsOk or not components then return 0 end

    local playerAddrOk, playerAddr = pcall(function() return player:GetAddress() end)
    local skipAddress = playerAddrOk and playerAddr or nil

    local seen = {}
    local amplified = 0
    for _, component in ipairs(components) do
        if SafeIsValid(component) then
            local ownerOk, owner = pcall(function() return component:GetOwner() end)
            if ownerOk and owner and SafeIsValid(owner) then
                local addrOk, addr = pcall(function() return owner:GetAddress() end)
                if addrOk and addr ~= skipAddress and addresses[addr] then
                    seen[addr] = true
                    local aliveOk, alive = pcall(function() return component:IsAlive() end)
                    if not (aliveOk and alive == false) then
                        local hpOk, hp = pcall(function() return component:GetHealthPercentage() end)
                        if hpOk and type(hp) == "number" then
                            local previous = AmpHealth[addr]
                            if previous and hp < previous then
                                local extra = (previous - hp) * (multiplier - 1)
                                local wanted = hp - extra
                                if wanted <= 0 then
                                    if pcall(function() component:Kill() end) then amplified = amplified + 1 end
                                    AmpHealth[addr] = nil
                                elseif pcall(function() component:SetHealthPercent(wanted) end) then
                                    AmpHealth[addr] = wanted
                                    amplified = amplified + 1
                                else
                                    AmpHealth[addr] = hp
                                end
                            else
                                -- First sighting, or healed/unchanged: just re-baseline.
                                AmpHealth[addr] = hp
                            end
                        end
                    end
                end
            end
        end
    end
    for addr in pairs(AmpHealth) do
        if not seen[addr] then AmpHealth[addr] = nil end
    end
    return amplified
end

-- Executes one one-shot action. Returns (done, result): done=false means a precondition (an
-- object not resolvable yet / pawn still settling) wasn't met and the caller should retry next
-- tick; done=true means the action is finished (successfully or not) and must not run again.
local function RunAction(name, arg, ctx)
    -- Nothing runs until the player pawn exists: game-instance subsystems are alive on the main
    -- menu/loading screen, but calling into them there is what froze the game on the load screen.
    if not ctx.player then return false, "waiting for the player to load in" end
    local n = tonumber(arg)
    if name == "grantXP" then
        if not ctx.subsystem then return false, "waiting for character development subsystem" end
        if not n or n < 1 or n > 5 then return true, "failed: reward tier out of range" end
        local ok, amount = pcall(function() return ctx.subsystem:AddQuestXP(math.floor(n)) end)
        if not ok then return true, "failed: " .. tostring(amount) end
        return true, string.format("ok: granted %s XP", tostring(amount))
    elseif name == "addTraitPoints" then
        if not ctx.subsystem then return false, "waiting for character development subsystem" end
        if not n or n < -999 or n > 999 or n == 0 then return true, "failed: amount out of range" end
        local ok, err = pcall(function() ctx.subsystem:ReceiveTraitPoints(math.floor(n)) end)
        return true, ok and string.format("ok: %+d trait points", math.floor(n)) or ("failed: " .. tostring(err))
    elseif name == "setTraitPoints" then
        if not ctx.subsystem then return false, "waiting for character development subsystem" end
        if not n or n < 0 or n > 999 then return true, "failed: amount out of range" end
        local ok, err = pcall(function() ctx.subsystem:SetTraitPointsAmount(math.floor(n)) end)
        return true, ok and string.format("ok: trait points set to %d", math.floor(n)) or ("failed: " .. tostring(err))
    elseif name == "unlockAllTraits" then
        if not ctx.subsystem then return false, "waiting for character development subsystem" end
        local ok, err = pcall(function() ctx.subsystem:UnlockAllTraits(true, true, true, false) end)
        return true, ok and "ok: all traits unlocked" or ("failed: " .. tostring(err))
    elseif name == "resetAllTraits" then
        if not ctx.subsystem then return false, "waiting for character development subsystem" end
        local ok, err = pcall(function() ctx.subsystem:ResetAllTraits() end)
        return true, ok and "ok: all traits reset" or ("failed: " .. tostring(err))
    elseif name == "addMutationCharges" then
        if not ctx.subsystem then return false, "waiting for character development subsystem" end
        if not n or n < -999 or n > 999 or n == 0 then return true, "failed: amount out of range" end
        local ok, err = pcall(function() ctx.subsystem:AddMutationCharges(math.floor(n)) end)
        return true, ok and string.format("ok: %+d mutation charges", math.floor(n)) or ("failed: " .. tostring(err))
    elseif name == "addCoins" then
        if not n or n < -999999 or n > 999999 or n == 0 then return true, "failed: amount out of range" end
        if ctx.movementSettling or not ctx.player then return false, "waiting for player to settle" end
        local inv = GetPlayerInventoryComponent(ctx.player)
        if not inv then return false, "waiting for inventory component" end
        local ok, err = pcall(function() inv:AddCurrency(0, math.floor(n)) end)
        return true, ok and string.format("ok: %+d coins", math.floor(n)) or ("failed: " .. tostring(err))
    elseif name == "unlockAllRecipes" then
        local crafting = FindValid(GetCraftingSubsystem)
        if not crafting then return false, "waiting for crafting subsystem" end
        local ok, err = pcall(function() crafting:UnlockAllCraftingRecipes() end)
        return true, ok and "ok: all crafting recipes unlocked" or ("failed: " .. tostring(err))
    elseif name == "dumpItemNames" then
        -- The app's item catalogs are keyed by asset path, which reads nothing like the in-game
        -- name. Localized names live in ItemName (an FText) on the loaded data assets, and the
        -- .locres they come from is packed inside the game's .pak - so log them from here and
        -- rebuild the catalog labels from UE4SS.log.
        local dumped = DumpNewItemNames()
        return true, string.format("ok: %d new names logged (%d this session)", dumped, LoggedItemNameCount)
    elseif name == "selfCheck" then
        local missing = {}
        local checked = 0
        for _, className in ipairs(SELF_CHECK_CLASSES) do
            checked = checked + 1
            local ok, object = pcall(FindFirstOf, className)
            if not ok or not object or not SafeIsValid(object) then
                table.insert(missing, "class " .. className)
            end
        end
        for _, objectPath in ipairs(SELF_CHECK_OBJECTS) do
            checked = checked + 1
            local ok, object = pcall(function() return StaticFindObject(objectPath) end)
            if not ok or not object then table.insert(missing, objectPath) end
        end
        for _, entry in ipairs(missing) do
            print("[DawnwalkerModBridge] SelfCheck MISSING: " .. entry)
        end
        -- Item counts are the early warning for a content patch: the catalogs are built from a
        -- snapshot of these, so a changed number means they need regenerating.
        local counts = {}
        for _, className in ipairs(ITEM_NAME_DUMP_CLASSES) do
            local listOk, assets = pcall(FindAllOf, className)
            local n = (listOk and assets) and #assets or 0
            table.insert(counts, className .. "=" .. n)
        end
        print("[DawnwalkerModBridge] SelfCheck items: " .. table.concat(counts, " "))
        print(string.format("[DawnwalkerModBridge] SelfCheck: %d checked, %d missing", checked, #missing))
        if #missing == 0 then
            return true, string.format("ok: all %d reflection targets resolved", checked)
        end
        return true, string.format("failed: %d of %d missing (%s)", #missing, checked,
            table.concat(missing, ", "):sub(1, 300))
    elseif name == "setNpcLevelOverride" then
        local level = tonumber(arg)
        if not level or level < 0 or level > 99 then return true, "failed: level out of range" end
        local libOk, lib = pcall(function()
            return StaticFindObject("/Script/DogwoodSystem.Default__DWSystemBlueprintFunctionLibrary")
        end)
        if not libOk or not lib or not SafeIsValid(lib) then
            return true, "failed: DW system library not found"
        end
        local ok, err = pcall(function() lib:SetNpcLevelOverride(ctx.player, math.floor(level)) end)
        return true, ok and string.format("ok: NPC level override set to %d", math.floor(level))
            or ("failed: " .. tostring(err))
    elseif name == "setAlertLevel" then
        local level = tonumber(arg)
        if not level or level < 0 or level > 9 then return true, "failed: alert level out of range" end
        local court = FindValid(GetCourtSubsystem)
        if not court then return false, "waiting for court subsystem" end
        local ok, err = pcall(function() court:SetAlertLevelByInt(math.floor(level)) end)
        return true, ok and string.format("ok: alert level set to %d", math.floor(level))
            or ("failed: " .. tostring(err))
    elseif name == "unlockAllFastTravel" then
        local journal = FindValid(GetOpenWorldJournal)
        if not journal then return false, "waiting for open world journal" end
        local libOk, lib = pcall(function()
            return StaticFindObject("/Script/DogwoodMap.Default__MappinSystemBlueprintLibrary")
        end)
        if not libOk or not lib or not SafeIsValid(lib) then return true, "failed: mappin library not found" end
        local ok, err = pcall(function() lib:DebugUnlockAllFastTravelDestinations(journal) end)
        return true, ok and "ok: all fast travel destinations unlocked" or ("failed: " .. tostring(err))
    elseif name == "revealAllMappins" then
        local journal = FindValid(GetOpenWorldJournal)
        if not journal then return false, "waiting for open world journal" end
        -- Interface function: not reachable via journal:RevealAllMappins(), so resolve the UFunction
        -- itself and call it with the journal as explicit context (UFunction.__call convention).
        local fnOk, fn = pcall(function()
            return StaticFindObject("/Script/DogwoodMap.OpenWorldJournalInterface:RevealAllMappins")
        end)
        if not fnOk or not fn or not SafeIsValid(fn) then return true, "failed: RevealAllMappins not found" end
        local ok, err = pcall(function() fn(journal) end)
        return true, ok and "ok: all map pins revealed" or ("failed: " .. tostring(err))
    elseif name == "killAllAggressive" then
        if ctx.combatSettling or not ctx.player then return false, "waiting for player to settle" end
        local addresses, count = GetAggressiveNpcAddresses()
        if not addresses then return false, "waiting for combat subsystem" end
        if count == 0 then return true, "ok: no aggressive enemies" end
        local playerAddrOk, playerAddr = pcall(function() return ctx.player:GetAddress() end)
        local killed = KillCombatComponentsOwnedBy(addresses, playerAddrOk and playerAddr or nil)
        return true, string.format("ok: killed %d of %d aggressive enemies", killed, count)
    elseif name == "teleport" then
        if ctx.movementSettling or not ctx.cheatManager then return false, "waiting for cheat manager" end
        local ok, err = pcall(function() ctx.cheatManager:Teleport() end)
        return true, ok and "ok: teleported to aim point" or ("failed: " .. tostring(err))
    elseif name == "setTimeOfDay" then
        local timeSystem = FindValid(GetTimeSystem)
        if not timeSystem then return false, "waiting for time system" end
        local hour, minute = tostring(arg or ""):match("^(%d+):(%d+)$")
        hour, minute = tonumber(hour), tonumber(minute)
        if not hour or not minute or hour < 0 or hour > 23 or minute < 0 or minute > 59 then
            return true, "failed: time must be HH:MM"
        end
        local ok, err = pcall(function() timeSystem:SetTime(hour, minute, 0, true) end)
        return true, ok and string.format("ok: time set to %02d:%02d", hour, minute) or ("failed: " .. tostring(err))
    elseif name == "refillBlood" then
        local bloodBar = FindValid(GetBloodBarComponent)
        if not bloodBar then return false, "waiting for blood bar component" end
        local ok, err = pcall(function() bloodBar:HealAndReplenishAllSegments() end)
        return true, ok and "ok: blood replenished" or ("failed: " .. tostring(err))
    elseif name == "healNow" then
        if ctx.combatSettling or ctx.componentSettling or not ctx.combat then return false, "waiting for combat component" end
        local ok, err = pcall(function()
            ctx.combat:SetHealthPercent(1.0)
            ctx.combat:SetStaminaPercent(1.0)
        end)
        return true, ok and "ok: health and stamina restored" or ("failed: " .. tostring(err))
    end
    return true, "failed: unknown action '" .. tostring(name) .. "'"
end

-- Multiplier-based features need the game's original value, captured once, so repeated
-- applies each poll tick don't compound (e.g. 1.5x on top of an already-doubled value).
local BaseValues = {}
local function GetBaseValue(cacheKey, object, propertyName)
    if BaseValues[cacheKey] == nil then
        local ok, value = pcall(function() return object[propertyName] end)
        if not ok or value == nil or value <= 0 then return nil end
        BaseValues[cacheKey] = value
    end
    return BaseValues[cacheKey]
end

-- Multiplier fields that were removed from command.txt (reset to defaults / preset without them)
-- must put the original value back: an absent field reads as 1x once we've ever cached a base.
local function ReadMultiplier(command, key, cacheKey, min, max)
    local raw = command[key]
    if raw == nil then
        if BaseValues[cacheKey] ~= nil then return 1 end
        return nil
    end
    local mult = tonumber(raw)
    if mult and mult >= min and mult <= max then return mult end
    return nil, "out_of_range"
end

-- A crash was observed writing to the pawn's components within ~200ms of a respawn
-- (ClientRestartPlayerController), likely because the new pawn's CombatComponentBase /
-- CharacterMovementComponent aren't fully initialized yet. When the player pawn's address
-- changes, hold off writing to per-pawn components for a few ticks and drop cached base
-- values (they belonged to the old, now-destroyed pawn).
-- Combat gets only a 1-tick gate: skipping infinite health/stamina for a full 1.5s window
-- (the original value) left the player unprotected long enough to die again right after
-- respawning, causing a death loop. Movement (speed/jump, not survival-critical) keeps a
-- longer gate since it was equally implicated in the original crash.
local LastPlayerAddress = nil
local CombatSettleTicksRemaining = 0
local MovementSettleTicksRemaining = 0
-- Separate from CombatSettleTicksRemaining (pawn-address-change based): a 2026-09-03 crash
-- landed right as the combat component itself flipped from not-found to found after an 11
-- minute gap with NO pawn address change at all (likely a loading screen/cutscene), so the
-- address-based settle window had already expired and gave zero protection. This counter
-- gates on that transition directly, whatever caused it.
local CombatComponentSettleTicksRemaining = 0
local function RefreshPawnSettleState()
    local playerOk, player = pcall(UEHelpers.GetPlayer)
    if not playerOk or not player or not SafeIsValid(player) then return nil end
    local addrOk, address = pcall(function() return player:GetAddress() end)
    if not addrOk then return player end
    if address ~= LastPlayerAddress then
        LastPlayerAddress = address
        -- Not just a write/read gate: FindOwnedComponent itself (below) is skipped entirely
        -- while settling, since even scanning/validating a freshly-spawned component crashed
        -- (a native access violation pcall can't catch) - give it several full ticks, not one.
        CombatSettleTicksRemaining = 3
        MovementSettleTicksRemaining = 6
        -- Per-pawn bases go stale with the old pawn; the camera manager survives a respawn, so
        -- its base must not be re-read from an already-multiplied FOV.
        BaseValues = { fov = BaseValues.fov }
        -- The old Source pawn for AddPlayerInvulnerability is now destroyed; force a fresh
        -- Add call against the new pawn rather than assuming the grant carried over.
        WasHealthInvulnerable = false
        -- The ASC lives on the pawn's CharacterBase too - a fresh pawn means a fresh ASC, so
        -- any previously-applied GE_Invulnerability spec handle is gone with it.
        WasGodModeApplied = false
        -- CheatManagerEnablerMod logs "Constructed CheatManager" on every respawn, meaning the
        -- native God() toggle from the old CheatManager instance doesn't carry over either.
        WasNativeGodModeApplied = false
        -- New pawn means fresh per-pawn state for the newer toggles: the movement mode
        -- (Fly/Ghost/Walk) is pawn state, the blood lock and RPG difficulty may be reset by the
        -- game on level load, and the action-slot override belongs to the old pawn's component.
        WasActionSlotsOverridden = false
        AmpHealth = {}
        LastAppliedMovementMode = nil
        LastAppliedRPGDifficulty = nil
        WasBloodLocked = false
    else
        if CombatSettleTicksRemaining > 0 then
            CombatSettleTicksRemaining = CombatSettleTicksRemaining - 1
        end
        if MovementSettleTicksRemaining > 0 then
            MovementSettleTicksRemaining = MovementSettleTicksRemaining - 1
        end
    end
    return player
end

local function ApplyCommand()
    local player = RefreshPawnSettleState()
    local combatSettling = CombatSettleTicksRemaining > 0
    local movementSettling = MovementSettleTicksRemaining > 0
    -- Game-instance subsystems exist on the loading screen/main menu long before the world does;
    -- writing to them there froze the game on the load screen once. Anything that isn't one of
    -- the original always-on singleton writes waits for the player pawn.
    local inWorld = player ~= nil and SafeIsValid(player)

    local command = ReadCommandFile()
    local status = { bridgeLoaded = 1, ok = 0, bootId = BootId }

    if not command then
        status.commandFileFound = 0
        WriteStatusFile(status)
        return
    end
    status.commandFileFound = 1

    -- Until the app acknowledges THIS boot, the file is a leftover from a previous session:
    -- apply nothing (the game stays at its defaults) and just advertise our bootId.
    if not IsHandshaken(command) then
        status.awaitingHandshake = 1
        status.ok = 1
        WriteStatusFile(status)
        return
    end

    RefreshAppConnection(command)
    status.appConnected = AppConnected and 1 or 0
    if not AppConnected then
        -- App gone: every field reads as absent, which the per-feature code below treats as
        -- "restore the game's own value" (unlock health/stamina/blood, 1x multipliers, Walk...).
        command = { bootId = command.bootId }
    end

    -- Hands off during cutscenes/dialogues (see IsCutsceneActive). Persistent settings resume on
    -- the first tick afterwards; pending one-shot actions keep waiting rather than being dropped.
    if inWorld and IsCutsceneActive(player) then
        CutsceneActive = true
        status.cutsceneActive = 1
        status.ok = 1
        status.actionResult = PendingAction and "pending: waiting for cutscene to end" or LastActionResult
        WriteStatusFile(status)
        return
    end
    if CutsceneActive then
        -- Actors were swapped/torn down during the cutscene: treat the way out like a respawn.
        CutsceneActive = false
        CombatSettleTicksRemaining = math.max(CombatSettleTicksRemaining, 3)
        MovementSettleTicksRemaining = math.max(MovementSettleTicksRemaining, 3)
        combatSettling = true
        movementSettling = true
    end
    status.cutsceneActive = 0

    -- Passive item-name capture: only while a menu is open, which is both when the game has
    -- resolved those names and when it isn't busy. Once per menu visit, not once per tick.
    if inWorld then
        local menuOpen = IsMenuOpen()
        if menuOpen and not MenuScanDone then
            MenuScanDone = true
            local found = DumpNewItemNames()
            if found > 0 then
                print(string.format("[DawnwalkerModBridge] Menu scan captured %d new item names (%d this session)",
                    found, LoggedItemNameCount))
            end
        elseif not menuOpen then
            MenuScanDone = false
        end
        status.itemNamesLogged = LoggedItemNameCount
        status.menuOpen = menuOpen and 1 or 0
    end

    local settings = GetSettings()
    if settings and SafeIsValid(settings) then
        status.settingsFound = 1
        if command.levelCap then
            local cap = tonumber(command.levelCap)
            -- Same table-bounds risk as setLevel; keep the cap within what the level tables actually cover.
            if cap and cap >= 1 and cap <= 99 then
                if OriginalLevelCap == nil then
                    local origOk, orig = pcall(function() return settings.LevelCap end)
                    if origOk and type(orig) == "number" then OriginalLevelCap = orig end
                end
                local applied = pcall(function() settings.LevelCap = math.floor(cap) end)
                status.levelCapApplied = applied and 1 or 0
            else
                status.levelCapApplied = 0
                status.levelCapRejected = "out_of_range"
            end
        elseif OriginalLevelCap ~= nil then
            -- Field removed (reset/preset): put the game's own cap back, then stop tracking it.
            if pcall(function() settings.LevelCap = OriginalLevelCap end) then OriginalLevelCap = nil end
        end
        local capOk, capValue = pcall(function() return settings.LevelCap end)
        status.levelCap = capOk and capValue or "unknown"
    else
        status.settingsFound = 0
    end

    local subsystem = GetSubsystem()
    if subsystem and SafeIsValid(subsystem) then
        status.subsystemFound = 1

        local requestId = command.requestId
        if requestId and requestId ~= LastRequestId then
            LastRequestId = requestId
            if command.setLevel then
                local level = tonumber(command.setLevel)
                -- Levels above 99 read past the end of the game's level/XP tables and crash it.
                if level and level >= 1 and level <= 99 then
                    local applied = pcall(function() subsystem:ForceLevelUpTo(math.floor(level), true) end)
                    status.setLevelApplied = applied and 1 or 0
                else
                    status.setLevelApplied = 0
                    status.setLevelRejected = "out_of_range"
                end
            end
        end

        local levelOk, level = pcall(function() return subsystem:GetCurrentLevel() end)
        local xpOk, xp = pcall(function() return subsystem:GetCurrentXP() end)
        status.currentLevel = levelOk and level or "unknown"
        status.currentXP = xpOk and xp or "unknown"
        if levelOk and type(level) == "number" then
            local reqOk, req = pcall(function() return subsystem:GetCurrentLevelXPRequirement(level) end)
            status.xpRequirement = reqOk and req or "unknown"
        end
        local tpOk, tp = pcall(function() return subsystem:GetTraitPointAmount() end)
        status.traitPoints = tpOk and tp or "unknown"
        local mcOk, mc = pcall(function() return subsystem:GetCurrentMutationCharges() end)
        status.mutationCharges = mcOk and mc or "unknown"
        local mlOk, ml = pcall(function() return subsystem:GetCurrentMutationLevel() end)
        status.mutationLevel = mlOk and ml or "unknown"
    else
        status.subsystemFound = 0
    end

    -- REVISED (2026-09-03): a crash dump landed at the exact second a fresh pawn spawned in
    -- and AddPlayerInvulnerability fired against it with zero delay - this call was previously
    -- assumed safe on the theory that touching just the pawn+RebelAI subsystem (not the
    -- per-pawn CombatComponentBase) avoided the respawn crash class, but that assumption looks
    -- wrong. Gate it behind the same combat settle window as everything else that touches a
    -- freshly-spawned pawn.
    local rebelAI = GetRebelAISubsystem()
    if not combatSettling and player and SafeIsValid(player) and rebelAI and SafeIsValid(rebelAI) then
        status.rebelAIFound = 1
        if not WasRebelAIFound then
            print("[DawnwalkerModBridge] RebelAI subsystem found")
            WasRebelAIFound = true
        end
        if command.infiniteHealth == "1" then
            if not WasHealthInvulnerable then
                local addOk, addErr = pcall(function() rebelAI:AddPlayerInvulnerability(player) end)
                if addOk then
                    WasHealthInvulnerable = true
                    print("[DawnwalkerModBridge] AddPlayerInvulnerability applied")
                elseif not ReportedAddInvulnerabilityError then
                    print("[DawnwalkerModBridge] AddPlayerInvulnerability failed: " .. tostring(addErr))
                    ReportedAddInvulnerabilityError = true
                end
            end
        else
            if WasHealthInvulnerable then
                local removeOk, removeErr = pcall(function() rebelAI:RemovePlayerInvulnerability(player) end)
                if removeOk then
                    WasHealthInvulnerable = false
                elseif not ReportedRemoveInvulnerabilityError then
                    print("[DawnwalkerModBridge] RemovePlayerInvulnerability failed: " .. tostring(removeErr))
                    ReportedRemoveInvulnerabilityError = true
                end
            end
        end
        status.healthInvulnerable = WasHealthInvulnerable and 1 or 0
    else
        status.rebelAIFound = 0
        WasRebelAIFound = false
        WasHealthInvulnerable = false
    end

    -- REAL FIX ATTEMPT #4: apply/remove the game's own GAS invulnerability effect via the
    -- player's AbilitySystemComponent. Gated behind the combat settle window since the ASC
    -- lives on the same freshly-spawned pawn as CombatComponentBase (same crash risk class).
    if not combatSettling and player and SafeIsValid(player) then
        local ascOk, asc = pcall(function() return player.AbilitySystemComponent end)
        if ascOk and asc and SafeIsValid(asc) then
            if not InvulnerabilityGEClass or not SafeIsValid(InvulnerabilityGEClass) then
                local classOk, class = pcall(function()
                    return StaticFindObject("/Game/_Dawnwalker/Combat/Effects/Persistent/GE_Invulnerability.GE_Invulnerability_C")
                end)
                if classOk and class then InvulnerabilityGEClass = class end
            end
            if InvulnerabilityGEClass then
                status.godModeClassFound = 1
                if command.infiniteHealth == "1" then
                    if not WasGodModeApplied then
                        local applyOk, applyErr = pcall(function()
                            local context = asc:MakeEffectContext()
                            local spec = asc:MakeOutgoingSpec(InvulnerabilityGEClass, 1.0, context)
                            asc:BP_ApplyGameplayEffectSpecToSelf(spec)
                        end)
                        if applyOk then
                            WasGodModeApplied = true
                            print("[DawnwalkerModBridge] GE_Invulnerability applied via ASC")
                        elseif not ReportedGodModeApplyError then
                            print("[DawnwalkerModBridge] GE_Invulnerability apply failed: " .. tostring(applyErr))
                            ReportedGodModeApplyError = true
                        end
                    end
                else
                    if WasGodModeApplied then
                        local removeOk, removeErr = pcall(function()
                            asc:RemoveActiveGameplayEffectBySourceEffect(InvulnerabilityGEClass, nil, -1)
                        end)
                        if removeOk then
                            WasGodModeApplied = false
                        elseif not ReportedGodModeRemoveError then
                            print("[DawnwalkerModBridge] GE_Invulnerability remove failed: " .. tostring(removeErr))
                            ReportedGodModeRemoveError = true
                        end
                    end
                end
            else
                status.godModeClassFound = 0
            end
        end
        status.godModeApplied = WasGodModeApplied and 1 or 0
    end

    status.combatSettling = combatSettling and 1 or 0
    -- Exposed to the one-shot action dispatcher at the end of this tick (killTarget/healNow need
    -- the player's combat component, resolved fresh this tick - never cached across ticks).
    local resolvedCombat = nil
    local resolvedComponentSettling = true
    if combatSettling then
        -- Don't even call GetPlayerCombatComponent here: FindOwnedComponent scans and calls
        -- :IsValid()/:GetOwner() on every CombatComponentBase in the world, and that scan itself
        -- is what crashed (a native access violation, not a catchable Lua error) right on the
        -- tick a freshly-spawned pawn's component was found. Skip touching combat entirely
        -- until the settle window passes.
        status.combatFound = WasCombatFound and 1 or 0
    else
        local combat = GetPlayerCombatComponent(player)
        if combat and SafeIsValid(combat) then
            if not WasCombatFound then
                print("[DawnwalkerModBridge] Combat component found for player")
                WasCombatFound = true
                CombatComponentSettleTicksRemaining = 3
            end
            status.combatFound = 1
            local componentSettling = CombatComponentSettleTicksRemaining > 0
            status.combatComponentSettling = componentSettling and 1 or 0
            resolvedCombat = combat
            resolvedComponentSettling = componentSettling
            if componentSettling then
                -- Don't touch this component at all yet: it just transitioned from not-found to
                -- found (independent of any pawn-address change, e.g. after a loading screen or
                -- cutscene), the exact same hazard class as a freshly-spawned pawn.
                CombatComponentSettleTicksRemaining = CombatComponentSettleTicksRemaining - 1
            else
            -- SetHealthPercent(1.0) alone only corrects health once per poll (1s); combat damage
            -- lands in real time and can still kill the player in the gap between polls. LockHealth
            -- freezes the stat against damage entirely, which is what actually stops death - the
            -- percent set just makes sure it's full at the moment we lock it.
            local lockHealthOk, lockHealthErr, unlockHealthOk, unlockHealthErr
            if command.infiniteHealth == "1" then
                pcall(function() combat:SetHealthPercent(1.0) end)
                lockHealthOk, lockHealthErr = pcall(function() combat:LockHealth() end)
            else
                unlockHealthOk, unlockHealthErr = pcall(function() combat:UnlockHealth() end)
            end
            local lockStaminaOk, lockStaminaErr, unlockStaminaOk, unlockStaminaErr
            if command.infiniteStamina == "1" then
                pcall(function() combat:SetStaminaPercent(1.0) end)
                lockStaminaOk, lockStaminaErr = pcall(function() combat:LockStamina() end)
            else
                unlockStaminaOk, unlockStaminaErr = pcall(function() combat:UnlockStamina() end)
            end
            -- pcall swallows native/Lua errors silently by design - log the first failure of each
            -- kind once so a broken Lock/Unlock call doesn't look identical to a working one.
            if lockHealthOk == false and not ReportedLockHealthError then
                print("[DawnwalkerModBridge] LockHealth failed: " .. tostring(lockHealthErr))
                ReportedLockHealthError = true
            end
            if unlockHealthOk == false and not ReportedUnlockHealthError then
                print("[DawnwalkerModBridge] UnlockHealth failed: " .. tostring(unlockHealthErr))
                ReportedUnlockHealthError = true
            end
            if lockStaminaOk == false and not ReportedLockStaminaError then
                print("[DawnwalkerModBridge] LockStamina failed: " .. tostring(lockStaminaErr))
                ReportedLockStaminaError = true
            end
            if unlockStaminaOk == false and not ReportedUnlockStaminaError then
                print("[DawnwalkerModBridge] UnlockStamina failed: " .. tostring(unlockStaminaErr))
                ReportedUnlockStaminaError = true
            end
            local amplifier = tonumber(command.damageAmplifier)
            if amplifier and amplifier > 1 and amplifier <= 20 then
                SharedAmplifier = amplifier
                status.damageAmplified = LastAmplifiedCount
            else
                SharedAmplifier = 1
                status.damageAmplified = 0
            end
            -- Ability activation charges: SetSlotsChargedOverride is the game's own supported
            -- override, replacing a raw ChargedActionSlots struct write.
            if command.keepActionSlotsCharged == "1" then
                status.actionSlotsCharged = ApplyActionSlotsOverride(player, true) and 1 or 0
            elseif WasActionSlotsOverridden then
                ApplyActionSlotsOverride(player, false)
                status.actionSlotsCharged = 0
            end
            status.healthLocked = (lockHealthOk == true) and 1 or 0
            status.staminaLocked = (lockStaminaOk == true) and 1 or 0
            local hpOk, hp = pcall(function() return combat:GetHealthPercentage() end)
            local stOk, st = pcall(function() return combat:GetStaminaPercentage() end)
            status.healthPercent = hpOk and hp or "unknown"
            status.staminaPercent = stOk and st or "unknown"
            end
        else
            WasCombatFound = false
            CombatComponentSettleTicksRemaining = 0
            status.combatFound = 0
        end
    end

    status.movementSettling = movementSettling and 1 or 0
    if movementSettling then
        -- Same reasoning as combat above: skip the discovery scan itself during settling.
        status.movementFound = 0
    else
        local movement = GetPlayerMovementComponent(player)
        if movement and SafeIsValid(movement) then
            status.movementFound = 1
            -- Only start tracking a base once the user has actually asked for a multiplier.
            local baseWalkSpeed = (command.speedMultiplier or BaseValues.walkSpeed) and GetBaseValue("walkSpeed", movement, "MaxWalkSpeed") or nil
            local speedMult, speedErr = ReadMultiplier(command, "speedMultiplier", "walkSpeed", 0.1, 5)
            if baseWalkSpeed and speedMult then
                -- Keep multipliers within a sane range; extreme speed can shove the player through geometry.
                local applied = pcall(function() movement.MaxWalkSpeed = baseWalkSpeed * speedMult end)
                status.speedMultiplierApplied = applied and 1 or 0
            elseif speedErr then
                status.speedMultiplierApplied = 0
                status.speedMultiplierRejected = speedErr
            end

            local baseJumpZ = (command.jumpMultiplier or BaseValues.jumpZ) and GetBaseValue("jumpZ", movement, "JumpZVelocity") or nil
            local jumpMult, jumpErr = ReadMultiplier(command, "jumpMultiplier", "jumpZ", 0.1, 5)
            if baseJumpZ and jumpMult then
                local applied = pcall(function() movement.JumpZVelocity = baseJumpZ * jumpMult end)
                status.jumpMultiplierApplied = applied and 1 or 0
            elseif jumpErr then
                status.jumpMultiplierApplied = 0
                status.jumpMultiplierRejected = jumpErr
            end
        else
            status.movementFound = 0
        end
    end

    local camera = GetCameraManager()
    if camera and SafeIsValid(camera) then
        status.cameraFound = 1
        local baseFov = (command.fovMultiplier or BaseValues.fov) and GetBaseValue("fov", camera, "DefaultFOV") or nil
        local fovMult, fovErr = ReadMultiplier(command, "fovMultiplier", "fov", 0.1, 5)
        if baseFov and fovMult then
            -- Clamp the resulting FOV itself (not just the multiplier): UE cameras get unstable well
            -- outside the ~10-170 degree range regardless of what multiplier produced it.
            local newFov = baseFov * fovMult
            if newFov >= 10 and newFov <= 170 then
                local applied = pcall(function() camera.DefaultFOV = newFov end)
                status.fovMultiplierApplied = applied and 1 or 0
            else
                status.fovMultiplierApplied = 0
                status.fovMultiplierRejected = "out_of_range"
            end
        elseif fovErr then
            status.fovMultiplierApplied = 0
            status.fovMultiplierRejected = fovErr
        end
    else
        status.cameraFound = 0
    end

    local cheatManager = GetCheatManager()
    if cheatManager and SafeIsValid(cheatManager) then
        status.cheatManagerFound = 1
        if command.gameSpeed then
            local speed = tonumber(command.gameSpeed)
            -- Slomo clamps internally, but keep our own bound too so 0/negative values can't be sent.
            if speed and speed >= 0.1 and speed <= 4 then
                local applied = pcall(function() cheatManager:Slomo(speed) end)
                status.gameSpeedApplied = applied and 1 or 0
                if applied then LastAppliedGameSpeed = speed end
            else
                status.gameSpeedApplied = 0
                status.gameSpeedRejected = "out_of_range"
            end
        elseif LastAppliedGameSpeed and LastAppliedGameSpeed ~= 1 then
            -- Field removed (reset/preset): put time dilation back to normal once.
            if pcall(function() cheatManager:Slomo(1.0) end) then LastAppliedGameSpeed = 1 end
        end

        -- REAL FIX ATTEMPT #5: native God() cheat toggle, see comment near WasNativeGodModeApplied.
        if not combatSettling then
            if command.infiniteHealth == "1" then
                if not WasNativeGodModeApplied then
                    local godOk, godErr = pcall(function() cheatManager:God() end)
                    if godOk then
                        WasNativeGodModeApplied = true
                        print("[DawnwalkerModBridge] Native God() cheat toggled on")
                    elseif not ReportedNativeGodModeError then
                        print("[DawnwalkerModBridge] Native God() cheat failed: " .. tostring(godErr))
                        ReportedNativeGodModeError = true
                    end
                end
            else
                if WasNativeGodModeApplied then
                    local godOk = pcall(function() cheatManager:God() end)
                    if godOk then
                        WasNativeGodModeApplied = false
                    end
                end
            end
        end
        status.nativeGodModeApplied = WasNativeGodModeApplied and 1 or 0

        -- Stock UE movement-mode cheats. Pawn state, so re-applied after every respawn (the
        -- LastAppliedMovementMode reset in RefreshPawnSettleState) and gated behind the movement
        -- settle window like every other write that reaches the pawn's movement component. An
        -- absent field means Walk (reset to defaults) once we've switched modes on this pawn.
        local wantedMode = command.movementMode
        if wantedMode == nil and LastAppliedMovementMode and LastAppliedMovementMode ~= "walk" then
            wantedMode = "walk"
        end
        if wantedMode and inWorld and not movementSettling then
            local mode = wantedMode
            if mode == "walk" or mode == "fly" or mode == "ghost" then
                if mode ~= LastAppliedMovementMode then
                    local modeOk, modeErr = pcall(function()
                        if mode == "fly" then cheatManager:Fly()
                        elseif mode == "ghost" then cheatManager:Ghost()
                        else cheatManager:Walk() end
                    end)
                    if modeOk then
                        LastAppliedMovementMode = mode
                    elseif not ReportedMovementModeError then
                        print("[DawnwalkerModBridge] Movement mode change failed: " .. tostring(modeErr))
                        ReportedMovementModeError = true
                    end
                end
                status.movementModeApplied = LastAppliedMovementMode or "none"
            else
                status.movementModeRejected = "unknown_mode"
            end
        end
    else
        status.cheatManagerFound = 0
    end

    -- Vampire blood bar: same Lock/SetPercent pattern that works for stamina, on the PlayerState's
    -- BloodBarComponent. Gated behind the combat settle window since it's tied to the pawn's ASC.
    local bloodBar = inWorld and FindValid(GetBloodBarComponent) or nil
    if bloodBar and not combatSettling then
        status.bloodBarFound = 1
        if command.infiniteBlood == "1" then
            pcall(function() bloodBar:SetBloodPercent(1.0) end)
            local lockOk, lockErr = pcall(function() bloodBar:LockBlood() end)
            if lockOk then
                WasBloodLocked = true
            elseif not ReportedLockBloodError then
                print("[DawnwalkerModBridge] LockBlood failed: " .. tostring(lockErr))
                ReportedLockBloodError = true
            end
        elseif WasBloodLocked then
            local unlockOk, unlockErr = pcall(function() bloodBar:UnlockBlood() end)
            if unlockOk then
                WasBloodLocked = false
            elseif not ReportedUnlockBloodError then
                print("[DawnwalkerModBridge] UnlockBlood failed: " .. tostring(unlockErr))
                ReportedUnlockBloodError = true
            end
        end
        status.bloodLocked = WasBloodLocked and 1 or 0
        local bloodOk, blood = pcall(function() return bloodBar:GetBlood() end)
        status.blood = bloodOk and blood or "unknown"
    else
        status.bloodBarFound = bloodBar and 1 or 0
    end

    -- Ability cooldowns: the subsystem exposes a debug toggle plus a getter, so this is made
    -- idempotent by only toggling when the current state differs from the requested one. Left
    -- entirely alone unless the user has set the toggle, or we disabled cooldowns earlier and the
    -- field has since been removed (reset to defaults).
    local wantCooldownsDisabled = command.noCooldowns == "1"
    local focusSubsystem = (inWorld and (command.noCooldowns ~= nil or CooldownsDisabledByUs)) and FindValid(GetFocusAbilitiesSubsystem) or nil
    if focusSubsystem then
        status.focusSubsystemFound = 1
        local enabledOk, cooldownsEnabled = pcall(function() return focusSubsystem:AreCooldownsEnabled_Debug() end)
        if enabledOk then
            if cooldownsEnabled == wantCooldownsDisabled then
                local toggleOk, toggleErr = pcall(function() focusSubsystem:ToggleDisablingAllCooldowns_Debug() end)
                if toggleOk then
                    cooldownsEnabled = not cooldownsEnabled
                elseif not ReportedCooldownToggleError then
                    print("[DawnwalkerModBridge] Cooldown toggle failed: " .. tostring(toggleErr))
                    ReportedCooldownToggleError = true
                end
            end
            CooldownsDisabledByUs = (cooldownsEnabled == false)
            status.cooldownsDisabled = cooldownsEnabled and 0 or 1
        end
    else
        status.focusSubsystemFound = 0
    end

    -- Difficulty + live combat readouts. Both setters are applied once per value change (and
    -- again after a respawn, via the LastApplied resets) rather than re-asserted every tick, so
    -- the mod never fights the game's own settings screen.
    local combatSubsystem = inWorld and FindValid(GetCombatSubsystem) or nil
    if combatSubsystem then
        status.combatSubsystemFound = 1
        if command.actionDifficulty then
            local wanted = tonumber(command.actionDifficulty)
            if wanted and wanted >= 0 and wanted <= 3 then
                wanted = math.floor(wanted)
                if LastAppliedActionDifficulty ~= wanted then
                    if OriginalActionDifficulty == nil then
                        local origOk, orig = pcall(function() return combatSubsystem:GetActionDifficultyLevel() end)
                        if origOk and type(orig) == "number" then OriginalActionDifficulty = orig end
                    end
                    if pcall(function() combatSubsystem:SetActionDifficulty(wanted) end) then
                        LastAppliedActionDifficulty = wanted
                    end
                end
            else
                status.actionDifficultyRejected = "out_of_range"
            end
        elseif LastAppliedActionDifficulty ~= nil and OriginalActionDifficulty ~= nil then
            -- Field removed (reset/preset): restore the level the game had before our first write.
            if pcall(function() combatSubsystem:SetActionDifficulty(OriginalActionDifficulty) end) then
                LastAppliedActionDifficulty = nil
            end
        end
        local currentOk, currentAction = pcall(function() return combatSubsystem:GetActionDifficultyLevel() end)
        status.actionDifficulty = currentOk and currentAction or "unknown"
        if command.rpgDifficulty then
            local wanted = tonumber(command.rpgDifficulty)
            if wanted and wanted >= 0 and wanted <= 3 then
                wanted = math.floor(wanted)
                if LastAppliedRPGDifficulty ~= wanted then
                    if pcall(function() combatSubsystem:SetRPGDifficulty(wanted) end) then
                        LastAppliedRPGDifficulty = wanted
                    end
                end
                status.rpgDifficultyApplied = LastAppliedRPGDifficulty or "none"
            else
                status.rpgDifficultyRejected = "out_of_range"
            end
        end
        local inCombatOk, inCombat = pcall(function() return combatSubsystem:GetIsInCombat() end)
        status.inCombat = (inCombatOk and inCombat) and 1 or 0
        local countOk, count = pcall(function() return combatSubsystem:GetAggressiveNpcCount() end)
        status.aggressiveNpcCount = countOk and count or "unknown"
    else
        status.combatSubsystemFound = 0
    end

    -- Inventory: coin readout + carry weight. Same per-pawn component hazard as movement, so it
    -- shares the movement settle window rather than getting a new one.
    if not movementSettling and player and SafeIsValid(player) then
        local inv = GetPlayerInventoryComponent(player)
        if inv and SafeIsValid(inv) then
            status.inventoryFound = 1
            local coinsOk, coins = pcall(function() return inv:GetCurrencyAmount(0) end)
            status.coins = coinsOk and coins or "unknown"
            local baseWeightLimit = (command.carryWeightMultiplier or BaseValues.weightLimit) and GetBaseValue("weightLimit", inv, "WeightLimit") or nil
            local weightMult, weightErr = ReadMultiplier(command, "carryWeightMultiplier", "weightLimit", 0.1, 100)
            if baseWeightLimit and weightMult then
                local applied, applyErr = pcall(function() inv.WeightLimit = baseWeightLimit * weightMult end)
                status.carryWeightApplied = applied and 1 or 0
                if not applied and not ReportedCarryWeightError then
                    print("[DawnwalkerModBridge] WeightLimit write failed: " .. tostring(applyErr))
                    ReportedCarryWeightError = true
                end
            elseif weightErr then
                status.carryWeightApplied = 0
                status.carryWeightRejected = weightErr
            end
            local weightOk, weight = pcall(function() return inv:GetCurrentWeight() end)
            local limitOk, limit = pcall(function() return inv:GetWeightLimit() end)
            status.carryWeight = weightOk and weight or "unknown"
            status.carryWeightLimit = limitOk and limit or "unknown"
        else
            status.inventoryFound = 0
        end
    end

    -- Game clock readouts (day counter, story deadline day, time of day). DayTime has reflected
    -- Hour/Minute/Second fields, so the struct return marshals to a plain Lua table.
    local timeSystem = inWorld and FindValid(GetTimeSystem) or nil
    if timeSystem then
        status.timeSystemFound = 1
        local dayOk, day = pcall(function() return timeSystem:GetCurrentDay() end)
        local goalOk, goal = pcall(function() return timeSystem:GetMainGoalDay() end)
        status.currentDay = dayOk and day or "unknown"
        status.mainGoalDay = goalOk and goal or "unknown"
        local clockOk, clock = pcall(function() return timeSystem:GetCurrentDayTime() end)
        if clockOk and type(clock) == "table" and clock.Hour ~= nil then
            status.timeOfDay = string.format("%02d:%02d", tonumber(clock.Hour) or 0, tonumber(clock.Minute) or 0)
        else
            local hoursOk, hours = pcall(function() return timeSystem:GetCurrentDayTimeAsFloat() end)
            status.dayTimeHours = hoursOk and hours or "unknown"
        end
    else
        status.timeSystemFound = 0
    end

    -- One-shot action dispatcher. Noticing the nonce and executing are deliberately decoupled:
    -- the request stays pending (retried every tick) until its preconditions are met or it
    -- times out, instead of being consumed and dropped by a settle window.
    if command.actionId and command.actionId ~= LastActionId then
        LastActionId = command.actionId
        if command.action then
            PendingAction = { id = command.actionId, name = command.action, arg = command.actionArg, ticksWaited = 0 }
            LastActionResult = "pending"
        end
    end
    if PendingAction then
        local ctx = {
            player = (player and SafeIsValid(player)) and player or nil,
            subsystem = (subsystem and SafeIsValid(subsystem)) and subsystem or nil,
            cheatManager = (cheatManager and SafeIsValid(cheatManager)) and cheatManager or nil,
            combat = resolvedCombat,
            combatSettling = combatSettling,
            componentSettling = resolvedComponentSettling,
            movementSettling = movementSettling,
        }
        local runOk, done, result = pcall(RunAction, PendingAction.name, PendingAction.arg, ctx)
        if not runOk then
            done, result = true, "error: " .. tostring(done)
        end
        if done then
            LastActionResult = result
            print(string.format("[DawnwalkerModBridge] Action %s -> %s", tostring(PendingAction.name), tostring(result)))
            PendingAction = nil
        else
            PendingAction.ticksWaited = PendingAction.ticksWaited + 1
            if PendingAction.ticksWaited >= ACTION_TIMEOUT_TICKS then
                LastActionResult = "failed: timed out (" .. tostring(result) .. ")"
                print(string.format("[DawnwalkerModBridge] Action %s timed out: %s", tostring(PendingAction.name), tostring(result)))
                PendingAction = nil
            else
                LastActionResult = "pending: " .. tostring(result)
            end
        end
    end
    status.actionResult = LastActionResult
    status.lastActionId = LastActionId or 0

    status.ok = 1
    status.lastAppliedRequestId = LastRequestId or 0
    WriteStatusFile(status)
end

RegisterConsoleCommandHandler("dwbridge_apply", function()
    pcall(ApplyCommand)
    return true
end)

-- CONFIRMED (2026-09-03) via a bare LoopAsync(1000, print-only) diagnostic mod running
-- side-by-side: the return-value convention is what the original code assumed all along -
-- "return false" keeps the loop going (it ticked 90+ times with no issue). The earlier "fires
-- once then dies" pattern was actually caused by this code returning "true" (stop) instead,
-- from an incorrect fix. Reverted to a single persistent registration with "return false".
local function StartTickLoop()
    pcall(function()
        LoopAsync(1000, function()
            local ok, err = pcall(ApplyCommand)
            if not ok then
                print("[DawnwalkerModBridge] ApplyCommand error: " .. tostring(err))
            end
            return false
        end)
    end)
end

-- REMOVED (2026-09-03): deferring the hook's own work to an async loop (setting a flag,
-- nothing else, in the hook body) did NOT stop the crash - it still landed within ~33ms of the
-- same respawn event with our hook doing nothing but a boolean write. That means the crash risk
-- is from having a 3rd native detour registered on ClientRestart at all (alongside
-- CheatManagerEnablerMod's and one other mod's own hooks on the same function), not from
-- anything our callback body does. Removed the RegisterHook call entirely; the existing 1000ms
-- StartTickLoop above still detects the pawn address change and reapplies everything, just up
-- to ~1s slower after a respawn instead of near-instant.

-- REMOVED (2026-09-03): this hook never fired for the player's own combat component in any
-- live test (only ever logged other actors' calls), so it was confirmed dead weight. With 17
-- crash dumps accumulated today (one landing at the exact timestamp of the last "death" event),
-- and this hook installed on a hot native combat-path function that fires constantly for every
-- actor in the world, it's now a crash-risk suspect with zero upside. Removed rather than kept
-- "harmless" - RegisterHook on BP_ApplyAttackDamage and its pre/post callbacks are gone.

-- Stopgap while the real damage-application entry point is still unconfirmed: a much
-- tighter dedicated poll (100ms instead of the main 1000ms tick) shrinks the death window
-- 10x. Doesn't fix a one-shot kill that exceeds max health in a single hit, but should cover
-- ordinary sustained combat damage. Kept separate from ApplyCommand/StartTickLoop so it
-- doesn't add the file-read and settings/level/camera work to this hot path.
-- The amplifier only reacts to damage the game has already dealt, so its poll interval IS the
-- delay before the bonus lands - it gets its own 100ms loop instead of riding the 1s tick.
-- Deliberately does NOT read the shared settle counters: a fast loop reading counters that only
-- the slow loop writes is exactly what caused the 2026-09-03 crash saga, so it tracks the pawn
-- address and settles itself. Reads SharedAmplifier rather than command.txt to keep file I/O off
-- this path, and skips the world scan entirely whenever nothing is hostile.
local function StartDamageAmplifierLoop()
    pcall(function()
        LoopAsync(100, function()
            local ok, err = pcall(function()
                if SharedAmplifier <= 1 then
                    if next(AmpHealth) ~= nil then AmpHealth = {} end
                    return
                end
                if CutsceneActive then return end

                local playerOk, player = pcall(UEHelpers.GetPlayer)
                if not playerOk or not player or not SafeIsValid(player) then
                    AmpLoopLastPawnAddress = nil
                    return
                end
                local addrOk, addr = pcall(function() return player:GetAddress() end)
                if not addrOk then return end
                if addr ~= AmpLoopLastPawnAddress then
                    AmpLoopLastPawnAddress = addr
                    AmpLoopSettleTicks = 30
                    if next(AmpHealth) ~= nil then AmpHealth = {} end
                    return
                end
                if AmpLoopSettleTicks > 0 then
                    AmpLoopSettleTicks = AmpLoopSettleTicks - 1
                    return
                end
                LastAmplifiedCount = AmplifyDamageToAggressiveNPCs(player, SharedAmplifier)
            end)
            if not ok then
                print("[DawnwalkerModBridge] Damage amplifier error: " .. tostring(err))
            end
            return false
        end)
    end)
end

StartTickLoop()
StartDamageAmplifierLoop()

pcall(ApplyCommand)
print("[DawnwalkerModBridge] Loaded. Watching " .. COMMAND_PATH)

