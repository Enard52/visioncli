import AppKit
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
    private let keep = 300

    init() {
        try? FileManager.default.createDirectory(at: shotsDir, withIntermediateDirectories: true)
        load()
    }

    /// Save screenshots for an entry and return their paths (also passed to Claude for `share`).
    func save(_ shots: [Shot]) -> [Shot] {
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        return shots.enumerated().map { i, shot in
            var s = shot
            let url = shotsDir.appendingPathComponent("\(stamp)-\(i + 1).jpg")
            if (try? shot.jpeg.write(to: url)) != nil { s.file = url }
            return s
        }
    }

    func add(_ e: HistoryEntry) {
        entries.insert(e, at: 0)
        if entries.count > keep {
            for old in entries[keep...] { old.screenshots.forEach { try? FileManager.default.removeItem(atPath: $0) } }
            entries = Array(entries.prefix(keep))
            persistAll()
        } else if let data = try? encoder.encode(e) {
            append(data + Data([0x0A]))
        }
    }

    func clear() {
        entries.forEach { $0.screenshots.forEach { try? FileManager.default.removeItem(atPath: $0) } }
        entries = []
        try? FileManager.default.removeItem(at: file)
    }

    private let encoder: JSONEncoder = { let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; return e }()
    private let decoder: JSONDecoder = { let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d }()

    private func load() {
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return }
        entries = text.split(separator: "\n").compactMap { try? decoder.decode(HistoryEntry.self, from: Data($0.utf8)) }.reversed()
    }

    private func persistAll() {
        let data = entries.reversed().compactMap { try? encoder.encode($0) }.reduce(Data()) { $0 + $1 + Data([0x0A]) }
        try? data.write(to: file)
    }

    private func append(_ data: Data) {
        if let h = try? FileHandle(forWritingTo: file) {
            h.seekToEndOfFile()
            h.write(data)
            try? h.close()
        } else {
            try? data.write(to: file)
        }
    }
}

struct HistoryView: View {
    @ObservedObject var store: HistoryStore
    @State private var query = ""

    var filtered: [HistoryEntry] {
        guard !query.isEmpty else { return store.entries }
        return store.entries.filter { "\($0.question) \($0.answer) \($0.project)".localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search questions and answers", text: $query).textFieldStyle(.plain)
                Spacer()
                Button("Clear History") { store.clear() }.disabled(store.entries.isEmpty)
            }
            .padding(12)
            Divider()
            if filtered.isEmpty {
                Spacer()
                Text(store.entries.isEmpty ? "No questions yet. Hold ⌥ Space and ask about your screen." : "No matches")
                    .foregroundStyle(.secondary)
                Spacer()
            } else {
                List(filtered) { e in
                    HStack(alignment: .top, spacing: 12) {
                        if let first = e.screenshots.first, let img = NSImage(contentsOfFile: first) {
                            Image(nsImage: img)
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                                .frame(width: 96, height: 64)
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                                .onTapGesture { NSWorkspace.shared.open(URL(fileURLWithPath: first)) }
                                .help("Open screenshot")
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(e.question).font(.headline).lineLimit(2)
                                Spacer()
                                Text(e.date, style: .relative).font(.caption).foregroundStyle(.secondary)
                            }
                            Text((e.project as NSString).lastPathComponent).font(.caption).foregroundStyle(.secondary)
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

final class HistoryWindow {
    private var window: NSWindow?

    func show(store: HistoryStore) {
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 560),
                             styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
            w.title = "visioncli History"
            w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: HistoryView(store: store))
            w.center()
            window = w
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}
