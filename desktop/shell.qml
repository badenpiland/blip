import QtQuick
import Quickshell

// Blip Desktop — Blip as its own app process (mode "desktop").
//
// scripts/blip-desktop copies this file into a runtime config folder
// ($XDG_DATA_HOME/blip/desktop) beside two links, Commons and Ui, to the
// running Omarchy shell's theme and UI modules — so Blip Desktop wears the
// Omarchy theme exactly like the bar plugin does — and starts it with
// `qs -p <that folder> -n -d` and BLIP_PLUGIN_DIR set to this plugin.
//
// The plugin is loaded from its REAL path, outside this config folder, the
// way the Omarchy shell loads plugins. Reaching it through a link inside the
// folder does not work: Quickshell's scanner builds the folder's module index
// without following linked directories, so Blip's own types (BlipAppearance,
// OtpAutofill) were "not a type" (omadell, 2026-11-18).
//
// The app is the SAME BlipService the bar plugin hosts, told it lives here
// (`desktopHost`). Because this process is not the shell, omarchy-restart-shell
// and plugin updates leave the window alone, and Blip Desktop needs none of the
// in-shell window's home-workspace bookkeeping: it stays where the reader put
// it (spike on omadell, 2026-11-18: shell restart and DPMS off/on both left a
// separate qs window on its workspace).
ShellRoot {
  Loader {
    // setSource with initial properties: `desktopHost` must be set before the
    // service's bindings first evaluate, or it would briefly act as the plugin.
    Component.onCompleted: {
      var dir = String(Quickshell.env("BLIP_PLUGIN_DIR") || "")
      if (dir.charAt(0) !== "/") {
        console.error("Blip Desktop: BLIP_PLUGIN_DIR is not set; start it with scripts/blip-desktop")
        return
      }
      setSource("file://" + encodeURI(dir.replace(/\/+$/, "")) + "/BlipService.qml", { "desktopHost": true })
    }
  }
}
