# Job Object 協助程序（2026-10-03；v11.6 §5.19「殺程序不要靠父程序編號往下找子孫」）。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/jobhelper.ps1 -TargetPid <要放進 Job 的程序>
#
# 為什麼要這支：Node 沒有建立 Job Object 的 API。這支用 P/Invoke 建一個 Job，設成
#   · JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE：Job 的最後一個 handle 關掉時，裡面的程序全部連帶殺掉
#   · 不設 BREAKAWAY_OK／SILENT_BREAKAWAY_OK：裡面的程序開的子孫不准脫離 Job（detached 也逃不掉）
# 把 -TargetPid 放進去之後印一行「JOB-OK <pid>」，然後一直讀標準輸入；標準輸入被關掉（呼叫它的程序結束或被殺）
# 這支就結束——它持有的 Job handle 跟著關掉，Job 裡的程序全部被殺。
# 放進去之後才開的子孫自動屬於這個 Job，**不看父程序編號**：中間那一支先結束（Git Bash 的分叉、detached）也照樣在 Job 裡。
# 任何一步失敗就印「JOB-FAIL <原因>」並以 1 結束（呼叫端判成情境未成立，不照跑）。

param([Parameter(Mandatory = $true)][int]$TargetPid)

$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SdJob {
  [StructLayout(LayoutKind.Sequential)] public struct BASIC { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] public struct IOC { public ulong a; public ulong b; public ulong c; public ulong d; public ulong e; public ulong f; }
  [StructLayout(LayoutKind.Sequential)] public struct EXT { public BASIC Basic; public IOC Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT info, uint len);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  public static string Make(int pid) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return "CreateJobObject 失敗 " + Marshal.GetLastWin32Error();
    EXT info = new EXT();
    info.Basic.LimitFlags = 0x2000;   // KILL_ON_JOB_CLOSE；不加 0x800（BREAKAWAY_OK）也不加 0x1000（SILENT_BREAKAWAY_OK）
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(EXT)))) return "SetInformationJobObject 失敗 " + Marshal.GetLastWin32Error();
    IntPtr p = OpenProcess(0x0100 | 0x0001, false, pid);   // PROCESS_SET_QUOTA | PROCESS_TERMINATE
    if (p == IntPtr.Zero) return "OpenProcess 失敗 " + Marshal.GetLastWin32Error();
    if (!AssignProcessToJobObject(job, p)) return "AssignProcessToJobObject 失敗 " + Marshal.GetLastWin32Error();
    Holder = job;   // 留著 handle：這支程序活著，Job 就在
    return "";
  }
  public static IntPtr Holder;
}
"@
  $why = [SdJob]::Make($TargetPid)
  if ($why) { [Console]::Out.WriteLine("JOB-FAIL $why"); exit 1 }
  [Console]::Out.WriteLine("JOB-OK $TargetPid")
  [Console]::Out.Flush()
  # 等到標準輸入被關掉（呼叫端結束或被殺）；結束時 handle 關掉 → Job 裡的程序全部被殺
  while ($null -ne [Console]::In.ReadLine()) { }
  exit 0
} catch {
  [Console]::Out.WriteLine("JOB-FAIL $($_.Exception.Message)")
  exit 1
}
