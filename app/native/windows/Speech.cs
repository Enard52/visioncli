using System;
using System.Collections.Generic;
using System.IO;
using System.Speech.Synthesis;

namespace VcliWin
{
    // SAPI 5 voices through System.Speech (the "Microsoft David/Zira/…" voices every Windows has).
    static class Speech
    {
        public static List<object> Voices()
        {
            var list = new List<object>();
            using (var s = new SpeechSynthesizer())
                foreach (var v in s.GetInstalledVoices())
                    if (v.Enabled) list.Add(v.VoiceInfo.Name);
            return list;
        }

        public static bool Speak(string text, string voice, int rate, string file)
        {
            var dir = Path.GetDirectoryName(file);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            using (var s = new SpeechSynthesizer())
            {
                if (!string.IsNullOrEmpty(voice))
                {
                    try { s.SelectVoice(voice); }
                    catch (ArgumentException) { throw new ArgumentException("no voice named '" + voice + "'"); }
                }
                s.Rate = Math.Max(-10, Math.Min(10, rate));
                s.SetOutputToWaveFile(file);
                try { s.Speak(text ?? ""); }
                finally { s.SetOutputToNull(); }
            }
            return true;
        }
    }
}
