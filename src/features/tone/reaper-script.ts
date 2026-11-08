// Turns recipes into ReaScript (Lua) that REAPER runs itself. Building through
// REAPER's API instead of writing .rpp text means every plugin is created by
// REAPER with valid state, and params are set by name for any plugin that
// exposes them to the host.

import type { ToneRecipe } from "./recipe.ts";

/** Where scripts write their reports, relative to REAPER's resource path. */
export const REPORT_DIR = "Scripts/GuitarBuddy";

function lua(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")}"`;
}

function luaNumber(value: number): string {
  return Number(value.toFixed(6)).toString();
}

// Shared Lua helpers: logging, param lookup by name, and turning display
// values ("-12 dB", "1.2 kHz", "Rhythm") into normalised positions using the
// plugin's own formatting, so recipes never need to know a param's curve.
const LUA_HELPERS = `
local report = {}
local function say(line) report[#report + 1] = line end

local function writeReport(fileName)
  local dir = reaper.GetResourcePath() .. "/${REPORT_DIR}"
  reaper.RecursiveCreateDirectory(dir, 0)
  local f = io.open(dir .. "/" .. fileName, "w")
  if f then f:write(table.concat(report, "\\n"), "\\n") f:close() end
  reaper.ShowConsoleMsg(table.concat(report, "\\n") .. "\\n")
end

-- Params REAPER lists that are never tone settings.
local function isJunkParam(name)
  return name == "" or name:find("^MIDI ") or name:find("^CC ?%d") or name:find("^Reserved")
    or name:find("^Preset Previous") or name:find("^Preset Next") or name:find("^Factory Preset")
end

-- Names are compared without case, spaces or punctuation ("Dry/Wet" = "Dry / Wet").
local function key(s) return (s:lower():gsub("[^%w]", "")) end

local function findParam(track, fx, wanted)
  local target = key(wanted)
  local partial
  for p = 0, reaper.TrackFX_GetNumParams(track, fx) - 1 do
    local _, name = reaper.TrackFX_GetParamName(track, fx, p, "")
    local k = key(name)
    if k == target then return p end
    if not partial and target ~= "" and not isJunkParam(name) and k:find(target, 1, true) then partial = p end
  end
  return partial
end

-- Display string for a normalised value, without changing the param when the
-- plugin supports it.
local function fmt(track, fx, p, v)
  local ok, s = reaper.TrackFX_FormatParamValueNormalized(track, fx, p, v, "")
  if ok and s ~= "" then return s end
  reaper.TrackFX_SetParamNormalized(track, fx, p, v)
  local _, shown = reaper.TrackFX_GetFormattedParamValue(track, fx, p, "")
  return shown
end

local function squash(s) return (s:lower():gsub("%s+", "")) end

-- Number in a display string, in base units ("1.2 kHz" -> 1200, "50 ms" -> 0.05).
local function parseNum(s)
  local l = s:lower()
  if l:find("-inf", 1, true) then return -1e9 end
  if l:find("inf", 1, true) then return 1e9 end
  local start, stop = l:find("[-+]?%d*%.?%d+")
  if not start then return nil end
  local n = tonumber((l:sub(start, stop):gsub("^%+", "")))
  if not n then return nil end
  local unit = l:sub(stop + 1):match("^%s*(%a+)")
  if unit == "ms" then n = n / 1000 elseif unit and unit:sub(1, 1) == "k" then n = n * 1000 end
  return n
end

local function sampleCount(track, fx, p)
  local _, step, _, _, toggle = reaper.TrackFX_GetParameterStepSizes(track, fx, p)
  if toggle then return 1 end
  if step and step > 0 and 1 / step <= 400 then return math.floor(1 / step + 0.5) end
  return 100
end

local function resolveValue(track, fx, p, target)
  if type(target) == "number" then return target end
  local want = squash(target)
  -- Exact display match first: switches, menus and stepped knobs.
  local samples = sampleCount(track, fx, p)
  for i = 0, samples do
    if squash(fmt(track, fx, p, i / samples)) == want then return i / samples end
  end
  -- Otherwise search for the number, assuming the display rises or falls steadily.
  local t = parseNum(target)
  if not t then return nil end
  local a, b = parseNum(fmt(track, fx, p, 0)), parseNum(fmt(track, fx, p, 1))
  if not a or not b or a == b then return nil end
  local rising = b > a
  if (rising and t <= a) or (not rising and t >= a) then return 0 end
  if (rising and t >= b) or (not rising and t <= b) then return 1 end
  local lo, hi = 0, 1
  for _ = 1, 40 do
    local mid = (lo + hi) / 2
    local m = parseNum(fmt(track, fx, p, mid))
    if not m then return nil end
    if (m < t) == rising then lo = mid else hi = mid end
  end
  return (lo + hi) / 2
end
`;

export interface BuildOptions {
  /** Start a fresh project tab instead of adding tracks to the open project. */
  newProject: boolean;
  /** Save the project to this .rpp path once built (use with newProject). */
  saveAs?: string;
}

export function buildReaperScript(recipe: ToneRecipe, options: BuildOptions): string {
  const sections = recipe.sections
    .map((section) => {
      const chain = section.chain
        .map((block) => {
          const params = block.params
            .map((p) => `{ name = ${lua(p.name)}, value = ${typeof p.value === "number" ? luaNumber(p.value) : lua(p.value)} }`)
            .join(", ");
          const label = block.emulates ? `${block.kind}: ${block.emulates}` : "";
          return `      { fx = ${lua(block.plugin)}, preset = ${block.preset ? lua(block.preset) : "nil"}, label = ${lua(label)}, bypassed = ${block.bypassed ? "true" : "false"}, params = { ${params} } },`;
        })
        .join("\n");
      return `  { name = ${lua(section.name)}, playing = ${lua(section.playing ?? "")}, chain = {\n${chain}\n  } },`;
    })
    .join("\n");

  const title = `${recipe.song} - ${recipe.artist}`;
  const notes = [
    `${title}${recipe.tuning ? ` | tuning ${recipe.tuning}` : ""}`,
    ...recipe.sections.filter((s) => s.playing).map((s) => `${s.name}: ${s.playing}`),
  ].join("\n");

  return `-- Generated by Guitar Buddy: ${title.replace(/\n/g, " ")}
-- Run from REAPER: Actions > Show action list > New action > Load ReaScript.
${LUA_HELPERS}
local TITLE = ${lua(title)}
local NOTES = ${lua(notes)}
local NEW_PROJECT = ${options.newProject ? "true" : "false"}
local SAVE_AS = ${options.saveAs ? lua(options.saveAs) : "nil"}
local SECTIONS = {
${sections}
}

reaper.Undo_BeginBlock()
if NEW_PROJECT then reaper.Main_OnCommand(40859, 0) end -- New project tab (never closes open work)
say("Guitar Buddy build: " .. TITLE)

for i, section in ipairs(SECTIONS) do
  local index = reaper.CountTracks(0)
  reaper.InsertTrackAtIndex(index, true)
  local track = reaper.GetTrack(0, index)
  reaper.GetSetMediaTrackInfo_String(track, "P_NAME", TITLE .. " | " .. section.name, true)
  reaper.SetMediaTrackInfo_Value(track, "I_RECINPUT", 0) -- input 1, mono
  reaper.SetMediaTrackInfo_Value(track, "I_RECMON", 1)
  -- Arm only the first section so tones never stack on top of each other.
  reaper.SetMediaTrackInfo_Value(track, "I_RECARM", i == 1 and 1 or 0)
  say("[" .. section.name .. "]")

  for _, block in ipairs(section.chain) do
    local fx = reaper.TrackFX_AddByName(track, block.fx, false, -1)
    if fx < 0 then
      say("  MISSING plugin: " .. block.fx)
    else
      if block.preset and not reaper.TrackFX_SetPreset(track, fx, block.preset) then
        say("  preset not found: " .. block.preset .. " on " .. block.fx)
      end
      for _, param in ipairs(block.params) do
        local p = findParam(track, fx, param.name)
        local value = p and resolveValue(track, fx, p, param.value)
        if not p then
          say("  param not found: " .. param.name .. " on " .. block.fx)
        elseif not value then
          say("  value not understood: " .. param.name .. " = " .. tostring(param.value))
        else
          reaper.TrackFX_SetParamNormalized(track, fx, p, value)
          local _, shown = reaper.TrackFX_GetFormattedParamValue(track, fx, p, "")
          local _, real = reaper.TrackFX_GetParamName(track, fx, p, "")
          say("    " .. real .. " = " .. shown)
        end
      end
      if block.label ~= "" then reaper.TrackFX_SetNamedConfigParm(track, fx, "renamed_name", block.label) end
      if block.bypassed then reaper.TrackFX_SetEnabled(track, fx, false) end
      say("  ok: " .. block.fx)
    end
  end
end

local existing = reaper.GetSetProjectNotes(0, false, "")
reaper.GetSetProjectNotes(0, true, (existing ~= "" and existing .. "\\n\\n" or "") .. NOTES)
reaper.TrackList_AdjustWindows(false)
reaper.Undo_EndBlock("Guitar Buddy: " .. TITLE, -1)
if SAVE_AS then
  reaper.Main_SaveProjectEx(0, SAVE_AS, 0)
  say("Saved project: " .. SAVE_AS)
end
writeReport("last-build.txt")
`;
}

/**
 * Lists every tone parameter of the given plugins into param-probe.json with
 * its display range (shown at 0 and 1) and, for switches and menus, the
 * options, so the researcher can write values each plugin understands.
 * The temporary track is removed afterwards.
 */
export function buildParamProbeScript(fxNames: string[]): string {
  return `-- Generated by Guitar Buddy: lists plugin parameters for recipe building.
${LUA_HELPERS}
local PLUGINS = { ${fxNames.map(lua).join(", ")} }

local function json(s)
  return '"' .. s:gsub('[%c"\\\\]', function(c)
    if c == '"' then return '\\\\"' elseif c == "\\\\" then return "\\\\\\\\" end
    return string.format("\\\\u%04x", c:byte())
  end) .. '"'
end

-- Distinct display strings across the range, if there are only a few.
local function options(track, fx, p)
  local samples = math.min(sampleCount(track, fx, p), 48)
  local seen, list = {}, {}
  for i = 0, samples do
    local s = fmt(track, fx, p, i / samples)
    if not seen[s] then
      seen[s] = true
      list[#list + 1] = json(s)
      if #list > 16 then return nil end
    end
  end
  return list
end

reaper.PreventUIRefresh(1)
local index = reaper.CountTracks(0)
reaper.InsertTrackAtIndex(index, false)
local track = reaper.GetTrack(0, index)
local out = {}
for _, name in ipairs(PLUGINS) do
  local fx = reaper.TrackFX_AddByName(track, name, false, -1)
  if fx < 0 then
    say("MISSING " .. name)
  else
    local params = {}
    for p = 0, reaper.TrackFX_GetNumParams(track, fx) - 1 do
      local _, pname = reaper.TrackFX_GetParamName(track, fx, p, "")
      if not isJunkParam(pname) then
        local value = reaper.TrackFX_GetParamNormalized(track, fx, p)
        local _, shown = reaper.TrackFX_GetFormattedParamValue(track, fx, p, "")
        local opts = options(track, fx, p)
        local extra = opts and (',"options":[' .. table.concat(opts, ",") .. "]")
          or string.format(',"min":%s,"max":%s', json(fmt(track, fx, p, 0)), json(fmt(track, fx, p, 1)))
        reaper.TrackFX_SetParamNormalized(track, fx, p, value)
        params[#params + 1] = string.format('{"index":%d,"name":%s,"value":%.4f,"shown":%s%s}', p, json(pname), value, json(shown), extra)
      end
    end
    local _, presetCount = reaper.TrackFX_GetPresetIndex(track, fx)
    out[#out + 1] = string.format('{"fx":%s,"presets":%d,"params":[%s]}', json(name), presetCount or 0, table.concat(params, ","))
    say("ok " .. name .. " (" .. #params .. " params)")
    reaper.TrackFX_Delete(track, fx)
  end
end
reaper.DeleteTrack(track)
reaper.PreventUIRefresh(-1)

local dir = reaper.GetResourcePath() .. "/${REPORT_DIR}"
reaper.RecursiveCreateDirectory(dir, 0)
local f = io.open(dir .. "/param-probe.json", "w")
if f then f:write("[", table.concat(out, ","), "]") f:close() end
writeReport("last-probe.txt")
`;
}
