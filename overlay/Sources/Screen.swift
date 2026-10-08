import AppKit
import CoreGraphics
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

// Coordinates: CoreGraphics window bounds use a global space with the origin at the top-left of the
// primary display ("top-left points"). AppKit uses bottom-left. Helpers below convert between them.

let terminalApps: Set<String> = ["terminal", "iterm2", "warp", "ghostty", "kitty", "alacritty", "wezterm", "hyper", "tabby", "rio", "wave"]
let maxImageDim: CGFloat = 1568 // Claude downsamples anything bigger anyway

struct WinInfo {
    let id: CGWindowID
    let app: String
    let pid: pid_t
    let title: String
    let bounds: CGRect // top-left points

    var label: String { title.isEmpty ? app : "\(app) — \"\(title)\"" }
    var isTerminal: Bool { terminalApps.contains(app.lowercased()) }
}

struct Shot {
    var jpeg: Data
    var pixelSize: CGSize
    var screenRect: CGRect // area captured, in top-left points
    var label: String
    var window: WinInfo?
    var pointer: CGPoint? // pointer position in image pixels, if inside
    var file: URL?

    /// Image-pixel point → AppKit global point.
    func screenPoint(forImagePoint p: CGPoint) -> CGPoint {
        let x = screenRect.minX + p.x * screenRect.width / pixelSize.width
        let yTop = screenRect.minY + p.y * screenRect.height / pixelSize.height
        return CGPoint(x: x, y: Geometry.primaryHeight - yTop)
    }

    /// Image-pixel rect → AppKit screen rect, for drawing highlights over the real thing.
    func screenRect(forImageRect r: CGRect) -> CGRect {
        let sx = screenRect.width / pixelSize.width, sy = screenRect.height / pixelSize.height
        let topLeft = CGRect(x: screenRect.minX + r.minX * sx, y: screenRect.minY + r.minY * sy, width: r.width * sx, height: r.height * sy)
        return Geometry.toAppKit(topLeft)
    }
}

enum CaptureError: LocalizedError {
    case permission, failed(String)
    var errorDescription: String? {
        switch self {
        case .permission:
            return "VisionCLI can't see the screen. Turn it on in System Settings → Privacy & Security → Screen & System Audio Recording, then quit and reopen VisionCLI from the menu bar."
        case .failed(let m): return m
        }
    }
}

enum Geometry {
    static var primaryHeight: CGFloat { NSScreen.screens.first?.frame.height ?? 0 }

    static func toAppKit(_ r: CGRect) -> CGRect {
        CGRect(x: r.minX, y: primaryHeight - r.maxY, width: r.width, height: r.height)
    }

    static func toTopLeft(_ r: CGRect) -> CGRect {
        CGRect(x: r.minX, y: primaryHeight - r.maxY, width: r.width, height: r.height)
    }

    static var pointer: CGPoint {
        let m = NSEvent.mouseLocation
        return CGPoint(x: m.x, y: primaryHeight - m.y)
    }
}

enum Screen {
    static var hasPermission: Bool { CGPreflightScreenCaptureAccess() }

    /// On-screen app windows, front-most first, excluding our own overlay.
    static func windows() -> [WinInfo] {
        let me = ProcessInfo.processInfo.processIdentifier
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return list.compactMap { w in
            guard (w[kCGWindowLayer as String] as? Int) == 0,
                  let id = w[kCGWindowNumber as String] as? CGWindowID,
                  let pid = w[kCGWindowOwnerPID as String] as? pid_t, pid != me,
                  let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { return nil }
            let rect = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
            guard rect.width >= 200, rect.height >= 150 else { return nil }
            return WinInfo(id: id, app: w[kCGWindowOwnerName as String] as? String ?? "", pid: pid,
                           title: w[kCGWindowName as String] as? String ?? "", bounds: rect)
        }
    }

    /// The window directly under the pointer, terminals included.
    static func rawWindowUnderPointer() -> WinInfo? {
        let p = Geometry.pointer
        return windows().first { $0.bounds.contains(p) }
    }

    /// The window under the pointer, or (if that's a terminal / nothing) the front-most non-terminal window.
    static func windowUnderPointer() -> WinInfo? {
        let p = Geometry.pointer
        let all = windows()
        if let hit = all.first(where: { $0.bounds.contains(p) }), !hit.isTerminal { return hit }
        return all.first { !$0.isTerminal }
    }

    static func capture(window w: WinInfo) throws -> Shot {
        let started = Date()
        var shot: Shot
        if let image = FastCapture.window(w.id, bounds: w.bounds) {
            shot = try makeShot(image, rect: w.bounds, label: w.label)
        } else {
            shot = try capture(args: ["-l", String(w.id)], rect: w.bounds, label: w.label)
        }
        shot.window = w
        log("capture: window in \(Int(Date().timeIntervalSince(started) * 1000))ms")
        return shot
    }

    static func capture(rect: CGRect) throws -> Shot {
        let r = rect.integral
        let label = "Selected area of " + (windows().first(where: { $0.bounds.intersects(r) })?.label ?? "Screen")
        if let image = FastCapture.area(r) { return try makeShot(image, rect: r, label: label) }
        return try capture(args: ["-R", "\(Int(r.minX)),\(Int(r.minY)),\(Int(r.width)),\(Int(r.height))"], rect: r, label: label)
    }

    /// Fallback: the `screencapture` tool (older macOS, or if ScreenCaptureKit fails).
    private static func capture(args: [String], rect: CGRect, label: String) throws -> Shot {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("visioncli-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: tmp) }
        let (status, _, err) = shell("/usr/sbin/screencapture", ["-x", "-o", "-t", "png"] + args + [tmp.path])
        if err.localizedCaseInsensitiveContains("could not create image") { throw CaptureError.permission }
        guard status == 0, let src = CGImageSourceCreateWithURL(tmp as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw CaptureError.failed("Screenshot failed: \(err.trimmingCharacters(in: .whitespacesAndNewlines))")
        }
        return try makeShot(image, rect: rect, label: label)
    }

    private static func makeShot(_ image: CGImage, rect: CGRect, label: String) throws -> Shot {
        let (jpeg, size) = try encode(image)
        var shot = Shot(jpeg: jpeg, pixelSize: size, screenRect: rect, label: label)
        let p = Geometry.pointer
        if rect.contains(p) {
            shot.pointer = CGPoint(x: ((p.x - rect.minX) / rect.width * size.width).rounded(),
                                   y: ((p.y - rect.minY) / rect.height * size.height).rounded())
        }
        return shot
    }

    /// JPEG for the `look` tool (same size and quality as voice screenshots).
    static func jpeg(_ image: CGImage) -> (Data, CGSize)? { try? encode(image) }

    /// Downscale to maxImageDim and JPEG-encode.
    private static func encode(_ image: CGImage) throws -> (Data, CGSize) {
        let w = CGFloat(image.width), h = CGFloat(image.height)
        let scale = min(1, maxImageDim / max(w, h))
        let size = CGSize(width: (w * scale).rounded(), height: (h * scale).rounded())
        guard let ctx = CGContext(data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
            throw CaptureError.failed("Couldn't resize screenshot")
        }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(origin: .zero, size: size))
        let data = NSMutableData()
        guard let scaled = ctx.makeImage(),
              let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw CaptureError.failed("Couldn't encode screenshot")
        }
        CGImageDestinationAddImage(dest, scaled, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        CGImageDestinationFinalize(dest)
        return (data as Data, size)
    }
}

// MARK: - Fast capture

/// ScreenCaptureKit (macOS 14+): captures straight into memory at the size we send (≤ maxImageDim), no helper process
/// or temporary file. Returns nil when unavailable so callers fall back to `screencapture`.
enum FastCapture {
    static func window(_ id: CGWindowID, bounds: CGRect) -> CGImage? {
        guard #available(macOS 14.0, *) else { return nil }
        return run { content in
            guard let win = content.windows.first(where: { $0.windowID == id }) else { return nil }
            let config = configuration(for: bounds.size, scale: scale(at: bounds))
            return (SCContentFilter(desktopIndependentWindow: win), config)
        }
    }

    static func area(_ rect: CGRect) -> CGImage? {
        guard #available(macOS 14.0, *) else { return nil }
        return run { content in
            // The display containing the area's centre; sourceRect is in that display's own top-left points.
            let center = CGPoint(x: rect.midX, y: rect.midY)
            guard let display = content.displays.first(where: { $0.frame.contains(center) }) ?? content.displays.first else { return nil }
            let mine = content.windows.filter { $0.owningApplication?.processID == getpid() } // never our overlays
            let config = configuration(for: rect.size, scale: scale(at: rect))
            config.sourceRect = rect.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
            return (SCContentFilter(display: display, excludingWindows: mine), config)
        }
    }

    @available(macOS 14.0, *)
    private static func configuration(for size: CGSize, scale: CGFloat) -> SCStreamConfiguration {
        let c = SCStreamConfiguration()
        let pixels = CGSize(width: size.width * scale, height: size.height * scale)
        let fit = min(1, maxImageDim / max(pixels.width, pixels.height, 1))
        c.width = max(1, Int((pixels.width * fit).rounded()))
        c.height = max(1, Int((pixels.height * fit).rounded()))
        c.showsCursor = false
        c.capturesAudio = false
        if #available(macOS 14.2, *) { c.ignoreShadowsSingleWindow = true }
        return c
    }

    /// Backing scale of the screen under a top-left rect (2 on Retina).
    private static func scale(at rect: CGRect) -> CGFloat {
        let appKit = Geometry.toAppKit(rect)
        let center = CGPoint(x: appKit.midX, y: appKit.midY)
        return (NSScreen.screens.first { $0.frame.contains(center) } ?? NSScreen.main)?.backingScaleFactor ?? 2
    }

    /// Runs the async ScreenCaptureKit calls for a synchronous caller. ScreenCaptureKit replies on its own queues, so
    /// waiting here is safe even on the main thread. Gives up after 3 s.
    @available(macOS 14.0, *)
    private static func run(_ build: @escaping (SCShareableContent) -> (SCContentFilter, SCStreamConfiguration)?) -> CGImage? {
        let done = DispatchSemaphore(value: 0)
        let box = ImageBox()
        Task.detached {
            defer { done.signal() }
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let (filter, config) = build(content) else { return }
                box.image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            } catch {
                log("capture: ScreenCaptureKit failed (\(error.localizedDescription)); using screencapture")
            }
        }
        _ = done.wait(timeout: .now() + 3)
        return box.image
    }
}

private final class ImageBox: @unchecked Sendable {
    var image: CGImage?
}
