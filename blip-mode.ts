#!/usr/bin/env bun
/**
 * Which Blip runs: the bar plugin's in-shell app ("bar") or Blip Desktop, its
 * own process ("desktop"). The LAST choice wins on every start — it is state the
 * reader set with the header's mode button (or IPC `mode`), not configuration,
 * so it lives beside window.json in ~/.local/state/blip/mode.json, never in
 * bridge.conf. No file (a fresh install, an upstream user who never switched)
 * means "bar": exactly what Blip did before modes existed.
 *
 *   bun blip-mode.ts get              → {"mode":"bar"}
 *   bun blip-mode.ts set desktop      → {"mode":"desktop"}   (atomic, 0600)
 *
 * The file holds the mode and nothing else. Anything unreadable reads as "bar".
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type BlipMode = "bar" | "desktop";
export const MODES: readonly BlipMode[] = ["bar", "desktop"];
export const DEFAULT_MODE: BlipMode = "bar";

export function isMode(value: unknown): value is BlipMode {
  return value === "bar" || value === "desktop";
}

/** The saved mode from the file's text; anything else is the default. */
export function parseMode(text: unknown): BlipMode {
  if (typeof text !== "string" || text.length > 4096) return DEFAULT_MODE;
  try {
    const d = JSON.parse(text);
    return d && isMode(d.mode) ? d.mode : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export function serializeMode(mode: BlipMode): string {
  return JSON.stringify({ mode }) + "\n";
}

export function modePath(home = process.env.HOME || homedir()): string {
  const state = process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.startsWith("/")
    ? process.env.XDG_STATE_HOME : join(home, ".local", "state");
  return join(state, "blip", "mode.json");
}

export function readMode(path = modePath()): BlipMode {
  try { return parseMode(readFileSync(path, "utf8")); } catch { return DEFAULT_MODE; }
}

/** Atomic and private, like state.json: a half-written file must never be read. */
export function writeMode(mode: BlipMode, path = modePath()): void {
  const dir = path.slice(0, path.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, serializeMode(mode), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

if (import.meta.main) {
  const [action = "get", value] = process.argv.slice(2);
  if (action === "get") {
    process.stdout.write(JSON.stringify({ mode: readMode() }) + "\n");
  } else if (action === "set" && isMode(value)) {
    writeMode(value);
    process.stdout.write(JSON.stringify({ mode: value }) + "\n");
  } else {
    process.stderr.write("usage: blip-mode.ts get | set bar|desktop\n");
    process.exit(64);
  }
}
