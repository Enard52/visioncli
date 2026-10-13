using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using static VcliWin.Native;

namespace VcliWin
{
    // Processes for terminal mode: no Windows CLI tool exposes another process's current directory, so it's read
    // from the process's PEB (RTL_USER_PROCESS_PARAMETERS), like Process Explorer does.
    static class Processes
    {
        public static List<object> List(List<string> names)
        {
            var filter = names == null || names.Count == 0 ? null : new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (filter != null) foreach (var n in names) filter.Add(Bare(n));
            var list = new List<object>();
            IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (snap == INVALID_HANDLE_VALUE) throw new InvalidOperationException("CreateToolhelp32Snapshot failed");
            try
            {
                var e = new PROCESSENTRY32W { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32W>() };
                for (bool ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e))
                {
                    if (filter != null && !filter.Contains(Bare(e.szExeFile))) continue;
                    ReadParams(e.th32ProcessID, out string cmdline, out string cwd);
                    list.Add(Json.O("pid", (int)e.th32ProcessID, "ppid", (int)e.th32ParentProcessID, "exe", e.szExeFile,
                        "cmdline", cmdline ?? "", "cwd", cwd));
                }
            }
            finally { CloseHandle(snap); }
            return list;
        }

        static string Bare(string n) => n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? n.Substring(0, n.Length - 4) : n;

        /// <summary>Command line and current directory from the PEB. Only for 64-bit targets from a 64-bit helper
        /// (WOW64 processes have a 32-bit PEB elsewhere); null on any failure (access denied, protected processes).</summary>
        public static void ReadParams(uint pid, out string cmdline, out string cwd)
        {
            cmdline = null; cwd = null;
            if (!Environment.Is64BitProcess || pid == 0) return;
            IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, pid);
            if (h == IntPtr.Zero) return;
            try
            {
                if (IsWow64Process(h, out bool wow) && wow) return;
                var pbi = new PROCESS_BASIC_INFORMATION();
                if (NtQueryInformationProcess(h, 0 /* ProcessBasicInformation */, ref pbi, Marshal.SizeOf<PROCESS_BASIC_INFORMATION>(), out _) != 0) return;
                if (pbi.PebBaseAddress == IntPtr.Zero) return;
                // PEB+0x20: ProcessParameters. RTL_USER_PROCESS_PARAMETERS+0x38: CurrentDirectory.DosPath, +0x70: CommandLine.
                IntPtr pp = ReadPtr(h, pbi.PebBaseAddress + 0x20);
                if (pp == IntPtr.Zero) return;
                cwd = ReadUnicodeString(h, pp + 0x38);
                cmdline = ReadUnicodeString(h, pp + 0x70);
                if (cwd != null && cwd.Length > 3 && cwd.EndsWith("\\")) cwd = cwd.Substring(0, cwd.Length - 1);
                if (cwd == "") cwd = null;
            }
            catch { }
            finally { CloseHandle(h); }
        }

        static IntPtr ReadPtr(IntPtr h, IntPtr addr)
        {
            var b = new byte[8];
            if (!ReadProcessMemory(h, addr, b, new IntPtr(8), out _)) return IntPtr.Zero;
            return new IntPtr(BitConverter.ToInt64(b, 0));
        }

        // UNICODE_STRING (x64): USHORT Length, USHORT MaximumLength, 4 bytes padding, PWSTR Buffer.
        static string ReadUnicodeString(IntPtr h, IntPtr addr)
        {
            var us = new byte[16];
            if (!ReadProcessMemory(h, addr, us, new IntPtr(16), out _)) return null;
            int len = BitConverter.ToUInt16(us, 0);
            var buf = new IntPtr(BitConverter.ToInt64(us, 8));
            if (len == 0 || buf == IntPtr.Zero) return "";
            var s = new byte[len];
            if (!ReadProcessMemory(h, buf, s, new IntPtr(len), out _)) return null;
            return Encoding.Unicode.GetString(s);
        }
    }
}
