using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using static VcliWin.Native;

namespace VcliWin
{
    sealed class WinInfo
    {
        public IntPtr Hwnd;
        public string Title, Exe, App;
        public int Pid;
        public RECT Bounds;

        public Dictionary<string, object> ToJson() => Json.O(
            "hwnd", Hwnd.ToInt64().ToString(),
            "title", Title,
            "pid", Pid,
            "exe", Exe,
            "app", App,
            "bounds", Desktop.RectJson(Bounds));
    }

    // Displays, the pointer, the window list in z-order, focusing windows.
    static class Desktop
    {
        public static Dictionary<string, object> RectJson(RECT r) => Json.O("x", r.Left, "y", r.Top, "width", r.Width, "height", r.Height);

        public static List<object> Displays()
        {
            var list = new List<object>();
            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr h, IntPtr hdc, ref RECT rc, IntPtr d) =>
            {
                var mi = new MONITORINFOEX { cbSize = Marshal.SizeOf<MONITORINFOEX>() };
                if (!GetMonitorInfo(h, ref mi)) return true;
                double scale = 1;
                try { if (GetDpiForMonitor(h, 0 /* MDT_EFFECTIVE_DPI */, out uint dx, out _) == 0 && dx > 0) scale = dx / 96.0; } catch { }
                var o = RectJson(mi.rcMonitor);
                o["primary"] = (mi.dwFlags & MONITORINFOF_PRIMARY) != 0;
                o["scale"] = scale;
                list.Add(o);
                return true;
            }, IntPtr.Zero);
            return list;
        }

        public static Dictionary<string, object> Pointer()
        {
            GetCursorPos(out var p);
            return Json.O("x", p.X, "y", p.Y);
        }

        public static string ClassName(IntPtr hwnd)
        {
            var sb = new StringBuilder(256);
            GetClassName(hwnd, sb, sb.Capacity);
            return sb.ToString();
        }

        public static string Title(IntPtr hwnd)
        {
            int n = GetWindowTextLength(hwnd);
            if (n <= 0) return "";
            var sb = new StringBuilder(n + 1);
            GetWindowText(hwnd, sb, sb.Capacity);
            return sb.ToString();
        }

        public static bool Cloaked(IntPtr hwnd)
        {
            try { return DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out int c, 4) == 0 && c != 0; } catch { return false; }
        }

        /// <summary>DWM extended frame bounds: the visible frame without Windows 10's invisible resize borders.</summary>
        public static RECT Bounds(IntPtr hwnd)
        {
            try { if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out RECT r, Marshal.SizeOf<RECT>()) == 0) return r; } catch { }
            GetWindowRect(hwnd, out var w);
            return w;
        }

        static readonly HashSet<string> ShellClasses = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow",
            "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland", "XamlExplorerHostIslandWindow",
        };

        /// <summary>Alt-Tab style: visible, on this virtual desktop (not cloaked), not minimised, not a tool window
        /// unless it asks to be an app window, and titled (or explicitly an app window).</summary>
        public static bool IsAppWindow(IntPtr hwnd)
        {
            if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return false;
            long ex = GetWindowLong(hwnd, GWL_EXSTYLE);
            bool appWindow = (ex & WS_EX_APPWINDOW) != 0;
            if (!appWindow && ((ex & WS_EX_TOOLWINDOW) != 0 || (ex & WS_EX_NOACTIVATE) != 0)) return false;
            if (!appWindow && GetWindowTextLength(hwnd) == 0) return false;
            if (ShellClasses.Contains(ClassName(hwnd))) return false;
            if (Cloaked(hwnd)) return false;
            var b = Bounds(hwnd);
            return b.Width > 1 && b.Height > 1;
        }

        /// <summary>UWP apps live in ApplicationFrameHost.exe's frame; the real app is the CoreWindow child from
        /// another process.</summary>
        static uint UwpPid(IntPtr frame, uint framePid)
        {
            uint real = 0;
            EnumChildWindows(frame, (h, l) =>
            {
                GetWindowThreadProcessId(h, out uint p);
                if (p != framePid && p != 0) { real = p; return false; }
                return true;
            }, IntPtr.Zero);
            return real;
        }

        // pid → (path, app name); exe metadata doesn't change while the process lives.
        static readonly ConcurrentDictionary<uint, Tuple<string, string>> appCache = new ConcurrentDictionary<uint, Tuple<string, string>>();

        public static string ProcessPath(uint pid)
        {
            IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (h == IntPtr.Zero) return null;
            try
            {
                var sb = new StringBuilder(1024);
                uint n = (uint)sb.Capacity;
                return QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString() : null;
            }
            finally { CloseHandle(h); }
        }

        public static Tuple<string, string> AppOf(uint pid)
        {
            if (appCache.TryGetValue(pid, out var c)) return c;
            string path = ProcessPath(pid);
            string exe = path != null ? Path.GetFileName(path) : "";
            string name = null;
            if (path != null)
            {
                try
                {
                    var vi = FileVersionInfo.GetVersionInfo(path);
                    name = !string.IsNullOrWhiteSpace(vi.ProductName) ? vi.ProductName.Trim()
                         : !string.IsNullOrWhiteSpace(vi.FileDescription) ? vi.FileDescription.Trim() : null;
                    // Windows' own exes say "Microsoft® Windows® Operating System"; the description ("Notepad") is the app.
                    if (name != null && name.IndexOf("Windows", StringComparison.OrdinalIgnoreCase) >= 0 &&
                        name.IndexOf("Operating System", StringComparison.OrdinalIgnoreCase) >= 0 &&
                        !string.IsNullOrWhiteSpace(vi.FileDescription))
                        name = vi.FileDescription.Trim();
                }
                catch { }
            }
            if (string.IsNullOrEmpty(name)) name = exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? exe.Substring(0, exe.Length - 4) : exe;
            if (string.IsNullOrEmpty(name)) name = "pid " + pid;
            var r = Tuple.Create(exe, name);
            if (path != null) appCache[pid] = r;
            if (appCache.Count > 2000) appCache.Clear();
            return r;
        }

        public static WinInfo Info(IntPtr hwnd)
        {
            GetWindowThreadProcessId(hwnd, out uint pid);
            if (ClassName(hwnd) == "ApplicationFrameWindow")
            {
                uint real = UwpPid(hwnd, pid);
                if (real != 0) pid = real;
            }
            var app = AppOf(pid);
            return new WinInfo { Hwnd = hwnd, Title = Title(hwnd), Pid = (int)pid, Exe = app.Item1, App = app.Item2, Bounds = Bounds(hwnd) };
        }

        /// <summary>Top-level app windows, front-most first (EnumWindows walks the z-order top-down).</summary>
        public static List<WinInfo> Windows(int excludePid)
        {
            var hwnds = new List<IntPtr>();
            EnumWindows((h, l) => { hwnds.Add(h); return true; }, IntPtr.Zero);
            var list = new List<WinInfo>();
            foreach (var h in hwnds)
            {
                if (!IsAppWindow(h)) continue;
                var w = Info(h);
                if (excludePid != 0 && w.Pid == excludePid) continue;
                list.Add(w);
            }
            return list;
        }

        public static WinInfo Active(int excludePid)
        {
            var fg = GetForegroundWindow();
            if (fg != IntPtr.Zero)
            {
                var root = GetAncestor(fg, GA_ROOTOWNER);
                if (root != IntPtr.Zero && IsAppWindow(root)) fg = root;
                if (IsAppWindow(fg))
                {
                    var w = Info(fg);
                    if (excludePid == 0 || w.Pid != excludePid) return w;
                }
            }
            // The app's own window (or the desktop) is in front: the next one down is what the user was working in.
            var all = Windows(excludePid);
            return all.Count > 0 ? all[0] : null;
        }

        public static IntPtr ParseHwnd(string s)
        {
            if (string.IsNullOrEmpty(s) || !long.TryParse(s, out long v)) throw new ArgumentException("bad hwnd '" + s + "'");
            return new IntPtr(v);
        }

        /// <summary>SetForegroundWindow only works for the process that got the last input; a tagged empty input
        /// makes the helper that process (the hooks ignore it).</summary>
        public static bool Focus(IntPtr hwnd)
        {
            if (!IsWindow(hwnd)) return false;
            if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
            if (GetForegroundWindow() == hwnd) return true;
            for (int attempt = 0; attempt < 3; attempt++)
            {
                Input.Nudge();
                SetForegroundWindow(hwnd);
                BringWindowToTop(hwnd);
                for (int i = 0; i < 10; i++)
                {
                    if (GetForegroundWindow() == hwnd) return true;
                    Thread.Sleep(20);
                }
            }
            return GetForegroundWindow() == hwnd;
        }
    }
}
