using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using static VcliWin.Native;

namespace VcliWin
{
    /// <summary>An STA thread running a message loop, with Invoke onto it. Low-level hooks are called on the thread
    /// that installed them while it pumps messages; the clipboard wants STA (OLE).</summary>
    sealed class Pump
    {
        readonly Control control;
        public Pump(string name)
        {
            Control c = null;
            var ready = new ManualResetEventSlim();
            var t = new Thread(() =>
            {
                c = new Control();
                c.CreateControl();
                _ = c.Handle;
                ready.Set();
                Application.Run();
            }) { IsBackground = true, Name = name };
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
            ready.Wait();
            control = c;
        }

        public T Invoke<T>(Func<T> f)
        {
            T r = default;
            Exception err = null;
            control.Invoke(new Action(() => { try { r = f(); } catch (Exception e) { err = e; } }));
            if (err != null) throw err;
            return r;
        }
    }

    // WH_KEYBOARD_LL / WH_MOUSE_LL on their own pump thread, so nothing else (clipboard, UIA) can delay them:
    // Windows silently unhooks a hook that keeps exceeding LowLevelHooksTimeout. The callbacks only format a short line
    // and queue it; they never swallow input (always CallNextHookEx).
    static class Hooks
    {
        static Pump pump;
        static IntPtr kb = IntPtr.Zero, mouse = IntPtr.Zero;
        static HookProc kbProc, mouseProc; // kept alive: the GC must not collect a delegate Windows still calls
        static int lastMotion;
        public static Action<string, Dictionary<string, object>> Emit = (e, d) => { };

        const int WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
        const int WM_MOUSEMOVE = 0x200, WM_LBUTTONDOWN = 0x201, WM_LBUTTONUP = 0x202, WM_RBUTTONDOWN = 0x204, WM_RBUTTONUP = 0x205,
            WM_MBUTTONDOWN = 0x207, WM_MBUTTONUP = 0x208, WM_XBUTTONDOWN = 0x20B, WM_XBUTTONUP = 0x20C;

        static readonly object gate = new object();

        public static bool Start()
        {
            lock (gate) if (pump == null) pump = new Pump("hooks");
            return pump.Invoke(() =>
            {
                if (kb != IntPtr.Zero) return true;
                kbProc = KeyProc;
                mouseProc = MouseProc;
                IntPtr mod = GetModuleHandle(null);
                kb = SetWindowsHookEx(WH_KEYBOARD_LL, kbProc, mod, 0);
                mouse = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, mod, 0);
                if (kb == IntPtr.Zero || mouse == IntPtr.Zero)
                {
                    int err = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
                    StopNow();
                    throw new InvalidOperationException("SetWindowsHookEx failed (" + err + ")");
                }
                return true;
            });
        }

        public static bool Stop()
        {
            lock (gate) if (pump == null) return true;
            return pump.Invoke(() => { StopNow(); return true; });
        }

        static void StopNow()
        {
            if (kb != IntPtr.Zero) UnhookWindowsHookEx(kb);
            if (mouse != IntPtr.Zero) UnhookWindowsHookEx(mouse);
            kb = mouse = IntPtr.Zero;
        }

        static IntPtr KeyProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                try
                {
                    var k = System.Runtime.InteropServices.Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
                    if (k.dwExtraInfo != Tag)
                    {
                        int m = wParam.ToInt32();
                        bool down = m == WM_KEYDOWN || m == WM_SYSKEYDOWN;
                        if (down || m == WM_KEYUP || m == WM_SYSKEYUP)
                            Emit("key", Json.O("vk", (int)k.vkCode, "down", down, "injected", (k.flags & LLKHF_INJECTED) != 0));
                    }
                }
                catch { }
            }
            return CallNextHookEx(kb, nCode, wParam, lParam);
        }

        static IntPtr MouseProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                try
                {
                    var ms = System.Runtime.InteropServices.Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
                    if (ms.dwExtraInfo != Tag)
                    {
                        int m = wParam.ToInt32();
                        string button = null;
                        bool down = false;
                        switch (m)
                        {
                            case WM_MOUSEMOVE:
                                int now = Environment.TickCount;
                                if (now - lastMotion >= 16) // ~60/s
                                {
                                    lastMotion = now;
                                    Emit("motion", Json.O("x", ms.pt.X, "y", ms.pt.Y));
                                }
                                break;
                            case WM_LBUTTONDOWN: button = "left"; down = true; break;
                            case WM_LBUTTONUP: button = "left"; break;
                            case WM_RBUTTONDOWN: button = "right"; down = true; break;
                            case WM_RBUTTONUP: button = "right"; break;
                            case WM_MBUTTONDOWN: button = "middle"; down = true; break;
                            case WM_MBUTTONUP: button = "middle"; break;
                            case WM_XBUTTONDOWN: case WM_XBUTTONUP:
                                button = ((ms.mouseData >> 16) & 0xffff) == 2 ? "x2" : "x1";
                                down = m == WM_XBUTTONDOWN;
                                break;
                        }
                        if (button != null) Emit("button", Json.O("button", button, "down", down));
                    }
                }
                catch { }
            }
            return CallNextHookEx(mouse, nCode, wParam, lParam);
        }
    }

    // Clipboard on its own STA pump.
    static class Clip
    {
        static readonly Lazy<Pump> pump = new Lazy<Pump>(() => new Pump("clipboard"));

        // The clipboard can be held open by another app for a moment: retry briefly.
        static T Retry<T>(Func<T> f)
        {
            for (int i = 0; ; i++)
            {
                try { return f(); }
                catch (System.Runtime.InteropServices.ExternalException) when (i < 5) { Thread.Sleep(50); }
            }
        }

        /// <summary>Writes the clipboard image as PNG; prefers the "PNG" format (keeps alpha) over the DIB.</summary>
        public static bool Image(string file) => pump.Value.Invoke(() => Retry(() =>
        {
            var data = Clipboard.GetDataObject();
            if (data == null) return false;
            var dir = Path.GetDirectoryName(file);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            if (data.GetDataPresent("PNG") && data.GetData("PNG") is MemoryStream png)
            {
                using (var img = System.Drawing.Image.FromStream(png)) img.Save(file, ImageFormat.Png);
                return true;
            }
            if (!Clipboard.ContainsImage())
            {
                // A copied image file (Explorer) counts too, like on macOS.
                if (Clipboard.ContainsFileDropList())
                    foreach (var f in Clipboard.GetFileDropList())
                    {
                        try { using (var img = System.Drawing.Image.FromFile(f)) img.Save(file, ImageFormat.Png); return true; } catch { }
                    }
                return false;
            }
            using (var img = Clipboard.GetImage())
            {
                if (img == null) return false;
                img.Save(file, ImageFormat.Png);
                return true;
            }
        }));

        public static bool SetText(string text) => pump.Value.Invoke(() => Retry(() =>
        {
            if (string.IsNullOrEmpty(text)) Clipboard.Clear();
            else Clipboard.SetText(text, TextDataFormat.UnicodeText);
            return true;
        }));

        public static string GetText() => pump.Value.Invoke(() => Retry(() =>
            Clipboard.ContainsText(TextDataFormat.UnicodeText) ? Clipboard.GetText(TextDataFormat.UnicodeText) : ""));
    }
}
