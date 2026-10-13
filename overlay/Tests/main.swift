import Foundation

// Tests for the Foundation-only Core*.swift sources. A plain executable (no XCTest with Command Line Tools):
// scripts/test-overlay.sh compiles overlay/Sources/Core*.swift with this file and runs it.

var checks = 0
var failures = 0

/// Records one assertion; prints the failing ones with where they are.
func check(_ cond: @autoclosure () -> Bool, _ msg: String, line: Int = #line) {
    checks += 1
    if !cond() {
        failures += 1
        print("FAIL (line \(line)): \(msg)")
    }
}

/// Equality with both values in the failure message.
func eq<T: Equatable>(_ a: T, _ b: T, _ msg: String, line: Int = #line) {
    check(a == b, "\(msg): got \(String(describing: a)), expected \(String(describing: b))", line: line)
}

// MARK: - SpokenText

func testSpokenText() {
    let clean = SpokenText.clean
    eq(clean("| a | b |\n|---|---|\n| 1 | 2 |\nAfter the table."), "After the table.", "table rows dropped")
    eq(clean("Before.\n```swift\nlet x = 1\n```\nAfter."), "Before.\n\nAfter.", "closed code fence dropped")
    eq(clean("Look:\n```\nunfinished code"), "Look:\n", "unclosed code fence dropped to the end")
    eq(clean("- first\n* second\n• third\n1. fourth"), "first\nsecond\nthird\nfourth", "bullets and numbers dropped")
    eq(clean("See app/Models/File.swift:42 now"), "See File.swift, line 42 now", "path:line becomes file, line")
    eq(clean("a/b/File.swift:42"), "File.swift, line 42", "relative path:line")
    eq(clean("Lines File.swift:10-20 matter"), "Lines File.swift, line 10 matter", "line ranges keep the start")
    eq(clean("A → B"), "A  to  B", "arrow read as to")
    eq(clean("≈5 ms"), "about 5 ms", "approx read as about")
    eq(clean("Go to https://example.com/x?y=1 now"), "Go to a link now", "URLs become a link")
    eq(clean("Read [the docs](https://example.com)"), "Read the docs", "markdown links keep their text")
    eq(clean("**bold** __under__ `code` # Title"), "bold under code  Title", "emphasis marks dropped")
    eq(clean("plain text"), "plain text", "plain text untouched")

    check(SpokenText.speakable("Hello"), "words are speakable")
    check(SpokenText.speakable("42"), "numbers are speakable")
    check(!SpokenText.speakable("|---|"), "table border is not speakable")
    check(!SpokenText.speakable("... !?"), "punctuation is not speakable")
    check(!SpokenText.speakable(""), "empty is not speakable")

    eq(SpokenText.sentences("First one. Second one! Third?"), ["First one.", "Second one!", "Third?"], "splits sentences")
    eq(SpokenText.sentences("Words.\n...\nDone."), ["Words.", "Done."], "punctuation-only sentence skipped")
    eq(SpokenText.sentences("no punctuation"), ["no punctuation"], "single sentence without a stop")
    eq(SpokenText.sentences("--- ..."), [], "nothing speakable gives nothing")
}

// MARK: - Vocabulary

func testVocabulary() {
    let words = Vocabulary.words(project: "shop", windowTitle: "PaymentController.php — shop", custom: "Acme, Zed\n\n  Foo  \n")
    check(words.first == "shop", "project first")
    check(words.contains("PaymentController"), "CamelCase title token kept")
    check(!words.contains("php"), "short title tokens skipped")
    check(words.contains("Acme") && words.contains("Zed") && words.contains("Foo"), "custom words trimmed and kept")
    check(!words.contains(""), "no blank words")
    let dup = Vocabulary.words(project: "github", windowTitle: nil, custom: nil)
    eq(dup.filter { $0.lowercased() == "github" }.count, 1, "deduplicated case-insensitively")
    check(Vocabulary.words(project: "p", windowTitle: nil, custom: (0..<200).map { "w\($0)" }.joined(separator: ",")).count == 80, "capped at 80")
    check(!Vocabulary.words(project: "p", windowTitle: "plain words only here", custom: nil).contains("plain"), "plain title words skipped")

    let prompt = Vocabulary.prompt(project: "shop", windowTitle: "Main.swift", custom: "Acme")
    check(prompt.hasPrefix("Vocabulary: shop, Main.swift, Acme, Claude"), "prompt order: project, title, custom, terms")
    check(prompt.hasSuffix("controller."), "prompt ends with a period")
    check(!Vocabulary.prompt(project: "p", windowTitle: "", custom: nil).contains(", ,"), "empty title skipped")
    eq(Vocabulary.customWords(nil), [], "no vocabulary file")
}

// MARK: - QuickCommandFilter

func testQuickCommands() {
    let yes = ["open github", "Open GitHub.", "please click sign in", "can you scroll down", "hey go back",
               "okay now search for cats", "Google the weather", "sign in", "log out", "new tab", "type hello world"]
    for t in yes { check(QuickCommandFilter.matches(t), "accepts \"\(t)\"") }
    let no = ["open github?", "what is this?", "why does this fail", "explain the payment flow",
              "open the file and then tell me why the tests in this folder fail on CI every time", "",
              "the button", "hello", "please", "is it open"]
    for t in no { check(!QuickCommandFilter.matches(t), "rejects \"\(t)\"") }
    check(QuickCommandFilter.matches("open a b c d e f g h i j k l m n o p q r s"), "20 words is still short")
    check(!QuickCommandFilter.matches("open a b c d e f g h i j k l m n o p q r s t"), "21 words is too long")
    check(QuickCommandFilter.matches("find a stay in Lisbon for 3 nights with a pool and free cancellation, then open it"), "a browser task")
    check(!QuickCommandFilter.matches("open the settings and explain the timeout"), "question words go to the assistant")
}

// MARK: - BrowserTaskText

func testBrowserTaskText() {
    eq(BrowserTaskText.line(["kind": "fill", "label": "Destination", "text": "Lisbon"]), "Typed “Lisbon” into Destination", "typing")
    eq(BrowserTaskText.line(["kind": "click", "label": "Search"]), "Clicked Search", "click")
    eq(BrowserTaskText.line(["kind": "select", "label": "Nights → 3 nights"]), "Chose 3 nights in Nights", "dropdown")
    eq(BrowserTaskText.line(["kind": "scroll", "label": "Scroll down"]), "Scroll down", "scroll")
    check(BrowserTaskText.line(["kind": "done", "label": "Done"]) == nil, "done has no step line")
    eq(BrowserTaskText.summary(status: "done", message: "Done.", steps: 7, ms: 3955), "Done in 4.0 s (7 steps).", "done summary")
    eq(BrowserTaskText.summary(status: "done", message: "", steps: 1, ms: 900), "Done in 0.9 s (1 step).", "one step")
    eq(BrowserTaskText.summary(status: "blocked", message: "I don't know what to type into \"Email\".", steps: 2, ms: 1),
       "I don't know what to type into \"Email\".", "blocked shows the reason")
    eq(BrowserTaskText.body(header: "Done.", lines: ["Clicked A", "Clicked B"]), "Done.\n\n1. Clicked A\n2. Clicked B", "numbered steps")
    eq(BrowserTaskText.body(header: "Working…", lines: []), "Working…", "no steps yet")
}

// MARK: - SlashCommand

func testSlashCommand() {
    eq(SlashCommand.parse("/compact"), "/compact", "typed command")
    eq(SlashCommand.parse("Slash model haiku."), "/model haiku", "spoken slash, trailing period")
    eq(SlashCommand.parse("forward slash Effort High!"), "/effort high", "forward slash, lowercased")
    eq(SlashCommand.parse("Slash model, Sonnet"), "/model sonnet", "comma after the name dropped")
    eq(SlashCommand.parse("  /Clear  "), "/clear", "trimmed and lowercased")
    eq(SlashCommand.parse("what does slash compact do"), nil, "slash in the middle is a question")
    eq(SlashCommand.parse("/"), nil, "bare slash")
    eq(SlashCommand.parse("slash"), nil, "the word alone")
    eq(SlashCommand.parse("/" + String(repeating: "a", count: 60)), nil, "too long")
    eq(SlashCommand.parse("/model\nhaiku"), nil, "multi-line")
}

// MARK: - ProjectSelector

func testProjectSelector() {
    let now = Date()
    let home = "/Users/me/VisionCLI"
    let recent = (path: "/p/recent", at: now.addingTimeInterval(-60))
    let stale = (path: "/p/recent", at: now.addingTimeInterval(-601))

    var d = ProjectSelector.decide(pinned: "/p/pinned", windowProject: "/p/win", lastReal: recent, now: now, home: home)
    eq(d, ProjectDecision(project: "/p/pinned", askScope: false, fromWindow: false), "pinned wins")
    d = ProjectSelector.decide(pinned: nil, windowProject: "/p/win", lastReal: recent, now: now, home: home)
    eq(d, ProjectDecision(project: "/p/win", askScope: false, fromWindow: true), "window project next")
    d = ProjectSelector.decide(pinned: nil, windowProject: nil, lastReal: recent, now: now, home: home)
    eq(d, ProjectDecision(project: "/p/recent", askScope: true, fromWindow: false), "recent project, Jev decides")
    d = ProjectSelector.decide(pinned: nil, windowProject: nil, lastReal: stale, now: now, home: home)
    eq(d, ProjectDecision(project: home, askScope: false, fromWindow: false), "older than 10 minutes goes Home")
    d = ProjectSelector.decide(pinned: nil, windowProject: nil, lastReal: (recent.path, now.addingTimeInterval(-599.9)), now: now, home: home)
    check(d.askScope, "just inside the 10 minute window")
    d = ProjectSelector.decide(pinned: nil, windowProject: nil, lastReal: (recent.path, now.addingTimeInterval(-600)), now: now, home: home)
    eq(d.project, home, "exactly 10 minutes is Home")
    d = ProjectSelector.decide(pinned: nil, windowProject: nil, lastReal: nil, now: now, home: home)
    eq(d.project, home, "nothing known goes Home")

    var c = ProjectSelector.confirm(current: "/p/cur", pinned: "/p/pinned", terminalProject: "/p/term", windowProject: "/p/win")
    eq(c, ProjectDecision(project: "/p/pinned", askScope: false, fromWindow: false), "confirm: pinned wins")
    c = ProjectSelector.confirm(current: "/p/cur", pinned: nil, terminalProject: "/p/term", windowProject: "/p/win")
    eq(c, ProjectDecision(project: "/p/term", askScope: false, fromWindow: false), "confirm: terminal before window")
    c = ProjectSelector.confirm(current: "/p/cur", pinned: nil, terminalProject: nil, windowProject: "/p/win")
    eq(c, ProjectDecision(project: "/p/win", askScope: false, fromWindow: true), "confirm: window project")
    c = ProjectSelector.confirm(current: "/p/cur", pinned: nil, terminalProject: nil, windowProject: nil)
    eq(c, ProjectDecision(project: "/p/cur", askScope: false, fromWindow: false), "confirm: keeps the current project")

    eq(ProjectSelector.label(home, home: home), "Home", "Home label")
    eq(ProjectSelector.label("/Users/me/code/shop", home: home), "shop", "folder name label")
}

// MARK: - LineSplitter / JSONLines

func testLineSplitter() {
    let s = LineSplitter()
    var lines: [String] = []
    let collect: (Data) -> Void = { lines.append(String(decoding: $0, as: UTF8.self)) }
    s.feed(Data("one\ntw".utf8), collect)
    eq(lines, ["one"], "partial line held back")
    s.feed(Data("o\nthree\n".utf8), collect)
    eq(lines, ["one", "two", "three"], "partial line completed by the next chunk")
    s.feed(Data(), collect)
    eq(lines.count, 3, "empty chunk does nothing")
    s.feed(Data("\n".utf8), collect)
    eq(lines.last, "", "empty line delivered")
    s.feed(Data("dropped".utf8), collect)
    s.reset()
    s.feed(Data("fresh\n".utf8), collect)
    eq(lines.last, "fresh", "reset drops the partial line")
    let many = LineSplitter()
    var count = 0
    many.feed(Data(String(repeating: "x\n", count: 10_000).utf8)) { _ in count += 1 }
    eq(count, 10_000, "many lines in one chunk")

    let splitter = LineSplitter()
    var objs = JSONLines.objects(Data("{\"type\":\"user\"}\nnot json\n[1,2]\n{\"type\":\"assist".utf8), splitter: splitter)
    eq(objs.count, 1, "only complete JSON objects")
    eq(objs.first?["type"] as? String, "user", "first object parsed")
    objs = JSONLines.objects(Data("ant\"}\n".utf8), splitter: splitter)
    eq(objs.first?["type"] as? String, "assistant", "object split across chunks")
    check(JSONLines.object(Data("".utf8)) == nil, "blank line is not an object")
}

// MARK: - Markup

func testMarkup() {
    let text = "Here [[step:1:10,20:2:Two]] and [[box:1:1,2,3,4:Box]] then [[arrow:2:5,6:7,8]]."
    let marks = Markup.marks(in: text)
    eq(marks.count, 3, "three marks")
    if marks.count == 3 {
        if case .step(let n) = marks[0].kind { eq(n, 2, "step number") } else { check(false, "first mark is the step") }
        eq(marks[0].label, "Two", "step label")
        check(marks[0].a.x == marks[0].b.x && marks[0].a.y == marks[0].b.y && marks[0].a.x == 10, "step a == b")
        if case .box = marks[1].kind {} else { check(false, "second mark is the box") }
        check(marks[1].b.x == 3 && marks[1].b.y == 4, "box corner")
        if case .arrow = marks[2].kind {} else { check(false, "third mark is the arrow") }
        eq(marks[2].image, 2, "arrow image")
        eq(marks[2].label, "", "no label")
    }
    eq(Markup.display(text), "Here and then.", "markers removed from display")
    eq(Markup.display("Answer [[box:1:1,2"), "Answer", "half-streamed marker hidden")
    let ref = Markup.firstFileRef("See `src/app/Payment.php:42-50` and other.swift:3")
    eq(ref?.0, "src/app/Payment.php", "first file ref path")
    eq(ref?.1, 42, "first file ref line")
    check(Markup.firstFileRef("no refs here") == nil, "no file ref")
    check(Markup.linked("at a.swift:7").contains("visioncli://open?path=a.swift&line=7"), "file refs linked")
}

// MARK: - DiagramText

func testDiagramText() {
    let answer = "Intro\n```mermaid\ngraph TD\nA-->B\n```\nOutro"
    eq(DiagramText.segments(answer), [.text("Intro"), .mermaid("graph TD\nA-->B"), .text("Outro")], "segments split")
    eq(DiagramText.segments("Intro ```mermaid\ngraph"), [.text("Intro"), .pendingDiagram], "streaming diagram pending")
    eq(DiagramText.speakable(answer), "Intro\n(See the diagram.)\nOutro", "diagram mentioned aloud")
    eq(DiagramText.speakable("Intro ```mermaid\ngraph"), "Intro\n", "pending diagram cuts speech")
    eq(DiagramText.segments(""), [], "empty answer")
}

// MARK: - MenuLabels

func testMenuLabels() {
    eq(MenuLabels.claudeModel("opus"), "Opus", "model label")
    eq(MenuLabels.claudeModel("opus[1m]"), "Opus, 1M context", "1M model label")
    eq(MenuLabels.claudeModel("custom-model"), "custom-model", "unknown alias shown as is")
    eq(MenuLabels.effort(nil), "Default", "default effort")
    eq(MenuLabels.effort("xhigh"), "Extra High", "xhigh effort")
    eq(MenuLabels.followedModel(used: "claude-sonnet-4-5", menu: "opus"), "sonnet", "follows a new family")
    eq(MenuLabels.followedModel(used: "claude-opus-4-1", menu: "opus[1m]"), nil, "1M choice counts as its family")
    eq(MenuLabels.followedModel(used: "claude-opus-4-1", menu: "opusplan"), nil, "opusplan covers opus")
    eq(MenuLabels.followedModel(used: "claude-haiku-4-5", menu: "opusplan"), "haiku", "opusplan to haiku")
    eq(MenuLabels.followedModel(used: "gpt-whatever", menu: "opus"), nil, "unknown model ignored")
}

testSpokenText()
testVocabulary()
testQuickCommands()
testSlashCommand()
testProjectSelector()
testLineSplitter()
testMarkup()
testDiagramText()
testMenuLabels()
testBrowserTaskText()

print("\(checks - failures)/\(checks) checks passed")
if failures > 0 {
    print("\(failures) failed")
    exit(1)
}
