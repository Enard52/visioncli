import Foundation
// FluidAudio is compiled straight into this executable (no SwiftPM), so there is no resource bundle; only TTS uses it.
extension Bundle { static var module: Bundle { .main } }
