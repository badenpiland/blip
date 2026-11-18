#!/usr/bin/env bun
/** Prepare a restored window, and send it back to its last workspace after a remap. */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// Lua quoted strings use decimal escapes, unlike JSON's Unicode escapes.
export function luaString(value: string): string {
  return '"' + Array.from(Buffer.from(value), b => `\\${String(b).padStart(3, "0")}`).join("") + '"';
}

export function workspaceSelector(value: unknown): string | null {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value)) return null;
  if (/^[1-9][0-9]*$/.test(value) || value === "special" || value.startsWith("special:")) return value;
  return "name:" + value;
}

export function isLiveBlipTitle(title: unknown): boolean {
  return typeof title === "string" && /^Blip( \([0-9]+\))?$/.test(title);
}

export function windowAddress(value: unknown): string | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) ? value : null;
}

export type WorkspaceReason = "move" | "map" | "report" | "monitor";

/** User moves become the new home. A remap or monitor churn is a stray. */
export function workspaceDecision(saved: unknown, incoming: unknown, reason: WorkspaceReason): "save" | "return" | "ignore" {
  const next = typeof incoming === "string" ? incoming : "";
  const home = typeof saved === "string" ? saved : "";
  if (!next || /[\x00-\x1f\x7f]/.test(next)) return "ignore";
  // An empty home is claimed by a DELIBERATE move only. Claiming it on a map
  // made wherever the window happened to land its home for good, which with a
  // stale compositor rule (they outlive the plugin, only a reload clears them)
  // meant Super+M opened the app on a workspace the reader was not on, every
  // time (2026-09-19).
  if (!home) return reason === "move" ? "save" : "ignore";
  if (next === home) return "ignore";
  if (reason === "move") return "save";
  if (reason === "map" || reason === "monitor") return "return";
  return "ignore";
}

export function restoreRule(workspace: unknown, title: string): string {
  if (!/^Blip-restore-[a-f0-9-]+$/.test(title)) throw new Error("Invalid restore title");
  const target = workspaceSelector(workspace);
  return `hl.window_rule({ name = "blip-session-restore", match = { class = "^org\\\\.quickshell$", title = "^${title}$" }, no_initial_focus = true${target ? `, workspace = ${luaString(target + " silent")}` : ""} })`;
}

const HOME_MATCH = `match = { class = ${luaString("^org\\.quickshell$")}, title = ${luaString("^Blip( \\([0-9]+\\))?$")} }`;

/**
 * The standing rule that keeps every new Blip window on its HOME workspace —
 * Blip's default behaviour. Hyprland 0.56 MERGES a rule declared again under
 * the same name into the existing one (probed 2026-11-18: re-declaring without
 * `workspace` left the old workspace in force), so installing always says
 * `enabled = true` explicitly, and only clearHomeRule() turns it off.
 * No target: nothing to pin to, so the rule is turned off instead.
 */
export function homeRule(workspace: unknown): string {
  const target = workspaceSelector(workspace);
  if (!target) return clearHomeRule();
  return `hl.window_rule({ name = "blip-session-home", enabled = true, ${HOME_MATCH}, no_initial_focus = true, workspace = ${luaString(target + " silent")} })`;
}

/** Turn the home rule off (window_workspace=current). `enabled = false` is the
 *  one re-declaration that disables a named rule on 0.56 (probed 2026-11-18). */
export function clearHomeRule(): string {
  return `hl.window_rule({ name = "blip-session-home", enabled = false, ${HOME_MATCH} })`;
}

/**
 * The compositor rules a restore installs, in order: a ONE-SHOT rule matching
 * only this window's unique restore title (open quietly on its workspace, or
 * where the reader is when there is none), then the home rule. By default the
 * home rule is kept on the restored workspace, as Blip always did. With
 * `keepHome` false (window_workspace=current) it is turned OFF: a standing home
 * rule sent every later launch to that workspace, and with a home the reader no
 * longer visited the window vanished the moment they looked away (field report,
 * 2026-11-18).
 */
export function prepareRules(workspace: unknown, title: string, keepHome = true): string[] {
  const restore = restoreRule(workspace, title);
  if (!keepHome) return [restore, clearHomeRule()];
  return workspaceSelector(workspace) ? [restore, homeRule(workspace)] : [restore];
}

export function silentMove(workspace: unknown, address: unknown): string | null {
  const target = workspaceSelector(workspace);
  const addr = windowAddress(address);
  if (!target || !addr) return null;
  return `hl.dsp.window.move({ workspace = ${luaString(target)}, follow = false, window = ${luaString("address:" + addr)} })`;
}

/**
 * Does that workspace still exist? A home saved by name or id can outlive the
 * workspace itself: an empty workspace disappears, and a compactor like plonk
 * renumbers the ones that remain. Restoring onto a dead id does not find the
 * old place, it CREATES a workspace and drags the reader to it, which on
 * 2026-09-19 looked like the window opening, flying off, resizing and vanishing
 * (it then got renumbered under the window). Unknown or unreadable: treat as
 * alive, so a hyprctl hiccup cannot silently drop a real home.
 */
export function workspaceLives(workspace: unknown, live: unknown): boolean {
  const target = typeof workspace === "string" ? workspace : "";
  if (!target) return false;
  if (!Array.isArray(live)) return true;
  return live.some((w: any) => String(w?.name ?? "") === target || String(w?.id ?? "") === target);
}

/**
 * Is any real output connected? A display that drops off DisplayPort when it
 * sleeps leaves Hyprland with no monitors, and moving a window to a workspace
 * then segfaults Hyprland 0.56 (null monitor in moveWindowToWorkspace,
 * 2026-10-02). Unknown or unreadable: treat as none, so a stray return waits
 * for the monitor to come back instead of taking the session down.
 */
export function hasRealMonitor(monitors: unknown): boolean {
  if (!Array.isArray(monitors)) return false;
  return monitors.some((m: any) => typeof m?.name === "string" && m.name !== "" && m.name !== "FALLBACK"
    && m.disabled !== true && Number(m.width) > 0 && Number(m.height) > 0);
}

/**
 * May a floating window be moved onto that workspace right now? Hyprland 0.56
 * dereferences the target workspace's monitor when moving a floating window,
 * and a workspace whose output vanished keeps a null monitor until the output
 * returns (reproduced in a nested Hyprland, 2026-10-03). So: a real output
 * must exist, and an existing target must sit on one of them. A target that
 * does not exist yet is created on a live output. Unknown state: no.
 */
export function moveIsSafe(workspace: unknown, monitors: unknown, workspaces: unknown): boolean {
  if (!hasRealMonitor(monitors) || !Array.isArray(workspaces)) return false;
  const target = typeof workspace === "string" ? workspace : "";
  if (!target) return false;
  const names = new Set((monitors as any[]).filter(m => hasRealMonitor([m])).map(m => String(m.name)));
  const ws = workspaces.find((w: any) => String(w?.name ?? "") === target || String(w?.id ?? "") === target);
  return !ws || names.has(String((ws as any).monitor ?? ""));
}

function liveMonitors(): unknown {
  const result = spawnSync("hyprctl", ["monitors", "-j"], { encoding: "utf8", timeout: 3000 });
  if (result.status !== 0) return null;
  try { return JSON.parse(String(result.stdout)); } catch { return null; }
}

function liveWorkspaces(): unknown {
  const result = spawnSync("hyprctl", ["workspaces", "-j"], { encoding: "utf8", timeout: 3000 });
  if (result.status !== 0) return null;
  try { return JSON.parse(String(result.stdout)); } catch { return null; }
}

function hyprEval(lua: string): boolean {
  const result = spawnSync("hyprctl", ["eval", lua], { encoding: "utf8", timeout: 3000 });
  return result.status === 0 && /^ok\s*$/.test(result.stdout);
}

function hyprDispatch(lua: string): boolean {
  const result = spawnSync("hyprctl", ["dispatch", lua], { encoding: "utf8", timeout: 3000 });
  return result.status === 0;
}

if (import.meta.main) {
  const keepHome = !process.argv.includes("--no-home");
  const args = process.argv.filter(a => a !== "--no-home");
  const action = args[2] || "prepare";
  if (action === "home") {
    if (!hyprEval(homeRule(args[3]))) {
      console.error("Blip could not keep the window on its workspace");
      process.exit(1);
    }
    process.exit(0);
  }
  if (action === "clear") {
    if (!hyprEval(clearHomeRule())) {
      console.error("Blip could not clear its workspace rule");
      process.exit(1);
    }
    process.exit(0);
  }
  if (action === "return") {
    // No output, no move: the next monitoradded sends the window back.
    const workspaces = liveWorkspaces();
    if (!moveIsSafe(args[3], liveMonitors(), workspaces)) process.exit(0);
    // A workspace that is gone stays gone: moving there would CREATE it, and a
    // recreated named workspace the reader cannot reach is the window
    // "vanishing" through the remap door. The window stays where it mapped.
    if (!workspaceLives(args[3], workspaces)) process.exit(0);
    const lua = silentMove(args[3], args[4]);
    if (!lua || !hyprDispatch(lua)) {
      console.error("Blip could not return the window to its workspace");
      process.exit(1);
    }
    process.exit(0);
  }

  const asked = action === "prepare" ? (args[3] ?? "") : action;
  // A last workspace that no longer exists is gone. Opening here beats creating it.
  const workspace = workspaceSelector(asked) && !workspaceLives(asked, liveWorkspaces()) ? "" : asked;
  const title = `Blip-restore-${randomUUID()}`;
  const [restore, home] = prepareRules(workspace, title, keepHome);
  if (!hyprEval(restore)) {
    console.error("Blip could not prepare quiet window restoration");
    process.exit(1);
  }
  if (home && !hyprEval(home)) {
    console.error("Blip could not set its workspace rule");
    process.exit(1);
  }
  console.log(JSON.stringify({ title }));
}
