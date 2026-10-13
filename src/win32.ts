import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Windows fallbacks for when the VisionCLI app isn't running (the app's helper, vcli-win.exe, does all of this
// faster and better). Everything goes through Windows PowerShell 5.1, which every Windows 10/11 has: a few user32
// calls compiled with Add-Type and System.Drawing for the pixels. The process is made DPI-aware first, so window
// bounds, the pointer and screenshots are physical pixels, the same space the app's helper reports.

const run = promisify(execFile);

export interface Rect { x: number; y: number; width: number; height: number }
export interface WinListed { id: number; app: string; title: string; bounds: Rect }

/** A PowerShell single-quoted string literal (only ' needs escaping, by doubling it). */
export const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** -EncodedCommand takes base64 of UTF-16LE: no quoting rules to get wrong for paths or titles. */
export const encodeCommand = (script: string) => Buffer.from(script, "utf16le").toString("base64");

const TYPES = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class VcliWinRow { public long id; public string title; public uint pid; public int x, y, w, h; }
public static class VcliWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int n);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int n);
  // Visible, titled, not minimized, not a tool window, not cloaked (other virtual desktop): front-most first (z-order).
  public static List<VcliWinRow> Windows() {
    var rows = new List<VcliWinRow>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h) || (GetWindowLong(h, -20) & 0x80) != 0) return true;
      int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (sb.Length == 0) return true;
      RECT r; if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) GetWindowRect(h, out r);
      uint pid; GetWindowThreadProcessId(h, out pid);
      rows.Add(new VcliWinRow { id = h.ToInt64(), title = sb.ToString(), pid = pid, x = r.L, y = r.T, w = r.R - r.L, h = r.B - r.T });
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
'@
[void][VcliWin]::SetProcessDPIAware()
function Save-Jpeg($bmp, $out, $max) {
  $s = [Math]::Min(1.0, $max / [Math]::Max($bmp.Width, $bmp.Height))
  $W = [int][Math]::Max(1, [Math]::Round($bmp.Width * $s)); $H = [int][Math]::Max(1, [Math]::Round($bmp.Height * $s))
  $o = $bmp
  if ($s -lt 1) {
    $o = New-Object System.Drawing.Bitmap $W, $H
    $g = [System.Drawing.Graphics]::FromImage($o)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($bmp, 0, 0, $W, $H); $g.Dispose()
  }
  $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 85L
  $o.Save($out, $enc, $ep)
  "$W $H"
}
function Get-Pointer { $p = New-Object VcliWin+POINT; [void][VcliWin]::GetCursorPos([ref]$p); @{ x = $p.X; y = $p.Y } }
`;

/** Runs a Windows PowerShell script; `types: false` skips compiling the user32 helpers (about a second). */
export async function powershell(body: string, timeout = 20_000, types = true): Promise<string> {
  const { stdout } = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodeCommand((types ? TYPES : "") + body)],
    { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout.trim();
}

/** The list script's JSON: {windows: [{id, title, app, x, y, w, h}], pointer: {x, y}} (PowerShell 5 unwraps 1-element arrays). */
export function parseWindows(json: string): { windows: WinListed[]; pointer?: { x: number; y: number } } {
  const r = JSON.parse(json || "{}");
  const rows = r.windows == null ? [] : Array.isArray(r.windows) ? r.windows : [r.windows];
  return {
    windows: rows.map((w: any) => ({
      id: Number(w.id), app: String(w.app ?? ""), title: String(w.title ?? ""),
      bounds: { x: Number(w.x), y: Number(w.y), width: Number(w.w), height: Number(w.h) },
    })),
    pointer: r.pointer ? { x: Number(r.pointer.x), y: Number(r.pointer.y) } : undefined,
  };
}

/** On-screen windows, front-most first, and the pointer. */
export async function listWindows(): Promise<{ windows: WinListed[]; pointer?: { x: number; y: number } }> {
  return parseWindows(await powershell(`
$names = @{}
$rows = foreach ($w in [VcliWin]::Windows()) {
  if (-not $names.ContainsKey($w.pid)) {
    $n = ''; $prod = ''
    try { $p = Get-Process -Id $w.pid -ErrorAction Stop; $n = $p.ProcessName; $prod = $p.MainModule.FileVersionInfo.ProductName } catch {}
    $names[$w.pid] = @($n, $prod)
  }
  $n, $prod = $names[$w.pid]
  if ($prod -and $prod -notmatch 'operating system') { $n = $prod }
  @{ id = $w.id; title = $w.title; app = $n; x = $w.x; y = $w.y; w = $w.w; h = $w.h }
}
ConvertTo-Json -Compress -Depth 4 -InputObject @{ windows = @($rows); pointer = (Get-Pointer) }`));
}

export async function pointer(): Promise<{ x: number; y: number }> {
  return JSON.parse(await powershell(`ConvertTo-Json -Compress -InputObject (Get-Pointer)`));
}

/** "W H" printed by Save-Jpeg. */
export function parseSize(out: string): { width: number; height: number } | null {
  const m = /(\d+)\s+(\d+)\s*$/.exec(out);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/**
 * Screen pixels → JPEG (longest side ≤ maxDim). `rect`: that area of the virtual screen (a window's bounds, or a
 * display the app reported); else display N, counted primary first like the app does.
 */
export async function capture(out: string, maxDim: number, rect?: Rect | null, display = 1) {
  if (rect && (rect.width < 1 || rect.height < 1)) throw new Error("That window has no visible area to capture.");
  const area = rect
    ? `$x = ${Math.round(rect.x)}; $y = ${Math.round(rect.y)}; $w = ${Math.round(rect.width)}; $h = ${Math.round(rect.height)}`
    : `$all = @([System.Windows.Forms.Screen]::AllScreens | Sort-Object { -not $_.Primary })
$b = $all[[Math]::Min(${Math.max(0, display - 1)}, $all.Count - 1)].Bounds
$x = $b.X; $y = $b.Y; $w = $b.Width; $h = $b.Height`;
  const size = parseSize(await powershell(`${area}
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size); $g.Dispose()
Save-Jpeg $bmp ${psQuote(out)} ${maxDim}`));
  if (!size) throw new Error("The screenshot failed (PowerShell gave no image).");
  return size;
}

/** The clipboard's image → JPEG; null when there isn't one. */
export async function captureClipboard(out: string, maxDim: number) {
  return parseSize(await powershell(`$i = [System.Windows.Forms.Clipboard]::GetImage()
if ($i) { Save-Jpeg $i ${psQuote(out)} ${maxDim} }`));
}

/**
 * The user drags a rectangle with Windows' own snipping overlay (ms-screenclip:, what Win+Shift+S opens); the snip
 * lands on the clipboard, which we watch. Null when they cancel (the overlay closed without a new image) or after
 * 90 s. Windows offers no way to get the snip without the clipboard, so the user's clipboard ends up holding it.
 */
export async function captureRegion(out: string, maxDim: number) {
  try {
    return parseSize(await powershell(`
$seq = [VcliWin]::GetClipboardSequenceNumber()
Start-Process 'ms-screenclip:'
$seen = $false; $gone = 0
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 250
  if ([VcliWin]::GetClipboardSequenceNumber() -ne $seq) {
    $i = [System.Windows.Forms.Clipboard]::GetImage()
    if ($i) { Save-Jpeg $i ${psQuote(out)} ${maxDim}; exit 0 }
    $seq = [VcliWin]::GetClipboardSequenceNumber()
  }
  if (Get-Process ScreenClippingHost, SnippingTool -ErrorAction SilentlyContinue) { $seen = $true; $gone = 0 }
  elseif ($seen -and ++$gone -ge 4) { exit 3 }
}
exit 3`, 100_000));
  } catch (err: any) {
    if (err?.code === 3) return null;
    throw err;
  }
}

/** Image names of running processes, lower-case, from `tasklist /fo csv /nh` ("chrome.exe","1234","Console",...). */
export function parseTasklist(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) names.add(m[1].toLowerCase());
  }
  return names;
}

export async function runningImages(): Promise<Set<string>> {
  try {
    return parseTasklist((await run("tasklist", ["/fo", "csv", "/nh"], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout);
  } catch {
    return new Set();
  }
}
