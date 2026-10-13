using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using static VcliWin.Native;

namespace VcliWin
{
    // Window and screen-rect capture → JPEG q85, longest side ≤ maxDim (like the macOS capture).
    static class Capture
    {
        const uint PW_RENDERFULLCONTENT = 2; // Windows 8.1+: renders DirectComposition/GPU content (Chromium, UWP)

        public static Dictionary<string, object> Run(Args a)
        {
            string file = a.Need("file");
            int maxDim = a.Int("maxDim", 0);
            Bitmap bmp;
            if (a.Has("hwnd")) bmp = Window(Desktop.ParseHwnd(a.Str("hwnd")));
            else
            {
                var r = a.Obj("rect") ?? throw new ArgumentException("capture needs hwnd or rect");
                bmp = Screen(r.Int("x"), r.Int("y"), r.Int("width"), r.Int("height"));
            }
            using (bmp)
            using (var scaled = Downscale(bmp, maxDim))
            {
                SaveJpeg(scaled ?? bmp, file, 85);
                var img = scaled ?? bmp;
                return Json.O("width", img.Width, "height", img.Height);
            }
        }

        public static Bitmap Screen(int x, int y, int w, int h)
        {
            if (w <= 0 || h <= 0) throw new ArgumentException("empty capture rect");
            var bmp = new Bitmap(w, h, PixelFormat.Format32bppRgb);
            // BitBlt from the screen DC with CAPTUREBLT, which includes layered (translucent) windows. (Graphics.CopyFromScreen
            // rejects SourceCopy | CaptureBlt: it validates the operation as a single enum value.)
            IntPtr screen = GetDC(IntPtr.Zero);
            try
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    IntPtr hdc = g.GetHdc();
                    int err = 0;
                    try { if (!BitBlt(hdc, 0, 0, w, h, screen, x, y, SRCCOPY | CAPTUREBLT)) err = Marshal.GetLastWin32Error(); }
                    finally { g.ReleaseHdc(hdc); }
                    if (err != 0) { bmp.Dispose(); throw new System.ComponentModel.Win32Exception(err); }
                }
            }
            finally { ReleaseDC(IntPtr.Zero, screen); }
            return bmp;
        }

        /// <summary>PrintWindow renders the window even when covered; it can come back black (some GPU surfaces,
        /// protected content), and then a copy of the screen at the window's bounds is the best there is.</summary>
        public static Bitmap Window(IntPtr hwnd)
        {
            if (!IsWindow(hwnd)) throw new ArgumentException("no such window");
            var b = Desktop.Bounds(hwnd);
            if (b.Width <= 0 || b.Height <= 0) throw new InvalidOperationException("window has no size");
            GetWindowRect(hwnd, out var wr);
            Bitmap full = null;
            try
            {
                if (wr.Width > 0 && wr.Height > 0 && !IsIconic(hwnd))
                {
                    full = new Bitmap(wr.Width, wr.Height, PixelFormat.Format32bppRgb);
                    bool ok;
                    using (var g = Graphics.FromImage(full))
                    {
                        IntPtr hdc = g.GetHdc();
                        try { ok = PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT); }
                        finally { g.ReleaseHdc(hdc); }
                    }
                    if (ok)
                    {
                        // Crop the invisible resize borders: GetWindowRect includes them, the DWM frame doesn't.
                        var crop = Rectangle.Intersect(new Rectangle(b.Left - wr.Left, b.Top - wr.Top, b.Width, b.Height),
                                                       new Rectangle(0, 0, full.Width, full.Height));
                        if (crop.Width > 0 && crop.Height > 0)
                        {
                            var cut = full.Clone(crop, PixelFormat.Format32bppRgb);
                            if (!IsBlack(cut)) return cut;
                            cut.Dispose();
                        }
                    }
                }
            }
            catch (Exception e) { Log.Write("PrintWindow failed: " + e.Message); }
            finally { full?.Dispose(); }
            return Screen(b.Left, b.Top, b.Width, b.Height);
        }

        /// <summary>True when a grid of samples is all (near) black.</summary>
        public static bool IsBlack(Bitmap bmp)
        {
            int w = bmp.Width, h = bmp.Height;
            const int N = 16;
            for (int iy = 0; iy < N; iy++)
                for (int ix = 0; ix < N; ix++)
                {
                    var c = bmp.GetPixel(Math.Min(w - 1, (ix * 2 + 1) * w / (2 * N)), Math.Min(h - 1, (iy * 2 + 1) * h / (2 * N)));
                    if (c.R > 8 || c.G > 8 || c.B > 8) return false;
                }
            return true;
        }

        /// <summary>A high-quality bicubic copy with the longest side = maxDim, or null when it already fits.</summary>
        public static Bitmap Downscale(Bitmap src, int maxDim)
        {
            int longest = Math.Max(src.Width, src.Height);
            if (maxDim <= 0 || longest <= maxDim) return null;
            double s = (double)maxDim / longest;
            int w = Math.Max(1, (int)Math.Round(src.Width * s)), h = Math.Max(1, (int)Math.Round(src.Height * s));
            var dst = new Bitmap(w, h, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(dst))
            using (var attrs = new ImageAttributes())
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.CompositingQuality = CompositingQuality.HighQuality;
                g.SmoothingMode = SmoothingMode.HighQuality;
                attrs.SetWrapMode(WrapMode.TileFlipXY); // no dark fringe at the edges
                g.DrawImage(src, new Rectangle(0, 0, w, h), 0, 0, src.Width, src.Height, GraphicsUnit.Pixel, attrs);
            }
            return dst;
        }

        public static void SaveJpeg(Image img, string file, long quality)
        {
            var dir = Path.GetDirectoryName(file);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            ImageCodecInfo jpeg = null;
            foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.FormatID == ImageFormat.Jpeg.Guid) jpeg = c;
            using (var ps = new EncoderParameters(1))
            {
                ps.Param[0] = new EncoderParameter(Encoder.Quality, quality);
                // Write to a temp file and rename, so a reader never sees half a JPEG.
                string tmp = file + ".tmp";
                img.Save(tmp, jpeg, ps);
                if (File.Exists(file)) File.Delete(file);
                File.Move(tmp, file);
            }
        }
    }
}
