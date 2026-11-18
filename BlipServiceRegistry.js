.pragma library

// Where the bar icon finds the Blip service when Omarchy's facade cannot.
//
// The trusted built-in bar hands a widget a facade whose serviceFor(ownId)
// returns its own service. A REPLACEMENT bar (a cloned bar plugin, e.g.
// `bhp.bar`) only gets a service-less facade, so the icon there could never
// reach the app and sat dimmed. `.pragma library` makes this file one shared
// instance per QML engine and URL: BlipService.qml and BarWidget.qml import it
// from the same plugin directory, so they see the same `current`.
//
// No new capability: Omarchy's own docs say its facades are API boundaries,
// not a sandbox — plugins share the shell process and its file/process access.
//
// After a plugin HOT-RELOAD the engine may compile a fresh instance of this
// file for the reloaded icon while the kept-loaded service registered in the
// old one; the icon then dims until omarchy-restart-shell, which every deploy
// needs anyway (CLAUDE.md).

var current = null

function register(service) { current = service }
function unregister(service) { if (current === service) current = null }
function get() { return current }
