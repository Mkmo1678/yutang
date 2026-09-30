'use strict';

// Windows 桌面层：尽量把窗口挂到 WorkerW（桌面图标层之下、壁纸层）。
// 用系统自带 PowerShell + C# P/Invoke，运行时编译，无需随包分发原生二进制。
// 多种查找路径；找不到时降级（不报错），保持全屏+鼠标穿透。

const { spawnSync } = require('node:child_process');

function buildPowerShell(hwnd, enabled) {
  return `$ErrorActionPreference = 'Continue'
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
  public static extern bool SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
}
'@
$child = [IntPtr][int64]'${hwnd}'
if ('detach' -eq '${enabled ? 'attach' : 'detach'}') {
  [void][WinDesktopApi]::SetParent($child, [IntPtr]::Zero)
  exit 0
}
$progman = [WinDesktopApi]::FindWindow('Progman', $null)
if ($progman -ne [IntPtr]::Zero) {
  $res = [IntPtr]::Zero
  [void][WinDesktopApi]::SendMessageTimeout($progman, 0x052C, [IntPtr]::Zero, [IntPtr]::Zero, 0x0002, 1000, [ref]$res)
  Start-Sleep -Milliseconds 400
}
# 方式1：直接找 WorkerW 顶层窗口
$parent = [WinDesktopApi]::FindWindowEx([IntPtr]::Zero, [IntPtr]::Zero, 'WorkerW', [IntPtr]::Zero)
# 方式2：通过 SHELLDLL_DefView 找其后的 WorkerW
if ($parent -eq [IntPtr]::Zero) {
  $script:found = [IntPtr]::Zero
  $cb = [WinDesktopApi+EnumWindowsProc]{
    param($h, $l)
    $defView = [WinDesktopApi]::FindWindowEx($h, [IntPtr]::Zero, 'SHELLDLL_DefView', $null)
    if ($defView -ne [IntPtr]::Zero) {
      $script:found = [WinDesktopApi]::FindWindowEx([IntPtr]::Zero, $h, 'WorkerW', [IntPtr]::Zero)
    }
    return $true
  }
  [void][WinDesktopApi]::EnumWindows($cb, [IntPtr]::Zero)
  if ($script:found -ne [IntPtr]::Zero) { $parent = $script:found }
}
# 方式3：回退直接挂 Progman
if ($parent -eq [IntPtr]::Zero -and $progman -ne [IntPtr]::Zero) { $parent = $progman }
if ($parent -ne [IntPtr]::Zero) {
  [void][WinDesktopApi]::SetParent($child, $parent)
} else {
  Write-Output 'fallback'
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
  // 脚本找不到桌面层时输出 fallback 并以 0 退出，不再视为错误
  if (result.status !== 0) {
    const detail = (result.stderr || '').toString().trim() || `PowerShell exited ${result.status}`;
    throw new Error(detail);
  }
  return true;
}

module.exports = { setDesktopLevel };
