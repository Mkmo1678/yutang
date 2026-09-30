'use strict';

// Windows 桌面层：把窗口挂到 WorkerW（桌面图标层之下、壁纸层）。
// 原理同动态壁纸软件：向 Progman 发 0x052C 生成 WorkerW，枚举找到它，再 SetParent。
// 用系统自带 PowerShell + C# P/Invoke，运行时编译，无需随包分发原生二进制。

const { spawnSync } = require('node:child_process');

function buildPowerShell(hwnd, enabled) {
  return `$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinDesktopApi {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);
  [DllImport("user32.dll")]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
}
'@
$child = [IntPtr][int64]'${hwnd}'
if ('${enabled ? 'attach' : 'detach'}' -eq 'detach') {
  [void][WinDesktopApi]::SetParent($child, [IntPtr]::Zero)
  exit 0
}
$progman = [WinDesktopApi]::FindWindow('Progman', $null)
$res = [IntPtr]::Zero
[void][WinDesktopApi]::SendMessageTimeout($progman, 0x052C, [IntPtr]::Zero, [IntPtr]::Zero, 0x0002, 1000, [ref]$res)
$wallpaperWorker = [IntPtr]::Zero
$callback = [WinDesktopApi+EnumWindowsProc]{
  param($hWnd, $lParam)
  $defView = [WinDesktopApi]::FindWindowEx($hWnd, [IntPtr]::Zero, 'SHELLDLL_DefView', $null)
  if ($defView -ne [IntPtr]::Zero) {
    $script:wallpaperWorker = [WinDesktopApi]::FindWindowEx([IntPtr]::Zero, $hWnd, 'WorkerW', $null)
  }
  return $true
}
[void][WinDesktopApi]::EnumWindows($callback, [IntPtr]::Zero)
if ($wallpaperWorker -eq [IntPtr]::Zero) { Write-Error 'WorkerW not found'; exit 1 }
[void][WinDesktopApi]::SetParent($child, $wallpaperWorker)
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
