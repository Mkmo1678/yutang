'use strict';

// Windows 桌面层：把窗口挂到 WorkerW/Progman（桌面图标层之下、壁纸层）。
// 关键：spawn 出的 PowerShell 线程可能不在交互桌面，先 OpenInputDesktop/SetThreadDesktop 切到输入桌面。

const { spawnSync } = require('node:child_process');

function buildPowerShell(hwnd, enabled) {
  return `$log = Join-Path $env:TEMP 'yutang-desktop.log'
function Log($s) { try { "$([DateTime]::Now.ToString('o')) $s" | Out-File -Append -FilePath $log -Encoding utf8 } catch {} }
try {
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinDesktopApi {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindow(string c, string w);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowEx(IntPtr p, IntPtr c, string w);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")]
  public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")]
  public static extern bool SetParent(IntPtr c, IntPtr p);
  [DllImport("user32.dll")]
  public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")]
  public static extern bool SetThreadDesktop(IntPtr h);
}
'@
$child = [IntPtr][int64]'${hwnd}'
Log "start ${enabled ? 'attach' : 'detach'} child=$child"
if ('detach' -eq '${enabled ? 'attach' : 'detach'}') {
  [void][WinDesktopApi]::SetParent($child, [IntPtr]::Zero)
  Log "detached"
  exit 0
}
$hDesk = [WinDesktopApi]::OpenInputDesktop(0, $false, 0x01FF)
Log "OpenInputDesktop=$hDesk"
if ($hDesk -ne [IntPtr]::Zero) { [void][WinDesktopApi]::SetThreadDesktop($hDesk) }
$progman = [WinDesktopApi]::FindWindow('Progman', $null)
Log "FindWindow Progman=$progman"
$script:tops = New-Object System.Collections.ArrayList
$cb1 = [WinDesktopApi+EnumWindowsProc]{
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [void][WinDesktopApi]::GetClassName($h, $sb, 256)
  [void]$script:tops.Add("$h|$($sb.ToString())")
  return $true
}
[void][WinDesktopApi]::EnumWindows($cb1, [IntPtr]::Zero)
Log "top count=$($script:tops.Count)"
foreach ($t in $script:tops) { if ($t -match 'Progman|WorkerW|Shell|DefView') { Log "  $t" } }
if ($progman -eq [IntPtr]::Zero) {
  foreach ($t in $script:tops) {
    if ($t -match '^[^|]+\|Progman$') { $progman = [IntPtr]($t.Split('|')[0]); Log "enum Progman=$progman" }
  }
}
if ($progman -ne [IntPtr]::Zero) {
  $res = [IntPtr]::Zero
  [void][WinDesktopApi]::SendMessageTimeout($progman, 0x052C, [IntPtr]::Zero, [IntPtr]::One, 0x0002, 1000, [ref]$res)
  Start-Sleep -Milliseconds 500
}
$parent = [WinDesktopApi]::FindWindowEx([IntPtr]::Zero, [IntPtr]::Zero, 'WorkerW', [IntPtr]::Zero)
Log "direct WorkerW=$parent"
if ($parent -eq [IntPtr]::Zero) {
  $script:found = [IntPtr]::Zero
  $cb2 = [WinDesktopApi+EnumWindowsProc]{
    param($h, $l)
    $dv = [WinDesktopApi]::FindWindowEx($h, [IntPtr]::Zero, 'SHELLDLL_DefView', $null)
    if ($dv -ne [IntPtr]::Zero) { $script:found = [WinDesktopApi]::FindWindowEx([IntPtr]::Zero, $h, 'WorkerW', [IntPtr]::Zero) }
    return $true
  }
  [void][WinDesktopApi]::EnumWindows($cb2, [IntPtr]::Zero)
  if ($script:found -ne [IntPtr]::Zero) { $parent = $script:found }
}
if ($parent -eq [IntPtr]::Zero -and $progman -ne [IntPtr]::Zero) { $parent = $progman }
Log "chosen parent=$parent"
if ($parent -ne [IntPtr]::Zero) {
  [void][WinDesktopApi]::SetParent($child, $parent)
  Log "SetParent ok"
} else {
  Log "fallback"
}
} catch {
  Log "ERROR: $($_.Exception.Message)"
}
exit 0
`;
}

function setDesktopLevel(handle, enabled) {
  if (!handle || !Buffer.isBuffer(handle)) throw new Error('Invalid window handle.');
  const hwnd = handle.readBigUInt64LE(0).toString();
  const script = buildPowerShell(hwnd, !!enabled);
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const psExe = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const result = spawnSync(
    psExe,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, timeout: 20000 }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || '').toString().trim() || `PowerShell exited ${result.status}`;
    throw new Error(detail);
  }
  return true;
}

module.exports = { setDesktopLevel };
