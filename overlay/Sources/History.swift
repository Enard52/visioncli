import AppKit
import ImageIO
import SwiftUI

struct HistoryEntry: Codable, Identifiable {
    var id = UUID()
    let date: Date
    let project: String
    let question: String
    var answer: String
    let screenshots: [String]
}

final class HistoryStore: ObservableObject {
    @Published private(set) var entries: [HistoryEntry] = []
    private let file = supportDir.appendingPathComponent("history.jsonl")
    let shotsDir = supportDir.appendingPathComponent("screenshots")
    private let keep = 200 // per project, so a busy project doesn't push out the others
    /// Screenshots of all projects together: older than this, or past this total size (oldest go first), are deleted.
    private let shotsMaxAge: TimeInterval = 30 * 24 * 3600
    private let shotsMaxBytes = 300 * 1024 * 1024
    /// Disk writes and deletes, in order, off the main thread.
    private let io = DispatchQueue(label: "visioncli.history", qos: .utility)

    init() {
        try? FileManager.default.createDirectory(at: shotsDir, withIntermediateDirectories: true)
        load()
        pruneShots()
    }

    /// Save screenshots for an entry and return their paths (also referenced in the question sent to Claude). The
    /// paths are returned right away and the files written in the background; `waitForWrites()` waits for them.
    func save(_ shots: [Shot]) -> [Shot] {
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        return shots.enumerated().map { i, shot in
            var s = shot
            let url = shotsDir.appendingPathComponent("\(stamp)-\(i + 1).jpg")
            let jpeg = shot.jpeg
            io.async {
                do { try jpeg.write(to: url) } catch { log("history: can't save \(url.lastPathComponent): \(error.localizedDescription)") }
            }
            s.file = url
            return s
        }
    }

    /// Blocks until the screenshots (and history) queued so far are on disk.
    func waitForWrites() { io.sync {} }

    func add(_ e: HistoryEntry) {
        entries.insert(e, at: 0)
        defer { pruneShots() }
        let same = entries.filter { $0.project == e.project }
        if same.count > keep {
            let dropped = Set(same[keep...].map(\.id))
            remove(same[keep...].flatMap(\.screenshots))
            entries.removeAll { dropped.contains($0.id) }
            persistAll()
        } else if let data = try? encoder.encode(e) {
            append(data + Data([0x0A]))
        }
    }

    /// Clear everything, or one project's history.
    func clear(project: String? = nil) {
        let gone = entries.filter { project == nil || $0.project == project }
        remove(gone.flatMap(\.screenshots))
        if let project {
            entries.removeAll { $0.project == project }
            persistAll()
        } else {
            entries = []
            let file = file
            io.async { try? FileManager.default.removeItem(at: file) }
        }
    }

    private func remove(_ paths: [String]) {
        guard !paths.isEmpty else { return }
        io.async { paths.forEach { try? FileManager.default.removeItem(atPath: $0) } }
    }

    /// Deletes screenshots past the age or total-size cap, oldest first, in the background.
    private func pruneShots() {
        let dir = shotsDir, maxAge = shotsMaxAge, maxBytes = shotsMaxBytes
        io.async {
            let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey]
            guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys) else { return }
            var shots: [(url: URL, date: Date, size: Int)] = files.compactMap { url in
                guard let v = try? url.resourceValues(forKeys: Set(keys)), v.isRegularFile == true else { return nil }
                return (url, v.contentModificationDate ?? .distantPast, v.fileSize ?? 0)
            }
            shots.sort { $0.date < $1.date }
            var total = shots.reduce(0) { $0 + $1.size }
            let cutoff = Date().addingTimeInterval(-maxAge)
            var removed = 0
            for shot in shots where shot.date < cutoff || total > maxBytes {
                guard (try? FileManager.default.removeItem(at: shot.url)) != nil else { continue }
                total -= shot.size
                removed += 1
            }
            if removed > 0 { log("history: pruned \(removed) old screenshot(s)") }
        }
    }

    private let encoder: JSONEncoder = { let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; return e }()
    private let decoder: JSONDecoder = { let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d }()

    private func load() {
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return }
        entries = text.split(separator: "\n").compactMap { try? decoder.decode(HistoryEntry.self, from: Data($0.utf8)) }.reversed()
    }

    private func persistAll() {
        let data = entries.reversed().compactMap { try? encoder.encode($0) }.reduce(Data()) { $0 + $1 + Data([0x0A]) }
        let file = file
        io.async { try? data.write(to: file) }
    }

    private func append(_ data: Data) {
        let file = file
        io.async {
            if let h = try? FileHandle(forWritingTo: file) {
                h.seekToEndOfFile()
                h.write(data)
                try? h.close()
            } else {
                try? data.write(to: file)
            }
        }
    }
}

/// Which project the History window shows ("" = all). Opening History selects the current project.
final class HistoryFilter: ObservableObject {
    @Published var project = ""
}

struct HistoryView: View {
    @ObservedObject var store: HistoryStore
    @ObservedObject var filter: HistoryFilter
    @State private var query = ""

    /// Projects with history, most recently used first.
    var projects: [String] {
        var seen = Set<String>()
        return store.entries.sorted { $0.date > $1.date }.map(\.project).filter { seen.insert($0).inserted }
    }

    var filtered: [HistoryEntry] {
        store.entries.filter { e in
            (filter.project.isEmpty || e.project == filter.project)
                && (query.isEmpty || "\(e.question) \(e.answer) \(e.project)".localizedCaseInsensitiveContains(query))
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search questions and answers", text: $query).textFieldStyle(.plain)
                Spacer()
                Picker("", selection: $filter.project) {
                    Text("All Projects").tag("")
                    ForEach(projects, id: \.self) { p in Text((p as NSString).lastPathComponent).tag(p) }
                }
                .frame(maxWidth: 200)
                Button(filter.project.isEmpty ? "Clear History" : "Clear Project") { store.clear(project: filter.project.isEmpty ? nil : filter.project) }
                    .disabled(filtered.isEmpty)
            }
            .padding(12)
            Divider()
            if filtered.isEmpty {
                Spacer()
                Text(store.entries.isEmpty ? "No questions yet. Hold ⌥ and ask about your screen." : "No matches")
                    .foregroundStyle(.secondary)
                Spacer()
            } else {
                List(filtered) { e in
                    HStack(alignment: .top, spacing: 12) {
                        if let first = e.screenshots.first {
                            HistoryThumbnail(path: first)
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(e.question).font(.headline).lineLimit(2)
                                Spacer()
                                Text(e.date, style: .relative).font(.caption).foregroundStyle(.secondary)
                            }
                            if filter.project.isEmpty {
                                Text((e.project as NSString).lastPathComponent).font(.caption).foregroundStyle(.secondary)
                            }
                            Text(Markup.display(e.answer)).font(.body).textSelection(.enabled)
                            HStack {
                                Button("Copy") {
                                    NSPasteboard.general.clearContents()
                                    NSPasteboard.general.setString(Markup.display(e.answer), forType: .string)
                                }
                                .buttonStyle(.link)
                            }
                        }
                    }
                    .padding(.vertical, 6)
                }
            }
        }
        .frame(minWidth: 560, minHeight: 420)
    }
}

/// A row's screenshot, decoded small in the background and cached (full screenshots are several MB each).
private struct HistoryThumbnail: View {
    let path: String
    @State private var image: NSImage?
    @State private var missing = false

    private static let cache: NSCache<NSString, NSImage> = { let c = NSCache<NSString, NSImage>(); c.countLimit = 300; return c }()
    private static let decode = DispatchQueue(label: "visioncli.history.thumbs", qos: .userInitiated, attributes: .concurrent)

    init(path: String) {
        self.path = path
        _image = State(initialValue: Self.cache.object(forKey: path as NSString))
    }

    var body: some View {
        if !missing {
            Group {
                if let image {
                    Image(nsImage: image).resizable().aspectRatio(contentMode: .fill)
                } else {
                    Color.white.opacity(0.05)
                }
            }
            .frame(width: 96, height: 64)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .onTapGesture { NSWorkspace.shared.open(URL(fileURLWithPath: path)) }
            .help("Open screenshot")
            .task(id: path) { await load() }
        }
    }

    private func load() async {
        if let hit = Self.cache.object(forKey: path as NSString) { image = hit; return }
        let path = path
        let thumb: NSImage? = await withCheckedContinuation { done in
            Self.decode.async { done.resume(returning: Self.thumbnail(path)) }
        }
        if let thumb {
            Self.cache.setObject(thumb, forKey: path as NSString)
            image = thumb
        } else {
            missing = true
        }
    }

    private static func thumbnail(_ path: String) -> NSImage? {
        guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                     kCGImageSourceCreateThumbnailWithTransform: true,
                                     kCGImageSourceThumbnailMaxPixelSize: 320] // fills 96x64 pt at 2x
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
    }
}

final class HistoryWindow {
    private var window: NSWindow?
    private let filter = HistoryFilter()

    /// `project`: show that project's history (falls back to all projects when it has none yet).
    func show(store: HistoryStore, project: String? = nil) {
        if let project { filter.project = store.entries.contains { $0.project == project } ? project : "" }
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 560),
                             styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
            w.title = "VisionCLI History"
            w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: HistoryView(store: store, filter: filter))
            w.center()
            window = w
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}
