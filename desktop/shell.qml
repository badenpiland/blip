import QtQuick
import Quickshell

// Blip Desktop — Blip as its own app process (mode "desktop").
//
// scripts/blip-desktop copies this file into a runtime config folder
// ($XDG_DATA_HOME/blip/desktop) beside three links: Commons and Ui to the
// running Omarchy shell's theme and UI modules (so Blip Desktop wears the
// Omarchy theme exactly like the bar plugin does), and Blip to this plugin.
// It then runs `qs -p <that folder> -n -d`: one instance, detached.
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
    Component.onCompleted: setSource(Qt.resolvedUrl("Blip/BlipService.qml"), { "desktopHost": true })
  }
}
