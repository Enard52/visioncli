import AppKit

/// Finds newer releases on GitHub and installs them in place.
/// Updates are only installed if they're signed with the same certificate as the running app, so macOS keeps
/// VisionCLI's permissions (Screen Recording, Microphone, …) and a corrupted or foreign download is refused.
final class Updater {
    static let repo = "thethirdsourcers/visioncli"

    struct Release { let version: String; let zip: URL; let page: URL }

    private(set) var available: Release?
    private(set) var status: String?        // "Downloading update… 40%" while installing
    var onAvailable: (Release) -> Void = { _ in }
    var onError: (String) -> Void = { _ in }
    private var timer: Timer?

    static var currentVersion: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0" }

    /// Check at launch (after a short delay) and every 6 hours.
    func startAutomaticChecks() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in self?.check(manual: false) }
        timer = Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { [weak self] _ in self?.check(manual: false) }
    }

    func check(manual: Bool, done: ((Release?) -> Void)? = nil) {
        guard manual || Settings.autoUpdate else { return }
        var req = URLRequest(url: URL(string: "https://api.github.com/repos/\(Self.repo)/releases/latest")!, timeoutInterval: 15)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: req) { data, _, error in
            var found: Release?
            if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let tag = json["tag_name"] as? String,
               let assets = json["assets"] as? [[String: Any]],
               let zip = assets.first(where: { ($0["name"] as? String)?.hasSuffix("-macos.zip") == true })?["browser_download_url"] as? String,
               let zipURL = URL(string: zip) {
                let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
                if Self.isNewer(version, than: Self.currentVersion) {
                    found = Release(version: version, zip: zipURL, page: URL(string: json["html_url"] as? String ?? "https://github.com/\(Self.repo)/releases")!)
                }
            }
            DispatchQueue.main.async {
                if let error { log("update check failed: \(error.localizedDescription)") }
                self.available = found
                if let found {
                    log("update available: \(found.version) (running \(Self.currentVersion))")
                    if manual || UserDefaults.standard.string(forKey: "notifiedUpdate") != found.version {
                        UserDefaults.standard.set(found.version, forKey: "notifiedUpdate")
                        self.onAvailable(found)
                    }
                }
                done?(found)
            }
        }.resume()
    }

    static func isNewer(_ a: String, than b: String) -> Bool {
        let pa = a.split(separator: ".").map { Int($0) ?? 0 }, pb = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0, y = i < pb.count ? pb[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    /// Download, verify, replace this app and relaunch.
    func install() {
        guard let release = available, status == nil else { return }
        status = "Downloading update \(release.version)…"
        log("update: downloading \(release.zip)")
        let task = URLSession.shared.downloadTask(with: release.zip) { location, response, error in
            let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("visioncli-update-\(UUID().uuidString)")
            var failure: String?
            if let error { failure = "Download failed: \(error.localizedDescription)" }
            else if (response as? HTTPURLResponse)?.statusCode != 200 { failure = "Download failed (HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0))." }
            else if let location {
                try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
                let zip = tmp.appendingPathComponent("update.zip")
                try? FileManager.default.moveItem(at: location, to: zip)
                failure = Self.unpackAndInstall(zip: zip, in: tmp)
            }
            DispatchQueue.main.async {
                if let failure {
                    self.status = nil
                    log("update: \(failure)")
                    self.onError(failure)
                    try? FileManager.default.removeItem(at: tmp)
                    return
                }
                log("update: installed \(release.version); relaunching")
                Self.relaunch()
            }
        }
        task.resume()
    }

    /// Returns an error message, or nil once the new app is in place.
    private static func unpackAndInstall(zip: URL, in dir: URL) -> String? {
        let (unzipStatus, _, unzipErr) = shell("/usr/bin/ditto", ["-x", "-k", zip.path, dir.path])
        guard unzipStatus == 0 else { return "Couldn't unpack the update: \(unzipErr)" }
        let newApp = dir.appendingPathComponent("VisionCLI.app")
        guard FileManager.default.fileExists(atPath: newApp.path) else { return "The update didn't contain VisionCLI.app." }

        // Same signer as the running app (designated requirement), so permissions carry over and tampering is refused.
        let (verify, _, verifyErr) = shell("/usr/bin/codesign", ["--verify", "--deep", "--strict", newApp.path])
        guard verify == 0 else { return "The update's signature is invalid: \(verifyErr)" }
        let (_, reqOut, reqErr) = shell("/usr/bin/codesign", ["-dr", "-", Bundle.main.bundlePath])
        // Just the "designated => …" line (codesign also prints "Executable=…" on stderr).
        let requirement = (reqOut + "\n" + reqErr).split(separator: "\n").first { $0.hasPrefix("designated => ") }
            .map { String($0.dropFirst("designated => ".count)).trimmingCharacters(in: .whitespaces) } ?? ""
        if requirement.contains("certificate") {
            let (match, _, _) = shell("/usr/bin/codesign", ["--verify", "-R=\(requirement)", newApp.path])
            guard match == 0 else { return "The update isn't signed by the same certificate as this app; not installing it." }
        } else {
            // This copy is ad-hoc signed (older release): accept the official release certificate.
            let (_, info, infoErr) = shell("/usr/bin/codesign", ["-dvv", newApp.path])
            guard (info + infoErr).contains("Authority=VisionCLI Release") else { return "The update isn't signed with the VisionCLI release certificate." }
        }

        // Replace the installed app (keep a backup until the copy succeeds).
        let target = Bundle.main.bundlePath
        let backup = dir.appendingPathComponent("VisionCLI-old.app").path
        let (mv, _, mvErr) = shell("/bin/mv", [target, backup])
        guard mv == 0 else { return "Couldn't replace \(target): \(mvErr)" }
        let (cp, _, cpErr) = shell("/usr/bin/ditto", [newApp.path, target])
        guard cp == 0 else {
            shell("/bin/mv", [backup, target])
            return "Couldn't install the update: \(cpErr)"
        }
        shell("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", target])
        return nil
    }

    /// Start the new copy: through launchd if VisionCLI runs as the agent, otherwise with `open`.
    private static func relaunch() {
        let target = Bundle.main.bundlePath.replacingOccurrences(of: "'", with: "'\\''")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "sleep 1; launchctl kickstart -k gui/$(id -u)/\(LoginItem.label) 2>/dev/null || open -n '\(target)'"]
        try? p.run()
        CrashReporter.markCleanExit()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.terminate(nil) }
    }
}
