'use strict';

// Windows 桌面层：把窗口挂到 WorkerW/Progman（桌面图标层之下、壁纸层）。
// OpenInputDesktop 切到交互桌面；枚举定位 Progman/WorkerW；句柄用 int64 解析。

const { spawn } = require('node:child_process');

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
  public static extern IntPtr FindWindowEx(IntPtr p, IntPtr c, string cls, string win);
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

# 枚举所有顶层窗口，找 Progman、第一个 WorkerW、带 SHELLDLL_DefView 的窗口
$script:progman = [IntPtr]::Zero
$script:defOwner = [IntPtr]::Zero
$script:firstWorker = [IntPtr]::Zero
$cb = [WinDesktopApi+EnumWindowsProc]{
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [void][WinDesktopApi]::GetClassName($h, $sb, 256)
  $cn = $sb.ToString()
  if ($cn -eq 'Progman') { $script:progman = $h }
  if ($cn -eq 'WorkerW' -and $script:firstWorker -eq [IntPtr]::Zero) { $script:firstWorker = $h }
  $dv = [WinDesktopApi]::FindWindowEx($h, [IntPtr]::Zero, 'SHELLDLL_DefView', $null)
  if ($dv -ne [IntPtr]::Zero) { $script:defOwner = $h }
  return $true
}
[void][WinDesktopApi]::EnumWindows($cb, [IntPtr]::Zero)
Log "progman=$($script:progman) defOwner=$($script:defOwner) firstWorker=$($script:firstWorker)"

if ($script:progman -ne [IntPtr]::Zero) {
  $res = [IntPtr]::Zero
  [void][WinDesktopApi]::SendMessageTimeout($script:progman, 0x052C, [IntPtr]::Zero, [IntPtr]::new(1), 0x0002, 1000, [ref]$res)
  Start-Sleep -Milliseconds 500
}

# 在 defOwner 之后找 WorkerW；回退到枚举到的第一个 WorkerW；不再回退 Progman（直接挂会卡死）
$parent = [IntPtr]::Zero
if ($script:defOwner -ne [IntPtr]::Zero) {
  $parent = [WinDesktopApi]::FindWindowEx([IntPtr]::Zero, $script:defOwner, 'WorkerW', [IntPtr]::Zero)
}
if ($parent -eq [IntPtr]::Zero) { $parent = $script:firstWorker }

Log "chosen parent=$parent"
if ($parent -ne [IntPtr]::Zero) {
  [void][WinDesktopApi]::SetParent($child, $parent)
  # 挂为子窗口后坐标系改变，立即重置为 0,0 全屏并显示
  Add-Type -AssemblyName System.Windows.Forms
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  [void][WinDesktopApi]::SetWindowPos($child, [IntPtr]::Zero, 0, 0, $b.Width, $b.Height, 0x0040 -bor 0x0010 -bor 0x0004)
  Log "SetParent ok, resized to $($b.Width)x$($b.Height)"
} else {
  Log "fallback no WorkerW"
}
} catch {
  Log "ERROR: $($_.Exception.Message)"
}
exit 0
`;
}

// 异步 spawn：主进程不阻塞，否则 SetParent 给 Electron 窗口发同步消息会死锁。
function setDesktopLevel(handle, enabled) {
  return new Promise((resolve) => {
    if (!handle || !Buffer.isBuffer(handle)) return resolve();
    const hwnd = handle.readBigUInt64LE(0).toString();
    const script = buildPowerShell(hwnd, !!enabled);
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const psExe = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    try {
      const child = spawn(
        psExe,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, detached: false }
      );
      child.on('error', () => resolve());
      child.on('close', () => resolve());
      // 不等待输出，立即返回；SetParent 在脚本里同步完成
      setTimeout(() => resolve(), 15000).unref?.();
    } catch {
      resolve();
    }
  });
}

module.exports = { setDesktopLevel };
