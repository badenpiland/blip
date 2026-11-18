import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "ScreenLeader.mjs" as ScreenLeader
import "BlipServiceRegistry.js" as BlipServiceRegistry

// blip — the bar icon, a feature of the Blip app.
//
// The app is BlipService.qml: an Omarchy service that owns the poller, the
// push watcher, the read ledger, toasts, IPC and the app window, whether or
// not this icon is on a bar. This widget is a VIEW of it: the badge, the
// popout panel and the clicks. It runs no collector of its own.
//
// Left-click = panel · double-click = the app window · middle-click = refresh · right-click = mark all read.
BarWidget {
  id: root
  moduleName: "nixfred.blip"

  // The service, through the plugin's own scoped shell facade (the trusted
  // built-in bar hands a third-party widget one that can reach its OWN
  // service and nothing else). Null under a replacement bar, which gets a
  // service-less facade, or before the service has loaded. serviceFor() is a
  // plain call, not a notifying property, and the shell may build the bar
  // before it loads services, so the lookup retries until it answers.
  // Under a replacement bar the facade never answers; the service's own
  // registration (BlipServiceRegistry.js) is the fallback.
  property var service: null
  function resolveService() {
    var s = bar && bar.shell && typeof bar.shell.serviceFor === "function"
      ? bar.shell.serviceFor(root.moduleName) : null
    if (!s) s = BlipServiceRegistry.get()
    if (s !== root.service) root.service = s || null
  }
  Timer {
    interval: 500
    repeat: true
    running: root.service === null
    triggeredOnStart: true
    onTriggered: root.resolveService()
  }

  // Every value the badge draws comes from the service; with none, the icon
  // shows the "bridge offline" glyph and says why in its tooltip.
  readonly property bool online: service ? service.online === true : false
  readonly property int unread: service ? Number(service.unread) || 0 : 0
  readonly property bool hasUnread: unread > 0

  // ---- one popout per session (war room #0): Omarchy builds one bar — and
  // therefore one of these widgets — PER SCREEN. The widget on the first real
  // screen owns the panel and registers itself as the service's panelHost; the
  // others hand clicks to it, re-anchored to the clicked bar's button.
  // QsWindow.window is still null when a freshly built bar completes its
  // widgets — on a hotplug every screen's widget therefore saw `!ownScreen`
  // and claimed the crown for the few hundred ms until the window resolved.
  // With one screen that default is right; with several it must be the
  // opposite, so an unresolved widget waits instead of racing. With NO real
  // screen nobody leads (screen-leader.ts).
  readonly property var ownScreen: QsWindow.window ? QsWindow.window.screen : null
  readonly property bool leader: ScreenLeader.isLeader(ownScreen, Quickshell.screens)
  // Bar mode only: in desktop mode Blip Desktop is the app, and a click on
  // the icon opens it instead of a popout (BlipService.passivePlugin).
  readonly property bool hostsPanel: leader && service !== null && service.owns === true
  onHostsPanelChanged: syncRegistration()
  onServiceChanged: { syncRegistration(); injectPanel() }
  Component.onCompleted: syncRegistration()
  Component.onDestruction: if (service) service.unregisterPanelHost(root)
  function syncRegistration() {
    if (!service) return
    if (hostsPanel) service.registerPanelHost(root)
    else service.unregisterPanelHost(root)
  }
  /** The panelHost widget's popout, for whichever widget asks. */
  readonly property var panelItem: panelLoader.item
  readonly property var host: service ? service.panelHost : null

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // Omarchy's panel hotkeys (`omarchy-shell shell toggle nixfred.blip`,
  // SUPER+CTRL+<n> by bar position) find a bar widget's panel through open(),
  // close() AND this property — without it the shell logs "summon: no live
  // bar widget" and does nothing. Same line as Omarchy's clock widget.
  readonly property bool opened: host && host.panelItem ? host.panelItem.opened === true : false
  // Omarchy picks the copy on the FOCUSED screen for a hotkey, and only the
  // panel host owns a panel: every copy goes through it, re-anchored to the
  // asked-for screen.
  function open() { if (host) host.openOn(root.ownScreen ? String(root.ownScreen.name) : "") }
  function close() { if (host) host.closePanel() }
  function toggle() { if (host) host.toggleOn(root.ownScreen ? String(root.ownScreen.name) : "") }
  property alias anchorButton: button
  // The panel exists only on the host, so a click on another screen's bar
  // re-anchors it to the clicked bar's button (the popout takes its screen
  // from its anchor) or it always opens on the host's screen. Empty/unknown
  // screen anchors to this widget's own button.
  function widgetOnScreen(name) {
    var list = root.bar && typeof root.bar.moduleWidgets === "function" ? root.bar.moduleWidgets(root.moduleName) : []
    for (var i = 0; i < list.length; i++) {
      var s = list[i] ? list[i].ownScreen : null
      if (s && list[i].anchorButton && String(s.name) === String(name)) return list[i]
    }
    return root
  }
  function anchorPanel(p, screenName) {
    var w = root.widgetOnScreen(screenName)
    p.bar = w.bar
    p.anchorItem = w.anchorButton
  }
  // These three run on the panel host only (service.panelHost).
  function closePanel() { if (panelLoader.item) panelLoader.item.close() }
  function toggleOn(screenName) {
    var p = panelLoader.item
    if (!p) return
    if (!p.opened) root.anchorPanel(p, screenName)
    p.toggle()
  }
  // Open-only sibling of toggleOn: a hotkey that means "open" must never close
  // a panel that is already up. An open panel stays where it is.
  function openOn(screenName) {
    var p = panelLoader.item
    if (!p) return
    if (!p.opened) root.anchorPanel(p, screenName)
    p.open()
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    target.bar = root.bar
    target.anchorItem = button
    target.barOwner = root
    target.hostWidget = root.service
  }
  onBarChanged: { resolveService(); injectPanel() }

  Loader {
    id: panelLoader
    active: root.hostsPanel
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  // Single click = panel (opens immediately — no double-click lag); a second
  // click within the double-click window = close the panel and open the APP.
  Timer { id: dblClick; interval: 320 }
  function leftClick() {
    if (!service) return
    if (dblClick.running) {
      dblClick.stop()
      service.showApp()
      return
    }
    dblClick.restart()
    service.toggleOn(root.ownScreen ? String(root.ownScreen.name) : "")
  }

  // ------------------------------------------------------------ bar button
  function tooltip() {
    if (!service) return "Blip is not running — the Blip service did not load. Restart the shell (omarchy-restart-shell)."
    var parts = []
    if (!service.online) parts.push("Mac unreachable — iMessage bridge offline")
    else if (service.unread === 0) parts.push("No unread messages")
    else parts.push(service.unread + " unread")

    if (service.online && service.unread > 0) {
      var hot = service.threads.filter(function(t){ return t.unread > 0 }).slice(0, 4)
      for (var i = 0; i < hot.length; i++)
        parts.push("  " + hot[i].name + " (" + hot[i].unread + ")")
    }
    if (service.online && !service.healthy && service.lastError !== "") parts.push("⚠ " + service.lastError)
    if (service.passivePlugin) return parts.join("\n") + "\nclick: Blip Desktop · middle: refresh · right: mark all read"
    return parts.join("\n") + "\nclick: threads · double-click: app · middle: refresh · right: mark all read"
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: ""
    hasVisualContent: true
    labelVisible: false
    keepSpace: true
    fixedWidth: content.implicitWidth + Style.spaceReal(horizontalMargin) * 2
    dimmed: !root.online
    active: root.hasUnread
    useActiveColor: false
    tooltipText: root.tooltip()
    onPressed: function(code) {
      if (!root.service) return
      // Any screen's icon talks to the one service directly: there is exactly
      // one collector, so a refresh here can no longer race another (Astra #10).
      if (code === Qt.MiddleButton) root.service.refresh(root.service.anySurfaceOpen(), false)
      else if (code === Qt.RightButton) root.service.markAllRead()
      else root.leftClick()
    }

    Row {
      id: content
      anchors.centerIn: parent
      spacing: Style.spaceReal(4)

      // Stock bar icons are drawn by OpticalGlyph, which scales the glyph's ink (not
      // its em box) to Style.bar.iconSize. As plain body-size text the speech bubble
      // sat visibly smaller than its neighbours, because Nerd Font glyphs carry
      // padding inside the em (#153, Jason Meller). OpticalGlyph only has paintedSize
      // from Omarchy 4.5: on 4.0.2 a file that assigns it does not compile, which
      // took the whole widget off the bar. So the optical glyph is its own file
      // behind a Loader. Where that file cannot compile the Loader reports Error
      // (one warning in the shell log) and the plain text below draws the same glyph
      // at body size, as it did before.
      Item {
        id: glyphSlot
        anchors.verticalCenter: parent.verticalCenter
        readonly property bool optical: opticalGlyph.status === Loader.Ready
        width: optical ? Style.bar.iconCanvas : plainGlyph.implicitWidth
        height: optical ? Style.bar.iconCanvas : plainGlyph.implicitHeight

        Loader {
          id: opticalGlyph
          anchors.fill: parent
          Component.onCompleted: setSource("OpticalBarGlyph.qml", {
            "text": Qt.binding(function() { return root.glyphText }),
            "fontFamily": Qt.binding(function() { return button.fontFamily }),
            "fontSize": Qt.binding(function() { return button.fontSize }),
            "color": Qt.binding(function() { return root.hasUnread ? root.blipAccent : button.foreground })
          })
        }
        Text {
          id: plainGlyph
          anchors.verticalCenter: parent.verticalCenter
          visible: !glyphSlot.optical
          text: root.glyphText
          textFormat: Text.PlainText
          color: root.hasUnread ? root.blipAccent : button.foreground
          font.family: button.fontFamily
          font.pixelSize: Style.font.body
          renderType: Text.NativeRendering
        }
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: root.online && root.unread > 0
        text: root.unread > 99 ? "99+" : root.unread
        textFormat: Text.PlainText
        color: root.blipAccent
        font.family: button.fontFamily
        font.pixelSize: Style.font.bodySmall
        font.bold: true
        renderType: Text.NativeRendering
      }
    }
  }

  // iMessage blue, always. The unread dot and the lit glyph are Blip's signal,
  // and the signal is "blue bubbles" — not whatever this theme uses for accent
  // (several Omarchy themes use red, which must stay reserved for alerts, and a
  // red dot on a messaging icon reads as an error). Fred, 2.3.3: "should ALWAYS
  // be BLUE no matter what."
  readonly property color blipAccent: "#0a84ff"
  // Nerd Font: filled speech bubble when unread, outline when quiet, slashed when
  // the bridge is down.
  readonly property string glyphText: !root.online ? "󰻞" : (root.hasUnread ? "󰭹" : "󰭻")
}
