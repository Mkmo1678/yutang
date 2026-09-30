'use strict';

// Windows 桌面层：把窗口挂到 WorkerW/Progman（桌面图标层之下、壁纸层）。
// 枚举顶层窗口定位，比单纯 FindWindow 更稳；诊断日志写 %TEMP%\yutang-desktop.log。

const { spawnSync } = require('node:child_process');

function buildPowerShell(hwnd, enabled) {
  return `$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'yutang-desktop.log'
function Log($s) { try { "$([DateTime]::Now.ToString('o')) $s" | Out-File -Append -FilePath $log -Encoding utf8 } catch {} }
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinDesktopApi {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindow(string c, string w);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowEx(IntPtr p, IntPtr c, string c, string w);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")]
  public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")]
  public static extern bool SetParent(IntPtr c, IntPtr p);
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
'@
$child = [IntPtr][int64]'${hwnd}'
Log "start enabled=${enabled ? 'attach' : 'detach'} child=$child"
if ('detach' -eq '${enabled ? 'attach' : 'detach'}') {
  [void][WinDesktopApi]::SetParent($child, [IntPtr]::Zero)
  Log "detached"
  exit 0
}
$progman = [WinDesktopApi]::FindWindow('Progman', $null)
Log "FindWindow Progman=$progman"
$script:tops = New-Object System.Collections.ArrayList
$enumCb = [WinDesktopApi+EnumWindowsProc]{
  param($h, $l)
  $sb = New-Object Text.StringBuilder 256
  [void][WinDesktopApi]::GetClassName($h, $sb, 256)
  [void]$script:tops.Add("$h|$($sb.ToString())")
  return $true
}
[void][WinDesktopApi]::EnumWindows($enumCb, [IntPtr]::Zero)
Log "top windows count=$($script:tops.Count)"
foreach ($t in $script:tops) {
  if ($t -match 'Progman|WorkerW|Shell|DefView') { Log "  match: $t" }
}
if ($progman -eq [IntPtr]::Zero) {
  foreach ($t in $script:tops) {
    if ($t -match '^[^|]+\|Progman$') { $progman = [IntPtr]($t.Split('|')[0]); Log "enum found Progman=$progman" }
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
    $defView = [WinDesktopApi]::FindWindowEx($h, [IntPtr]::Zero, 'SHELLDLL_DefView', $null)
    if ($defView -ne [IntPtr]::Zero) {
      $script:found = [WinDesktopApi]::FindWindowEx([IntPtr]::Zero, $h, 'WorkerW', [IntPtr]::Zero)
    }
    return $true
  }
  [void][WinDesktopApi]::EnumWindows($cb2, [IntPtr]::Zero)
  if ($script:found -ne [IntPtr]::Zero) { $parent = $script:found }
}
if ($parent -eq [IntPtr]::Zero -and $progman -ne [IntPtr]::Zero) { $parent = $progman }
Log "chosen parent=$parent"
if ($parent -ne [IntPtr]::Zero) {
  [void][WinDesktopApi]::SetParent($child, $parent)
  [void][WinDesktopApi]::SetWindowPos($child, [IntPtr]::Zero, 0,0,0,0, 0x0001 -bor 0x0004 -bor 0x0010)
  Log "SetParent ok"
} else {
  Log "fallback: no desktop layer"
}
exit 0
`;
}

function setDesktopLevel(handle, enabled) {
  if (!handle || !Buffer.isBuffer(handle)) throw new Error('Invalid window handle.');
  const hwnd = handle.readBigUInt64LE(0).toString();
  const script = buildPowerShell(hwnd, !!enabled);
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(
    'powershell.exe',
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
