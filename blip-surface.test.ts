import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SURFACE, parseSurface, surfaceStore } from "./blip-surface";

describe("blip surface: the last choice wins, the popout when there is none", () => {
  test("no file, junk or an unknown surface all read as popout (Blip as released)", () => {
    expect(DEFAULT_SURFACE).toBe("popout");
    for (const text of [undefined, "", "{", "null", "[]", '{"surface":"Window"}', '{"surface":"tray"}', '{"surface":1}', "x".repeat(300)])
      expect(parseSurface(text as any)).toBe("popout");
    const dir = mkdtempSync(join(tmpdir(), "blip-surface-"));
    expect(surfaceStore(dir, [])).toBe("popout");
  });

  test("a saved choice round-trips, privately and whole", () => {
    const dir = mkdtempSync(join(tmpdir(), "blip-surface-"));
    expect(surfaceStore(dir, ["window"])).toBe("window");
    expect(surfaceStore(dir, [])).toBe("window");
    expect(statSync(join(dir, "surface.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "surface.json"), "utf8")).toBe('{"surface":"window"}');
    expect(surfaceStore(dir, ["popout"])).toBe("popout");
    expect(surfaceStore(dir, [])).toBe("popout");
  });

  test("refuses anything but one valid surface, and never follows a symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "blip-surface-"));
    expect(surfaceStore(dir, ["tray"])).toBeNull();
    expect(surfaceStore(dir, ["window", "popout"])).toBeNull();
    const elsewhere = join(mkdtempSync(join(tmpdir(), "blip-surface-target-")), "x.json");
    writeFileSync(elsewhere, '{"surface":"window"}');
    symlinkSync(elsewhere, join(dir, "surface.json"));
    expect(surfaceStore(dir, [])).toBe("popout");
  });

  test("the CLI prints the surface in effect and refuses junk", () => {
    const home = mkdtempSync(join(tmpdir(), "blip-surface-cli-"));
    const run = (...a: string[]) => Bun.spawnSync(["bun", new URL("./blip-surface.ts", import.meta.url).pathname, ...a], { env: { ...process.env, HOME: home } });
    expect(run().stdout.toString()).toBe('{"surface":"popout"}\n');
    expect(run("window").stdout.toString()).toBe('{"surface":"window"}\n');
    expect(run().stdout.toString()).toBe('{"surface":"window"}\n');
    expect(run("tray").exitCode).toBe(64);
  });
});
