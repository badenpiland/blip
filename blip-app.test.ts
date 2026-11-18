import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/blip-app is what the app launcher's "Blip" entry runs: focus the
// Blip window, or ask the plugin to open it (IPC `app`). Every external action
// is intercepted: hyprctl, omarchy-shell and notify-send are fakes.

const root = new URL("./", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const script = new URL("./scripts/blip-app", root).pathname;

const impostors = [
  { class: "codex", title: "Blip plugin missing", address: "0x11" },
  { class: "chromium", title: "Blip", address: "0x12" },
  { class: "org.quickshell", title: "Blip documentation", address: "0x13" },
];

/** Run blip-app against a fake Hyprland. `appears` = the window maps once
 *  the plugin is asked for it; `shellOk` = omarchy-shell reaches the target. */
function run(args: string[], opts: { title?: string | null; focused?: boolean; appears?: boolean; shellOk?: boolean } = {}) {
  const { title = null, focused = false, appears = true, shellOk = true } = opts;
  const dir = mkdtempSync(join(tmpdir(), "blip-app-"));
  try {
    const client = { class: "org.quickshell", title: title ?? "Blip", address: "0x20" };
    writeFileSync(join(dir, "clients.json"), JSON.stringify([...impostors, ...(title ? [client] : [])]));
    writeFileSync(join(dir, "after.json"), JSON.stringify([...impostors, ...(appears ? [client] : [])]));
    writeFileSync(join(dir, "active.json"), JSON.stringify(focused ? client : impostors[0]));
    writeFileSync(join(dir, "hyprctl"), `#!/bin/sh
case "$1" in
  clients) if [ -e "$FIXTURE/asked" ]; then cat "$FIXTURE/after.json"; else cat "$FIXTURE/clients.json"; fi ;;
  activewindow) cat "$FIXTURE/active.json" ;;
  dispatch) printf '%s\\n' "$2" >> "$FIXTURE/actions" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(dir, "omarchy-shell"), shellOk
      ? '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIXTURE/actions"; touch "$FIXTURE/asked"; echo "app shown + focused"\n'
      : '#!/bin/sh\necho "No target nixfred.blip" >&2; exit 1\n', { mode: 0o755 });
    writeFileSync(join(dir, "notify-send"), '#!/bin/sh\nprintf "notify %s\\n" "$*" >> "$FIXTURE/actions"\n', { mode: 0o755 });
    writeFileSync(join(dir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(dir, "actions"), "");
    const result = Bun.spawnSync(["bash", script, ...args], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FIXTURE: dir },
    });
    return {
      code: result.exitCode,
      stderr: result.stderr.toString(),
      actions: readFileSync(join(dir, "actions"), "utf8").trim().split("\n").filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("blip-app: launch Blip like an app", () => {
  for (const title of ["Blip", "Blip (3)"]) {
    test(`focuses an existing ${title} window, never an impostor`, () => {
      const r = run([], { title });
      expect(r.code).toBe(0);
      expect(r.actions).toEqual(['hl.dsp.focus({ window = "address:0x20" })']);
    });
    test(`a launcher click never closes the focused ${title} window`, () => {
      expect(run([], { title, focused: true }).actions).toEqual(['hl.dsp.focus({ window = "address:0x20" })']);
    });
    test(`--toggle closes the focused ${title} window (the SUPER+M behaviour)`, () => {
      expect(run(["--toggle"], { title, focused: true }).actions).toEqual(['hl.dsp.window.close({ window = "address:0x20" })']);
    });
  }
  test("no window: asks the plugin for the app, then focuses what maps", () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.actions).toEqual(["nixfred.blip app", 'hl.dsp.focus({ window = "address:0x20" })']);
  });
  test("a window that never maps: no impostor is focused, and the reader is told why", () => {
    // the stale-IPC trap: the plugin answered from a dead instance after an update
    const r = run([], { appears: false });
    expect(r.code).toBe(69);
    expect(r.actions[0]).toBe("nixfred.blip app");
    expect(r.actions.length).toBe(2);
    expect(r.actions[1]).toStartWith("notify --app-name=Blip -- Blip Blip did not open its window.");
    expect(r.stderr).toContain("omarchy-restart-shell");
  });
  test("a shell without Blip says so, out loud", () => {
    const r = run([], { shellOk: false });
    expect(r.code).toBe(69);
    expect(r.stderr).toContain("Blip is not running in the Omarchy shell");
    expect(r.actions.length).toBe(1);
    expect(r.actions[0]).toStartWith("notify --app-name=Blip -- Blip ");
  });
  test("an unknown option is refused", () => {
    expect(run(["--bogus"]).code).toBe(64);
  });
});

describe("the launcher entry", () => {
  test("runs blip-app and wears Blip's own icon; setup installs both", () => {
    const entry = read("share/blip.desktop.in");
    expect(entry).toContain("Exec=@BLIP_APP@");
    expect(entry).toContain("Icon=blip");
    expect(entry).toContain("StartupNotify=false");
    expect(read("share/blip.svg")).toContain("#0a84ff");
    const setup = read("scripts/blip-setup");
    expect(setup).toContain('install -m 0755 "$here/scripts/blip-app" "$bin_dir/blip-app"');
    expect(setup).toContain('sed "s|@BLIP_APP@|$bin_dir/blip-app|"');
  });
});
