#!/usr/bin/env bun
/**
 * Which surface Blip opens as: the bar popout ("popout", Blip as released) or
 * the app window ("window", the header's "Keep Blip as a window" toggle). The
 * LAST choice wins on every start — it is state the reader set, kept beside
 * window.json and panel.json in ~/.local/state/blip/surface.json, never a
 * bridge.conf default. No file or anything unreadable means "popout".
 *
 *   bun blip-surface.ts              → {"surface":"popout"}
 *   bun blip-surface.ts window       → {"surface":"window"}   (atomic, 0600)
 *
 * The file holds the surface and nothing else. Hardened like
 * panel-size-store.ts: the directory is ours, no symlinks are followed, the
 * file is bounded and replaced whole.
 */
import { constants as C, closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Surface = "popout" | "window";
export const DEFAULT_SURFACE: Surface = "popout";

export function isSurface(value: unknown): value is Surface {
  return value === "popout" || value === "window";
}

/** The saved surface from the file's text; anything else is the default. */
export function parseSurface(text: unknown): Surface {
  if (typeof text !== "string" || text.length > 256) return DEFAULT_SURFACE;
  try {
    const d = JSON.parse(text);
    return d && isSurface(d.surface) ? d.surface : DEFAULT_SURFACE;
  } catch {
    return DEFAULT_SURFACE;
  }
}

/** Read (no args) or set (one valid surface) the saved choice in `directory`.
 *  Returns the surface now in effect, or null when the directory is not ours. */
export function surfaceStore(directory: string, args: string[]): Surface | null {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = openSync(directory, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try {
    const base = `/proc/self/fd/${dir}`;
    if (fstatSync(dir).uid !== process.getuid!()) return null;
    if (args.length) {
      if (args.length !== 1 || !isSurface(args[0])) return null;
      const temporary = `${base}/.surface-${crypto.randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ surface: args[0] }), { flag: "wx", mode: 0o600 });
        renameSync(temporary, `${base}/surface.json`);
      } finally { try { unlinkSync(temporary); } catch {} }
      return args[0];
    }
    let fd: number;
    try { fd = openSync(`${base}/surface.json`, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK); }
    catch { return DEFAULT_SURFACE; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 256 || stat.uid !== process.getuid!()) return DEFAULT_SURFACE;
      const bytes = Buffer.alloc(257);
      const count = readSync(fd, bytes, 0, 257, 0);
      return parseSurface(bytes.subarray(0, count).toString("utf8"));
    } finally { closeSync(fd); }
  } finally { closeSync(dir); }
}

if (import.meta.main) {
  let surface: Surface | null = null;
  try { surface = surfaceStore(join(homedir(), ".local/state/blip"), process.argv.slice(2)); } catch { surface = null; }
  if (surface === null) {
    console.log("null");
    process.exit(64);
  }
  console.log(JSON.stringify({ surface }));
}
