import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

struct PermissionState: Codable {
    let accessibility: Bool
    let screenCapture: Bool
}

struct PointerSample: Codable {
    let x: Double
    let y: Double
    let buttons: Int
    let foregroundApp: String
    let isWindowMoving: Bool
    let scrollDelta: Double
    let timestampMs: Int64
}

final class ScrollAccumulator {
    private let lock = NSLock()
    private var value: Double = 0

    func add(_ delta: Double) {
        lock.lock()
        value += delta
        lock.unlock()
    }

    func take() -> Double {
        lock.lock()
        let current = value
        value = 0
        lock.unlock()
        return current
    }
}

func accessibilityTrusted(prompt: Bool) -> Bool {
    let options = [
        kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt
    ] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
}

func screenCaptureTrusted(request: Bool) -> Bool {
    if CGPreflightScreenCaptureAccess() {
        return true
    }
    return request ? CGRequestScreenCaptureAccess() : false
}

func emit<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(value) else {
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

func pressedButtons() -> Int {
    var mask = 0
    if CGEventSource.buttonState(.combinedSessionState, button: .left) { mask |= 1 }
    if CGEventSource.buttonState(.combinedSessionState, button: .right) { mask |= 2 }
    if CGEventSource.buttonState(.combinedSessionState, button: .center) { mask |= 4 }
    return mask
}

func streamPointer() {
    guard accessibilityTrusted(prompt: true) else {
        fputs("Magic Pointer requires macOS Accessibility permission.\n", stderr)
        exit(3)
    }

    let scroll = ScrollAccumulator()
    let monitor = NSEvent.addGlobalMonitorForEvents(matching: [.scrollWheel]) { event in
        scroll.add(event.scrollingDeltaY)
    }
    defer {
        if let monitor { NSEvent.removeMonitor(monitor) }
    }

    while true {
        autoreleasepool {
            let point = NSEvent.mouseLocation
            let appId = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
                ?? NSWorkspace.shared.frontmostApplication?.localizedName
                ?? ""
            emit(PointerSample(
                x: point.x,
                y: point.y,
                buttons: pressedButtons(),
                foregroundApp: appId,
                isWindowMoving: false,
                scrollDelta: scroll.take(),
                timestampMs: Int64(Date().timeIntervalSince1970 * 1000)
            ))
        }
        Thread.sleep(forTimeInterval: 0.035)
    }
}

let arguments = Set(CommandLine.arguments.dropFirst())
if arguments.contains("--check-permissions") {
    emit(PermissionState(
        accessibility: accessibilityTrusted(prompt: false),
        screenCapture: screenCaptureTrusted(request: false)
    ))
} else if arguments.contains("--request-permissions") {
    emit(PermissionState(
        accessibility: accessibilityTrusted(prompt: true),
        screenCapture: screenCaptureTrusted(request: true)
    ))
} else {
    streamPointer()
}
