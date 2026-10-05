import AppKit

/// Downloads the optional local voice models on Macs that don't have them yet, so Whisper (transcription) and
/// Kokoro (spoken answers) work on any machine, not just ones that already had the models from other tools.
/// Models go to ~/Library/Application Support/visioncli/models (already on VoiceModels' search path).
final class ModelInstaller: NSObject, URLSessionDownloadDelegate {
    enum Kind: String { case whisper = "Whisper", kokoro = "Kokoro voices" }

    static let modelsDir = supportDir.appendingPathComponent("models")
    static let whisperModel = ("ggml-small.en.bin", "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin")
    static let kokoroFiles = [
        ("kokoro-v1.0.onnx", "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"),
        ("voices-v1.0.bin", "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"),
    ]

    private let cfg: Config
    /// Shown in the menu while something installs, e.g. "Downloading Kokoro voices… 42%".
    private(set) var status: String?
    var onFinished: (Kind, String?) -> Void = { _, _ in } // error message or nil
    private var queue: [(name: String, url: String)] = []
    private var kind: Kind = .whisper
    private var session: URLSession!
    private var finishing = false

    init(cfg: Config) {
        self.cfg = cfg
        super.init()
        session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
    }

    var isBusy: Bool { status != nil }

    static var whisperInstalled: Bool { !VoiceModels.whisperModels().isEmpty }
    static var kokoroInstalled: Bool { VoiceModels.kokoroModel != nil && VoiceModels.kokoroVoices != nil }

    // MARK: Whisper

    func installWhisper() {
        guard !isBusy else { return }
        kind = .whisper
        let needsBinary = VoiceModels.binary("whisper-server", path: cfg.path) == nil
        if needsBinary {
            guard let brew = Config.find("brew", path: cfg.path + ":/opt/homebrew/bin:/usr/local/bin") else {
                fail("Whisper needs whisper.cpp, which installs with Homebrew. Install Homebrew from brew.sh, then try again (or run `brew install whisper-cpp`).")
                return
            }
            guard confirm("Install Whisper?", "This runs `brew install whisper-cpp`, then downloads the small English model (~490 MB). Transcription then runs locally on your Mac.") else { return }
            setStatus("Installing whisper.cpp with Homebrew…")
            DispatchQueue.global().async { [cfg] in
                var env = ProcessInfo.processInfo.environment
                env["PATH"] = cfg.path
                env["HOMEBREW_NO_AUTO_UPDATE"] = "1"
                let (status, _, err) = shell(brew, ["install", "whisper-cpp"], env: env)
                DispatchQueue.main.async {
                    if status != 0 { self.fail("brew install whisper-cpp failed: \(err.split(separator: "\n").suffix(2).joined(separator: " "))"); return }
                    self.download([Self.whisperModel])
                }
            }
        } else {
            guard confirm("Download Whisper?", "Downloads the small English model (~490 MB). Transcription then runs locally on your Mac.") else { return }
            download([Self.whisperModel])
        }
    }

    // MARK: Kokoro

    func installKokoro() {
        guard !isBusy else { return }
        kind = .kokoro
        let needsUV = VoiceModels.binary("uv", path: cfg.path) == nil
        guard confirm("Download Kokoro voices?", "Downloads the Kokoro voice model (~350 MB)\(needsUV ? " and installs uv (a small Python tool runner, from astral.sh)" : ""). Answers are then read aloud in natural voices, locally on your Mac.") else { return }
        if needsUV {
            setStatus("Installing uv…")
            DispatchQueue.global().async {
                let (status, _, err) = shell("/bin/sh", ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"])
                DispatchQueue.main.async {
                    if status != 0 { self.fail("Installing uv failed: \(err.split(separator: "\n").suffix(2).joined(separator: " "))"); return }
                    self.download(Self.kokoroFiles)
                }
            }
        } else {
            download(Self.kokoroFiles)
        }
    }

    /// Debug: download files through the normal pipeline without dialogs (`--test-download`).
    func debugDownload(_ files: [(String, String)]) {
        kind = .kokoro
        download(files)
    }

    // MARK: Downloads

    private func download(_ files: [(String, String)]) {
        finishing = false
        try? FileManager.default.createDirectory(at: Self.modelsDir, withIntermediateDirectories: true)
        queue = files.filter { !FileManager.default.fileExists(atPath: Self.modelsDir.appendingPathComponent($0.0).path) }
        next()
    }

    private func next() {
        guard let file = queue.first, let url = URL(string: file.url) else { finishDownloads(); return }
        setStatus("Downloading \(kind.rawValue)…")
        log("installer: downloading \(file.name)")
        session.downloadTask(with: url).resume()
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard totalBytesExpectedToWrite > 0 else { return }
        let pct = Int(Double(totalBytesWritten) / Double(totalBytesExpectedToWrite) * 100)
        let mb = { (b: Int64) in String(format: "%.0f", Double(b) / 1_000_000) }
        setStatus("Downloading \(kind.rawValue)… \(pct)% (\(mb(totalBytesWritten))/\(mb(totalBytesExpectedToWrite)) MB)")
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let file = queue.first else { return }
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { fail("Download failed (HTTP \(status)) for \(file.name)."); return }
        let dest = Self.modelsDir.appendingPathComponent(file.name)
        try? FileManager.default.removeItem(at: dest)
        do { try FileManager.default.moveItem(at: location, to: dest) } catch { fail("Couldn't save \(file.name): \(error.localizedDescription)"); return }
        queue.removeFirst()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { fail("Download failed: \(error.localizedDescription)"); return }
        next()
    }

    private func finishDownloads() {
        guard status != nil, !finishing else { return }
        finishing = true
        if kind == .kokoro {
            // Fetch the Python packages once now, so the first spoken answer doesn't wait for them.
            setStatus("Preparing Kokoro…")
            DispatchQueue.global().async { [cfg] in
                if let uv = VoiceModels.binary("uv", path: cfg.path) {
                    var env = ProcessInfo.processInfo.environment
                    env["PATH"] = cfg.path
                    shell(uv, ["run", "--quiet", "--with", "kokoro-onnx", "--with", "soundfile", "python", "-c", "import kokoro_onnx"], env: env)
                }
                DispatchQueue.main.async { self.done() }
            }
        } else {
            done()
        }
    }

    private func done() {
        guard status != nil else { return } // already reported
        log("installer: \(kind.rawValue) installed")
        status = nil
        onFinished(kind, nil)
    }

    private func fail(_ message: String) {
        log("installer: \(message)")
        status = nil
        queue = []
        onFinished(kind, message)
    }

    private func setStatus(_ s: String) { status = s }

    private func confirm(_ title: String, _ text: String) -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        alert.addButton(withTitle: "Install")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }
}
