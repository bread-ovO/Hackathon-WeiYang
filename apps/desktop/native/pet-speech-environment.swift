import AppKit
import CoreGraphics

// Metadata only: no window names, images, Accessibility APIs or permission prompts.
func probe() -> [String: Any] {
    guard let front = NSWorkspace.shared.frontmostApplication,
          let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
          !NSScreen.screens.isEmpty else { return ["available": false, "fullscreen": true] }
    let displays = NSScreen.screens.compactMap { screen -> CGRect? in
        guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
        return CGDisplayBounds(CGDirectDisplayID(number.uint32Value))
    }
    guard !displays.isEmpty else { return ["available": false, "fullscreen": true] }
    var found = false
    for info in windows {
        guard let owner = info[kCGWindowOwnerPID as String] as? NSNumber,
              owner.int32Value == front.processIdentifier,
              let layer = info[kCGWindowLayer as String] as? NSNumber, layer.intValue == 0,
              let raw = info[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: raw), bounds.width > 1, bounds.height > 1 else { continue }
        found = true
        if displays.contains(where: { display in
            abs(bounds.minX - display.minX) <= 2 && abs(bounds.minY - display.minY) <= 2 &&
            abs(bounds.maxX - display.maxX) <= 2 && abs(bounds.maxY - display.maxY) <= 2
        }) { return ["available": true, "fullscreen": true] }
    }
    // No inspectable front window is unknown, never an assertion of no fullscreen app.
    return ["available": found, "fullscreen": !found]
}
let result = probe()
if let bytes = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
   let text = String(data: bytes, encoding: .utf8) { print(text) }
else { print("{\"available\":false,\"fullscreen\":true}") }
