import AppKit
// Test fixture owns this blank window. Probe output never contains other window metadata.
final class Fixture: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    let previous = NSWorkspace.shared.frontmostApplication
    var failed = false
    func sample(_ phase: String, expected: Bool) {
        let process = Process(), pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: CommandLine.arguments[1])
        process.standardOutput = pipe
        do {
            try process.run(); process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let result = try JSONSerialization.jsonObject(with: data) as? [String: Bool]
            let passed = result?["available"] == true && result?["fullscreen"] == expected
            print("\(phase): \(passed ? "PASS" : "FAIL") \(String(data: data, encoding: .utf8) ?? "invalid")")
            if !passed { failed = true }
        } catch { failed = true; print("\(phase): FAIL") }
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 300, y: 300, width: 640, height: 480), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "BUGU synthetic fullscreen probe"
        window.delegate = self
        window.collectionBehavior = [.fullScreenPrimary]
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.sample("windowed", expected: false); self.window.toggleFullScreen(nil) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { self.failed = true; self.finish() }
    }
    func windowDidEnterFullScreen(_ notification: Notification) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.sample("fullscreen", expected: true); self.window.toggleFullScreen(nil) }
    }
    func windowDidExitFullScreen(_ notification: Notification) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.sample("restored", expected: false); self.finish() }
    }
    func finish() { window?.orderOut(nil); previous?.activate(options: [.activateIgnoringOtherApps]); exit(failed ? 1 : 0) }
}
let app = NSApplication.shared
let fixture = Fixture()
app.setActivationPolicy(.regular)
app.delegate = fixture
app.run()
