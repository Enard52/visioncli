import Foundation

// Line-oriented stream parsing for CLI output and JSONL transcripts (Foundation only, tested in overlay/Tests).

/// Splits a byte stream (a pipe's readabilityHandler chunks) into lines in one pass per chunk. Removing each line from
/// the front of the buffer re-copied the rest every time, which is quadratic when a big chunk holds many lines.
/// A partial last line waits in the buffer for the rest of it. Not thread-safe: use one per stream, fed from that
/// stream's handler only.
final class LineSplitter {
    private var buffer = Data()

    func feed(_ chunk: Data, _ line: (Data) -> Void) {
        guard !chunk.isEmpty else { return }
        buffer.append(chunk)
        var start = buffer.startIndex
        while let nl = buffer[start...].firstIndex(of: 0x0A) {
            line(buffer[start..<nl])
            start = buffer.index(after: nl)
        }
        if start != buffer.startIndex { buffer = Data(buffer[start...]) }
    }

    /// Drops a partial line (the stream restarted, or earlier output is being skipped).
    func reset() { buffer = Data() }
}

/// JSONL: one JSON object per line. Lines that aren't a JSON object (blank, truncated, arrays) are skipped.
enum JSONLines {
    static func object(_ line: Data) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
    }

    /// The objects in the complete lines of `chunk`; a partial last line is kept in `splitter` for the next chunk.
    static func objects(_ chunk: Data, splitter: LineSplitter) -> [[String: Any]] {
        var out: [[String: Any]] = []
        splitter.feed(chunk) { if let obj = object($0) { out.append(obj) } }
        return out
    }
}
