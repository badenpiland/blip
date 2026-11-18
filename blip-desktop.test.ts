import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Blip Desktop: the same BlipService in its own Quickshell process, chosen by
// the saved mode. scripts/blip-desktop assembles and starts it; `qs` is a fake
// that records its argv, and the Omarchy shell is a fake folder.

const root = new URL("./", import.meta.url).pathname;
const script = join(root, "scripts/blip-desktop");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function run(args: string[], opts: { ipcAnswers?: boolean } = {}) {
  const { ipcAnswers = true } = opts;
  const dir = mkdtempSync(join(tmpdir(), "blip-desktop-"));
  const omarchy = join(dir, "omarchy/shell");
  mkdirSync(join(omarchy, "Commons"), { recursive: true });
  mkdirSync(join(omarchy, "Ui"), { recursive: true });
  writeFileSync(join(dir, "qs"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FIXTURE/qs-calls"
case "$*" in *"ipc call"*) ${ipcAnswers ? 'echo "app shown + focused"' : "exit 1"} ;; esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(dir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const result = Bun.spawnSync(["bash", script, ...args, "--omarchy-shell", omarchy], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FIXTURE: dir, XDG_DATA_HOME: join(dir, "data"), BLIP_PLUGIN_DIR: root },
  });
  const calls = existsSync(join(dir, "qs-calls")) ? readFileSync(join(dir, "qs-calls"), "utf8").trim().split("\n") : [];
  return { dir, omarchy, runtime: join(dir, "data/blip/desktop"), code: result.exitCode, stderr: result.stderr.toString(), calls,
           done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("blip-desktop: assemble and run Blip Desktop", () => {
  test("show assembles the config (theme links + this plugin), starts one detached instance, then shows it", () => {
    const r = run(["show"]);
    try {
      expect(r.code).toBe(0);
      expect(readlinkSync(join(r.runtime, "Commons"))).toBe(join(r.omarchy, "Commons"));
      expect(readlinkSync(join(r.runtime, "Ui"))).toBe(join(r.omarchy, "Ui"));
      expect(readlinkSync(join(r.runtime, "Blip"))).toBe(root.replace(/\/$/, ""));
      // a copy, not a link: its relative URLs resolve from the runtime folder
      expect(lstatSync(join(r.runtime, "shell.qml")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(r.runtime, "shell.qml"), "utf8")).toBe(read("desktop/shell.qml"));
      expect(r.calls).toEqual([`-p ${r.runtime} -n -d`, `-p ${r.runtime} ipc call nixfred.blip app`]);
    } finally { r.done(); }
  });
  test("start only starts", () => {
    const r = run(["start"]);
    try { expect(r.calls).toEqual([`-p ${r.runtime} -n -d`]); } finally { r.done(); }
  });
  test("a Blip Desktop that never answers is reported, not waited on forever", () => {
    const r = run(["show"], { ipcAnswers: false });
    try {
      expect(r.code).toBe(69);
      expect(r.stderr).toContain("Blip Desktop did not answer");
    } finally { r.done(); }
  });
  test("no Omarchy theme modules: refuse with the reason", () => {
    const r = run(["show"]);
    r.done();
    const dir = mkdtempSync(join(tmpdir(), "blip-desktop-noshell-"));
    try {
      const out = Bun.spawnSync(["bash", script, "start", "--omarchy-shell", join(dir, "nowhere")], {
        env: { ...process.env, XDG_DATA_HOME: join(dir, "data"), BLIP_PLUGIN_DIR: root },
      });
      expect(out.exitCode).toBe(69);
      expect(out.stderr.toString()).toContain("no Omarchy shell modules");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("an unknown action is refused", () => {
    const r = run(["bogus"]);
    try { expect(r.code).toBe(64); } finally { r.done(); }
  });
});

describe("modes: exactly one Blip owns, the last choice wins", () => {
  const service = read("BlipService.qml");
  const view = read("BlipView.qml");
  const bar = read("BarWidget.qml");
  const window = read("BlipWindow.qml");
  const shell = read("desktop/shell.qml");

  test("ownership follows the saved mode and where this copy runs", () => {
    expect(service).toContain('readonly property bool owns: leader && modeLoaded && (desktopHost ? mode === "desktop" : mode === "bar")');
    expect(service).toContain('path: root.home + "/.local/state/blip/mode.json"');
    // everything that does work is gated on owning, not merely on a screen
    for (const gate of ["active: root.owns", "running: root.owns\n    repeat: true", "running: root.owns && root.bridgeConfLoaded",
                        "enabled: root.owns && root.otpAutofill", 'path: root.owns ? root.home + "/.config/blip/allowlist.json"'])
      expect(service).toContain(gate);
  });

  test("the QML mode parser keeps blip-mode.ts's contract: only an exact mode counts", async () => {
    const { parseMode } = await import("./blip-mode");
    const fn = service.slice(service.indexOf("  function parseMode(text) {"), service.indexOf("  function applyMode("));
    const qmlParse = new Function("text", fn.replace("function parseMode(text) {", "").replace(/}\s*$/, ""));
    for (const t of ["", "{", '{"mode":"desktop"}', '{"mode":"bar"}', '{"mode":"Desktop"}', '{"mode":null}', "[]"])
      expect(qmlParse(t)).toBe(parseMode(t));
  });

  test("Blip Desktop is told where it runs before its bindings evaluate", () => {
    expect(shell).toContain('setSource(Qt.resolvedUrl("Blip/BlipService.qml"), { "desktopHost": true })');
  });

  test("the passive plugin forwards every open to Blip Desktop and starts it at login", () => {
    for (const fn of ["function showApp() {", "function ensureWindow() {", "function toggleWindow() {"]) {
      const body = service.slice(service.indexOf(fn), service.indexOf("\n  }", service.indexOf(fn)));
      expect(body).toContain('root.runDesktop("show")');
    }
    expect(service).toContain('if (root.passivePlugin) root.runDesktop("start")');
    expect(service).toContain('if (root.passivePlugin) { root.callDesktop("refresh"); return }');
    expect(service).toContain('if (root.passivePlugin) { root.callDesktop("read"); return }');
    // and still draws a badge, from the state Blip Desktop writes
    expect(service).toContain('path: root.passivePlugin ? root.home + "/.local/state/blip/state.json" : ""');
  });

  test("switching saves first, then hands over; Blip Desktop quits once it no longer owns", () => {
    const sw = service.slice(service.indexOf("function switchMode(m) {"), service.indexOf("Timer {", service.indexOf("function switchMode(m) {")));
    expect(sw.indexOf('["bun", root.modeScript, "set", m]')).toBeLessThan(sw.indexOf("runDesktop"));
    expect(sw).toContain('["omarchy-shell", root.moduleName, "switchto", "bar"]');
    expect(service).toContain('onTriggered: if (root.desktopHost && root.modeLoaded && root.mode !== "desktop") Qt.quit()');
    expect(service).toContain("function switchto(m: string): string {");
  });

  test("the header offers the switch on both surfaces, named for where it goes", () => {
    expect(view).toContain('objectName: "blipModeButton"');
    expect(view).toContain('tooltipText: root.desktopMode ? "Switch to bar mode" : "Switch to desktop mode (Blip Desktop)"');
    expect(view).toContain('hostWidget.switchMode(desktopMode ? "bar" : "desktop")');
  });

  test("in desktop mode the icon opens Blip Desktop instead of a popout", () => {
    expect(bar).toContain("readonly property bool hostsPanel: leader && service !== null && service.owns === true");
  });

  test("Blip Desktop keeps no home workspace: it stays where it is put", () => {
    expect(service).toContain("item.homeTracking = !root.desktopHost");
    expect(window).toContain("if (restoring || !homeTracking) return");
    expect(window).toContain('if (launchedHere || wasOpen) { restoreTarget = ""; prepareRestore.running = true; return }');
  });
});
