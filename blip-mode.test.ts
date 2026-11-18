import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODE, modePath, parseMode, readMode, serializeMode, writeMode } from "./blip-mode";

describe("blip mode: the last choice wins, bar when there is none", () => {
  test("no file, junk or an unknown mode all read as bar (what Blip did before modes)", () => {
    expect(DEFAULT_MODE).toBe("bar");
    for (const text of [undefined, "", "{", "null", "[]", '{"mode":"Desktop"}', '{"mode":"tray"}', '{"mode":1}', "x".repeat(5000)])
      expect(parseMode(text as any)).toBe("bar");
    expect(readMode(join(tmpdir(), "blip-mode-missing", "mode.json"))).toBe("bar");
  });

  test("a saved choice round-trips", () => {
    for (const mode of ["bar", "desktop"] as const) expect(parseMode(serializeMode(mode))).toBe(mode);
  });

  test("writes are private and replace the file whole", () => {
    const dir = mkdtempSync(join(tmpdir(), "blip-mode-"));
    const path = join(dir, "state", "blip", "mode.json");
    writeMode("desktop", path);
    expect(readMode(path)).toBe("desktop");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writeMode("bar", path);
    expect(readFileSync(path, "utf8")).toBe('{"mode":"bar"}\n');
  });

  test("lives beside window.json in Blip's state folder, honouring XDG_STATE_HOME", () => {
    const saved = process.env.XDG_STATE_HOME;
    try {
      delete process.env.XDG_STATE_HOME;
      expect(modePath("/home/u")).toBe("/home/u/.local/state/blip/mode.json");
      process.env.XDG_STATE_HOME = "/x/state";
      expect(modePath("/home/u")).toBe("/x/state/blip/mode.json");
      process.env.XDG_STATE_HOME = "relative";        // not absolute: ignored, as the spec says
      expect(modePath("/home/u")).toBe("/home/u/.local/state/blip/mode.json");
    } finally {
      if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved;
    }
  });

  test("the CLI sets and gets, and refuses anything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "blip-mode-cli-"));
    const env = { ...process.env, HOME: dir, XDG_STATE_HOME: "" };
    const run = (...a: string[]) => Bun.spawnSync(["bun", new URL("./blip-mode.ts", import.meta.url).pathname, ...a], { env });
    expect(run("get").stdout.toString()).toBe('{"mode":"bar"}\n');
    expect(run("set", "desktop").exitCode).toBe(0);
    expect(run("get").stdout.toString()).toBe('{"mode":"desktop"}\n');
    expect(run("set", "tray").exitCode).toBe(64);
    expect(readFileSync(join(dir, ".local/state/blip/mode.json"), "utf8")).toBe('{"mode":"desktop"}\n');
  });
});
