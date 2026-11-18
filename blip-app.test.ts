import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Blip as an app: the plugin declares a SERVICE that owns the poller and the
// window (BlipService.qml), the bar icon is an optional view of it, and
// scripts/blip-app is what the app launcher's entry runs. Every external
// action is intercepted: hyprctl, omarchy-shell and notify-send are fakes.

const root = new URL("./", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const script = new URL("./scripts/blip-app", root).pathname;

const impostors = [
  { class: "codex", title: "Blip plugin missing", address: "0x11" },
  { class: "chromium", title: "Blip", address: "0x12" },
  { class: "org.quickshell", title: "Blip documentation", address: "0x13" },
];

/** Run blip-app against a fake Hyprland. `appears` = the window maps once
 *  the service is asked for it; `shellOk` = omarchy-shell reaches the target. */
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
  test("no window: asks the service for the app, then focuses what maps", () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.actions).toEqual(["nixfred.blip app", 'hl.dsp.focus({ window = "address:0x20" })']);
  });
  test("a window that never maps is not replaced by focusing an impostor", () => {
    expect(run([], { appears: false }).actions).toEqual(["nixfred.blip app"]);
  });
  test("a shell without the Blip service says so, out loud", () => {
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

describe("the app is a service; the bar icon is a view of it", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const service = read("BlipService.qml");
  const bar = read("BarWidget.qml");
  const panel = read("Panel.qml");

  test("manifest declares the service, kept loaded, beside the bar widget", () => {
    expect(manifest.kinds).toEqual(["service", "bar-widget"]);
    expect(manifest.entryPoints).toEqual({ service: "BlipService.qml", barWidget: "BarWidget.qml" });
    // keepLoaded: a plugin hot-reload must not tear down the window, the
    // poller or the IPC target (the "IPC on a zombie" trap in CLAUDE.md).
    expect(manifest.keepLoaded).toBe(true);
  });

  test("the service owns the poller, watcher, IPC and window; the icon none of them", () => {
    for (const owned of ["id: collector", "id: watchProc", "id: bridgeProc", "IpcHandler {", "id: windowLoader", "id: notifyProc"]) {
      expect(service).toContain(owned);
      expect(bar).not.toContain(owned);
    }
    expect(service).not.toContain("BarWidget {");
    expect(service).not.toContain("import qs.Ui");
  });

  test("the icon finds its OWN service through the scoped facade, and retries", () => {
    expect(bar).toContain("bar.shell.serviceFor(root.moduleName)");
    expect(bar).toContain("running: root.service === null");
  });

  test("under a replacement bar (service-less facade) the icon falls back to the service's registration", () => {
    const registry = read("BlipServiceRegistry.js");
    expect(registry.split("\n")[0]).toBe(".pragma library");   // one shared instance per engine
    expect(service).toContain('import "BlipServiceRegistry.js" as BlipServiceRegistry');
    expect(service).toContain("Component.onCompleted: BlipServiceRegistry.register(root)");
    expect(service).toContain("Component.onDestruction: BlipServiceRegistry.unregister(root)");
    expect(bar).toContain('import "BlipServiceRegistry.js" as BlipServiceRegistry');
    // facade first, registry only when the facade has nothing
    const resolve = bar.slice(bar.indexOf("function resolveService()"), bar.indexOf("Timer {", bar.indexOf("function resolveService()")));
    expect(resolve.indexOf("serviceFor(root.moduleName)")).toBeLessThan(resolve.indexOf("BlipServiceRegistry.get()"));
    // the registry forgets only the instance that registered
    const mod: any = {};
    new Function("exports", registry.replace(".pragma library", "") + ";exports.r=register;exports.u=unregister;exports.g=get;")(mod);
    const a = {}, b = {};
    mod.r(a); mod.u(b); expect(mod.g()).toBe(a);
    mod.r(b); mod.u(a); expect(mod.g()).toBe(b);
    mod.u(b); expect(mod.g()).toBe(null);
  });

  test("setup keeps the service enabled without the icon: a plugins[] entry, added once", () => {
    const setup = read("scripts/blip-setup");
    expect(setup).toContain(`jq -e '(.plugins // []) | any(.id? == "nixfred.blip")'`);
    expect(setup).toContain(`.plugins = ((.plugins // []) + [{"id": "nixfred.blip"}])`);
  });

  test("one widget hosts the popout, registered with the service and released on destruction", () => {
    expect(bar).toContain("readonly property bool hostsPanel: leader && service !== null");
    expect(bar).toContain("if (hostsPanel) service.registerPanelHost(root)");
    expect(bar).toContain("Component.onDestruction: if (service) service.unregisterPanelHost(root)");
    expect(service).toContain("function unregisterPanelHost(w) { if (root.panelHost === w) root.panelHost = null }");
  });

  test("the popout takes data from the service and its bar identity from the widget", () => {
    expect(bar).toContain("target.hostWidget = root.service");
    expect(bar).toContain("target.barOwner = root");
    expect(panel).toContain("readonly property var barIdentity: barOwner || root");
  });

  test("with no bar icon, opening Blip means the app window", () => {
    const open = service.slice(service.indexOf("  function open() {"), service.indexOf("  function toggleOn("));
    expect(open).toContain("if (root.panelHost) root.panelHost.openOn(\"\")");
    expect(open).toContain("else root.showApp()");
  });

  test("the launcher entry runs blip-app and wears Blip's own icon", () => {
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
