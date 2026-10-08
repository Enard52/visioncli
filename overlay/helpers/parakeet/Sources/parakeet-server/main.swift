import Foundation

// parakeet-server: VisionCLI's local speech-to-text helper (NVIDIA Parakeet TDT on the Neural Engine, via FluidAudio).
// Loads the models once, then answers one JSON request per stdin line:
//   → {"id": 1, "wav": "/path/q.wav", "vocab": ["PaymentController", "Laravel"]}
//   ← {"id": 1, "text": "…", "ms": 180, "boosted": ["…"]}
// Prints {"ready": true} when the models are loaded (the first run downloads them, ~600 MB).
// Usage: parakeet-server [--model v2|v3] ; or `parakeet-server <file.wav> [term…]` for a one-off test.

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}

actor Engine {
    let version: AsrModelVersion
    private var asr: AsrManager?
    private var ctc: CtcModels?
    private var tokenizer: CtcTokenizer?
    private var spotter: CtcKeywordSpotter?
    private var vocabKey = ""
    private var vocab: CustomVocabularyContext?
    private var rescorer: VocabularyRescorer?

    init(version: AsrModelVersion) { self.version = version }

    func load() async throws {
        let models = try await AsrModels.downloadAndLoad(version: version)
        let config = ASRConfig(tdtConfig: TdtConfig(blankId: version.blankId), encoderHiddenSize: version.encoderHiddenSize)
        let manager = AsrManager(config: config)
        try await manager.loadModels(models)
        asr = manager
        // Small CTC model used only to spot the custom words.
        let ctcModels = try await CtcModels.downloadAndLoad(variant: .ctc110m)
        ctc = ctcModels
        tokenizer = try await CtcTokenizer.load(from: CtcModels.defaultCacheDirectory(for: .ctc110m))
        spotter = CtcKeywordSpotter(models: ctcModels, blankId: ctcModels.vocabulary.count)
    }

    /// Rebuild the vocabulary only when the word list changes.
    private func setVocab(_ words: [String]) async throws {
        let key = words.joined(separator: "\n")
        guard key != vocabKey else { return }
        vocabKey = key
        vocab = nil
        rescorer = nil
        guard !words.isEmpty, let tokenizer, let spotter else { return }
        let terms = words.compactMap { w -> CustomVocabularyTerm? in
            let ids = tokenizer.encode(w)
            return ids.isEmpty ? nil : CustomVocabularyTerm(text: w, weight: 10, aliases: nil, tokenIds: nil, ctcTokenIds: ids)
        }
        let context = CustomVocabularyContext(terms: terms)
        vocab = context
        rescorer = try await VocabularyRescorer.create(
            spotter: spotter, vocabulary: context, config: .default,
            ctcModelDirectory: CtcModels.defaultCacheDirectory(for: .ctc110m))
    }

    func transcribe(_ url: URL, words: [String]) async throws -> (String, [String]) {
        guard let asr else { throw NSError(domain: "parakeet", code: 1, userInfo: [NSLocalizedDescriptionKey: "not loaded"]) }
        try await setVocab(words)
        let samples = try AudioConverter().resampleAudioFile(url)
        var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
        let result = try await asr.transcribe(samples, decoderState: &state)
        var text = result.text
        var boosted: [String] = []
        if let vocab, let rescorer, let spotter, let timings = result.tokenTimings, !timings.isEmpty {
            let spot = try await spotter.spotKeywordsWithLogProbs(audioSamples: samples, customVocabulary: vocab, minScore: nil)
            if !spot.logProbs.isEmpty {
                let cfg = ContextBiasingConstants.rescorerConfig(forVocabSize: vocab.terms.count)
                let out = rescorer.ctcTokenRescore(
                    transcript: text, tokenTimings: timings, logProbs: spot.logProbs, frameDuration: spot.frameDuration,
                    cbw: cfg.cbw, marginSeconds: ContextBiasingConstants.defaultMarginSeconds, minSimilarity: cfg.minSimilarity)
                if out.wasModified {
                    text = out.text
                    boosted = out.replacements.filter(\.shouldReplace).map { "\($0.originalWord) → \($0.replacementWord ?? "")" }
                }
            }
        }
        return (text.trimmingCharacters(in: .whitespacesAndNewlines), boosted)
    }
}

var args = Array(CommandLine.arguments.dropFirst())
var version: AsrModelVersion = .v2 // English; v3 adds 24 more European languages
if let i = args.firstIndex(of: "--model"), i + 1 < args.count {
    version = args[i + 1] == "v3" ? .v3 : .v2
    args.removeSubrange(i...(i + 1))
}

let engine = Engine(version: version)
do {
    try await engine.load()
} catch {
    emit(["error": "load failed: \(error.localizedDescription)"])
    exit(1)
}

if let file = args.first {
    // One-off: parakeet-server q.wav Laravel PaymentController
    let started = Date()
    let (text, boosted) = try await engine.transcribe(URL(fileURLWithPath: file), words: Array(args.dropFirst()))
    emit(["text": text, "ms": Int(Date().timeIntervalSince(started) * 1000), "boosted": boosted])
    exit(0)
}

emit(["ready": true])
while let line = readLine() {
    guard let data = line.data(using: .utf8), let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let wav = req["wav"] as? String else { continue }
    let id = req["id"] ?? 0
    let started = Date()
    do {
        let (text, boosted) = try await engine.transcribe(URL(fileURLWithPath: wav), words: req["vocab"] as? [String] ?? [])
        emit(["id": id, "text": text, "ms": Int(Date().timeIntervalSince(started) * 1000), "boosted": boosted])
    } catch {
        emit(["id": id, "error": error.localizedDescription])
    }
}
