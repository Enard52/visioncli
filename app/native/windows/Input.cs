using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using static VcliWin.Native;

namespace VcliWin
{
    // SendInput. Every event carries Native.Tag in dwExtraInfo so the helper's own hooks drop it.
    // One lock: two requests typing at once would interleave their keystrokes.
    static class Input
    {
        static readonly object gate = new object();
        static readonly int Size = Marshal.SizeOf<INPUT>();

        static void Send(List<INPUT> inputs)
        {
            if (inputs.Count == 0) return;
            uint n = SendInput((uint)inputs.Count, inputs.ToArray(), Size);
            // 0 means blocked by UIPI (an elevated window is in front) or the desktop is locked / secure.
            if (n == 0) throw new InvalidOperationException("SendInput was blocked (elevated window in front, or a locked desktop)");
        }

        static INPUT Key(ushort vk, bool up, bool extended = false)
        {
            uint flags = (up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
            return new INPUT
            {
                type = INPUT_KEYBOARD,
                u = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = (ushort)MapVirtualKey(vk, 0 /* MAPVK_VK_TO_VSC */), dwFlags = flags, dwExtraInfo = Tag } },
            };
        }

        static INPUT Unicode(char c, bool up) => new INPUT
        {
            type = INPUT_KEYBOARD,
            u = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0), dwExtraInfo = Tag } },
        };

        static INPUT Mouse(uint flags, int dx = 0, int dy = 0, int data = 0) => new INPUT
        {
            type = INPUT_MOUSE,
            u = new InputUnion { mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = unchecked((uint)data), dwFlags = flags, dwExtraInfo = Tag } },
        };

        /// <summary>An absolute move in normalised virtual-desktop coordinates (0…65535 across all monitors).</summary>
        static INPUT MoveTo(int x, int y)
        {
            int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
            int vw = Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN)), vh = Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));
            // Rounds up so the system's truncating inverse lands on the exact pixel.
            int nx = (int)(((long)(x - vx) * 65536 + vw - 1) / vw);
            int ny = (int)(((long)(y - vy) * 65536 + vh - 1) / vh);
            return Mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny);
        }

        static void MoveNow(int x, int y)
        {
            Send(new List<INPUT> { MoveTo(x, y) });
            // Normalised coordinates can be a pixel off on odd-sized desktops; this pins it exactly.
            SetCursorPos(x, y);
        }

        public static void Move(int x, int y) { lock (gate) MoveNow(x, y); }

        public static void Click(int x, int y, string button, int count)
        {
            bool right = button == "right";
            lock (gate)
            {
                MoveNow(x, y);
                Thread.Sleep(40);
                for (int i = 0; i < Math.Max(1, count); i++)
                {
                    if (i > 0) Thread.Sleep(90); // well inside the double-click time
                    Send(new List<INPUT>
                    {
                        Mouse(right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN),
                        Mouse(right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP),
                    });
                }
            }
        }

        public static void Drag(int x1, int y1, int x2, int y2)
        {
            lock (gate)
            {
                MoveNow(x1, y1);
                Thread.Sleep(50);
                Send(new List<INPUT> { Mouse(MOUSEEVENTF_LEFTDOWN) });
                const int steps = 20;
                try
                {
                    for (int i = 1; i <= steps; i++)
                    {
                        double t = (double)i / steps;
                        Send(new List<INPUT> { MoveTo((int)Math.Round(x1 + (x2 - x1) * t), (int)Math.Round(y1 + (y2 - y1) * t)) });
                        Thread.Sleep(12);
                    }
                    SetCursorPos(x2, y2);
                }
                finally { Send(new List<INPUT> { Mouse(MOUSEEVENTF_LEFTUP) }); }
            }
        }

        /// <summary>dy &gt; 0 scrolls up, dy &lt; 0 down, dx &gt; 0 left (the macOS/xdotool convention); one unit = one notch.</summary>
        public static void Scroll(double dx, double dy, int? x, int? y)
        {
            lock (gate)
            {
                if (x.HasValue && y.HasValue) { MoveNow(x.Value, y.Value); Thread.Sleep(40); }
                var list = new List<INPUT>();
                int ny = (int)Math.Round(dy), nx = (int)Math.Round(dx);
                if (ny != 0) list.Add(Mouse(MOUSEEVENTF_WHEEL, 0, 0, ny * 120));        // WHEEL: positive = away from the user (up)
                if (nx != 0) list.Add(Mouse(MOUSEEVENTF_HWHEEL, 0, 0, -nx * 120));      // HWHEEL: positive = right
                Send(list);
            }
        }

        /// <summary>Text as KEYEVENTF_UNICODE per UTF-16 unit (surrogate pairs go as their two units, which
        /// TranslateMessage turns into two WM_CHARs). Newlines and tabs are real Enter/Tab presses.</summary>
        public static void Type(string text)
        {
            text = text.Replace("\r\n", "\n");
            lock (gate)
            {
                var batch = new List<INPUT>();
                for (int i = 0; i < text.Length; i++)
                {
                    char c = text[i];
                    if (c == '\n' || c == '\r') { batch.Add(Key(0x0D, false)); batch.Add(Key(0x0D, true)); }
                    else if (c == '\t') { batch.Add(Key(0x09, false)); batch.Add(Key(0x09, true)); }
                    else if (char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
                    {
                        char lo = text[++i];
                        batch.Add(Unicode(c, false)); batch.Add(Unicode(c, true));
                        batch.Add(Unicode(lo, false)); batch.Add(Unicode(lo, true));
                    }
                    else { batch.Add(Unicode(c, false)); batch.Add(Unicode(c, true)); }
                    // Small batches with a breath in between: some apps (Electron, terminals) drop huge bursts.
                    if (batch.Count >= 40) { Send(batch); batch.Clear(); Thread.Sleep(8); }
                }
                Send(batch);
            }
        }

        public static void Combo(string combo)
        {
            var chords = Keys.Parse(combo);
            lock (gate)
            {
                foreach (var ch in chords)
                {
                    var list = new List<INPUT>();
                    foreach (var m in ch.Mods) list.Add(Key(m, false, m == Keys.VK_LWIN));
                    list.Add(Key(ch.Vk, false, ch.Extended));
                    list.Add(Key(ch.Vk, true, ch.Extended));
                    for (int i = ch.Mods.Count - 1; i >= 0; i--) list.Add(Key(ch.Mods[i], true, ch.Mods[i] == Keys.VK_LWIN));
                    Send(list);
                    if (chords.Count > 1) Thread.Sleep(30);
                }
            }
        }

        /// <summary>An empty (tagged) mouse input: makes the helper the process that got the last input, which
        /// SetForegroundWindow requires (PowerToys does the same). Unlike an Alt tap it can't open a menu bar.</summary>
        public static void Nudge()
        {
            lock (gate)
            {
                try { Send(new List<INPUT> { Mouse(0) }); } catch { }
            }
        }
    }

    sealed class Chord
    {
        public List<ushort> Mods = new List<ushort>();
        public ushort Vk;
        public bool Extended;
    }

    // Key combos in the macOS app's names ("cmd+shift+s", "option+left", "return", "ctrl+shift+s enter"), the same
    // vocabulary as app/src/main/desktop/input/keys.ts: ⌘/cmd → Win, ⌥/option → Alt; "delete" is Backspace like on a Mac
    // keyboard and "forwarddelete"/"del" is Delete.
    static class Keys
    {
        public const ushort VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12, VK_LWIN = 0x5B;

        static readonly Dictionary<string, ushort> Mods = new Dictionary<string, ushort>
        {
            ["cmd"] = VK_LWIN, ["command"] = VK_LWIN, ["⌘"] = VK_LWIN, ["super"] = VK_LWIN, ["win"] = VK_LWIN, ["meta"] = VK_LWIN, ["windows"] = VK_LWIN,
            ["alt"] = VK_MENU, ["option"] = VK_MENU, ["opt"] = VK_MENU, ["⌥"] = VK_MENU,
            ["ctrl"] = VK_CONTROL, ["control"] = VK_CONTROL, ["⌃"] = VK_CONTROL,
            ["shift"] = VK_SHIFT, ["⇧"] = VK_SHIFT,
        };

        // vk, extended
        static readonly Dictionary<string, Tuple<ushort, bool>> Named = new Dictionary<string, Tuple<ushort, bool>>();

        static Keys()
        {
            void N(ushort vk, bool ext, params string[] names) { foreach (var n in names) Named[n] = Tuple.Create(vk, ext); }
            N(0x0D, false, "return", "enter");
            N(0x09, false, "tab");
            N(0x20, false, "space");
            N(0x08, false, "delete", "backspace");
            N(0x2E, true, "forwarddelete", "del");
            N(0x1B, false, "escape", "esc");
            N(0x2D, true, "insert");
            N(0x25, true, "left"); N(0x26, true, "up"); N(0x27, true, "right"); N(0x28, true, "down");
            N(0x24, true, "home"); N(0x23, true, "end"); N(0x21, true, "pageup"); N(0x22, true, "pagedown");
            N(0x14, false, "capslock");
            N(0x2C, true, "printscreen");
            N(0x5D, true, "menu", "apps");
            for (int i = 1; i <= 24; i++) N((ushort)(0x70 + i - 1), false, "f" + i);
            for (char c = 'a'; c <= 'z'; c++) N((ushort)char.ToUpperInvariant(c), false, c.ToString());
            for (char c = '0'; c <= '9'; c++) N(c, false, c.ToString());
        }

        // Punctuation names (X keysym style, as keys.ts) → the character VkKeyScan looks up in the current layout.
        static readonly Dictionary<string, char> Punct = new Dictionary<string, char>
        {
            ["minus"] = '-', ["equal"] = '=', ["bracketleft"] = '[', ["bracketright"] = ']', ["semicolon"] = ';',
            ["apostrophe"] = '\'', ["quote"] = '\'', ["comma"] = ',', ["period"] = '.', ["slash"] = '/', ["backslash"] = '\\',
            ["grave"] = '`', ["backtick"] = '`', ["plus"] = '+',
        };

        /// <summary>"ctrl+shift+s enter" → one chord per space-separated combo. Throws like Computer.press.</summary>
        public static List<Chord> Parse(string combo)
        {
            string s = System.Text.RegularExpressions.Regex.Replace((combo ?? "").Trim().ToLowerInvariant(), @"\s*\+\s*", "+");
            if (s.Length == 0) throw new ArgumentException("No key in \"" + combo + "\"");
            var result = new List<Chord>();
            foreach (var part in s.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries))
            {
                List<string> parts;
                // "+" alone or as the last part means the plus key ("ctrl++").
                if (part == "+") parts = new List<string> { "plus" };
                else if (part.EndsWith("++")) { parts = new List<string>(part.Substring(0, part.Length - 2).Split('+')); parts.Add("plus"); }
                else parts = new List<string>(part.Split('+'));
                var ch = new Chord();
                bool haveKey = false;
                foreach (var p in parts)
                {
                    if (p.Length == 0) continue;
                    if (Mods.TryGetValue(p, out var m)) { if (!ch.Mods.Contains(m)) ch.Mods.Add(m); continue; }
                    if (p == "fn") continue;
                    // "vk:0xE8": a raw virtual-key code (the hotkeys use an unassigned one to mask the Start menu).
                    if (p.StartsWith("vk:"))
                    {
                        string num = p.Substring(3);
                        bool hex = num.StartsWith("0x");
                        if (int.TryParse(hex ? num.Substring(2) : num, hex ? System.Globalization.NumberStyles.HexNumber : System.Globalization.NumberStyles.Integer,
                                System.Globalization.CultureInfo.InvariantCulture, out int vk) && vk > 0 && vk < 256)
                        { ch.Vk = (ushort)vk; haveKey = true; continue; }
                    }
                    if (Named.TryGetValue(p, out var k)) { ch.Vk = k.Item1; ch.Extended = k.Item2; haveKey = true; continue; }
                    char c = Punct.TryGetValue(p, out var pc) ? pc : (p.Length == 1 ? p[0] : '\0');
                    if (c != '\0')
                    {
                        short r = VkKeyScan(c);
                        if (r != -1)
                        {
                            ch.Vk = (ushort)(r & 0xff);
                            int shift = (r >> 8) & 0xff;
                            if ((shift & 1) != 0 && !ch.Mods.Contains(VK_SHIFT)) ch.Mods.Add(VK_SHIFT);
                            if ((shift & 2) != 0 && !ch.Mods.Contains(VK_CONTROL)) ch.Mods.Add(VK_CONTROL);
                            if ((shift & 4) != 0 && !ch.Mods.Contains(VK_MENU)) ch.Mods.Add(VK_MENU);
                            haveKey = true;
                            continue;
                        }
                    }
                    throw new ArgumentException("Unknown key \"" + p + "\"");
                }
                if (!haveKey) throw new ArgumentException("No key in \"" + combo + "\"");
                result.Add(ch);
            }
            return result;
        }
    }
}
