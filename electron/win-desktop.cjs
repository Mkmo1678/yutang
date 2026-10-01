'use strict';

// Windows 桌面层：把窗口挂到 WorkerW/Progman（桌面图标层之下、壁纸层）。
// 完整 Win32 API 声明；SetParent 后去掉 layered 样式避免 DWM 崩溃；全量日志。

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
  public static extern IntPtr SetParent(IntPtr c, IntPtr p);
  [DllImport("user32.dll")]
  public extern static bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")]
  public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")]
  public static extern int SetWindowLong(IntPtr h, int idx, int newLong);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")]
  public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")]
  public static extern bool SetThreadDesktop(IntPtr h);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")]
  public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, IntPtr lpfnEnum, IntPtr dwData);
}
'@
$child = [IntPtr][int64]'${hwnd}'
$mode = '${enabled ? 'attach' : 'detach'}'
Log "start mode=$mode child=$child isValid=$([WinDesktopApi]::IsWindow($child))"

# ---- detach 模式 ----
if ($mode -eq 'detach') {
  [void][WinDesktopApi]::SetParent($child, [IntPtr]::Zero)
  # 恢复普通窗口样式：加回 layered（Electron transparent 需要）
  [void][WinDesktopApi]::SetWindowLong($child, -20, 0x00080000)
  [void][WinDesktopApi]::ShowWindow($child, 5)
  Log "detached ok"
  exit 0
}

# ---- attach 模式 ----
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
Log "enum: progman=$($script:progman) defOwner=$($script:defOwner) firstWorker=$($script:firstWorker)"

# 让 Progman 创建 WorkerW 壁纸层
if ($script:progman -ne [IntPtr]::Zero) {
  $res = [IntPtr]::Zero
  [void][WinDesktopApi]::SendMessageTimeout($script:progman, 0x052C, [IntPtr]::Zero, [IntPtr]::new(1), 0x0002, 2000, [ref]$res)
  Log "sent 0x052C to progman, res=$res"
  Start-Sleep -Milliseconds 800
}

# 重新枚举一次（WorkerW 可能刚创建）
$script:defOwner2 = [IntPtr]::Zero
$script:workerAfterDef = [IntPtr]::Zero
$cb2 = [WinDesktopApi+EnumWindowsProc]{
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [void][WinDesktopApi]::GetClassName($h, $sb, 256)
  $cn = $sb.ToString()
  $dv = [WinDesktopApi]::FindWindowEx($h, [IntPtr]::Zero, 'SHELLDLL_DefView', $null)
  if ($dv -ne [IntPtr]::Zero) { $script:defOwner2 = $h }
  return $true
}
[void][WinDesktopApi]::EnumWindows($cb2, [IntPtr]::Zero)
Log "re-enum: defOwner2=$($script:defOwner2)"

# 找 SHELLDLL_DefView 后面的 WorkerW（正确的壁纸层位置）
$parent = [IntPtr]::Zero
if ($script:defOwner2 -ne [IntPtr] -and $script:defOwner2 -ne [IntPtr]::Zero) {
  $parent = [WinDesktopApi]::FindWindowEx([IntPtr]::Zero, $script:defOwner2, 'WorkerW', [IntPtr]::Zero)
  Log "FindWindowEx after defOwner2 -> $parent"
}
if ($parent -eq [IntPtr]::Zero -and $script:firstWorker -ne [IntPtr]::Zero) {
  $parent = $script:firstWorker
  Log "fallback to firstWorker=$parent"
}
if ($parent -eq [IntPtr]::Zero -and $script:progman -ne [IntPtr]::Zero) {
  $parent = $script:progman
  Log "final fallback to progman=$parent"
}

Log "chosen parent=$parent"
if ($parent -eq [IntPtr]::Zero) {
  Log "ERROR: no parent window found"
  exit 0
}

# 关键：先去掉 Electron transparent 窗口的 WS_EX_LAYERED，
# 否则 SetParent 到 WorkerW 后 DWM 合成会崩溃
$exStyle = [WinDesktopApi]::GetWindowLong($child, -20)  # GWL_EXSTYLE = -20
Log "old exStyle=0x$('{0:X}' -f $exStyle)"
$newExStyle = $exStyle -band (-bnot 0x00080000)  # 去掉 WS_EX_LAYERED
[void][WinDesktopApi]::SetWindowLong($child, -20, $newExStyle)
Log "new exStyle=0x$('{0:X}' -f $newExStyle)"

# SetParent
$oldParent = [WinDesktopApi]::SetParent($child, $parent)
Log "SetParent done, oldParent=$oldParent"

# 获取主屏尺寸
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Log("screen bounds: $($b.Width)x$($b.Height) at $($b.X),$($b.Y)")

# SetWindowPos: SWP_NOACTIVATE(0x0010) | SWP_ASYNCWINDOWPOS(0x4000) | SWP_SHOWWINDOW(0x0040)
[void][WinDesktopApi]::SetWindowPos($child, [IntPtr]::Zero, 0, 0, $b.Width, $b.Height, 0x0010 -bor 0x4000 -bor 0x0040)
Log "SetWindowPos done to 0,0 $($b.Width)x$($b.Height)"

# 确保窗口可见且不被激活
[void][WinDesktopApi]::ShowWindow($child, 5)  # SW_SHOW
Log "attach complete"
} catch {
  Log "FATAL ERROR: $($_.Exception.Message) -- $($_.ScriptStackTrace)"
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
      child.on('error', (e) => {
        try {
          const fs = require('node:fs');
          const path = require('node:path');
          const logPath = path.join(process.env.TEMP || '/tmp', 'yutang-desktop.log');
          fs.appendFileSync(logPath, `${new Date().toISOString()} spawn error: ${e.message}\n`);
        } catch {}
        resolve();
      });
      child.on('close', (code) => resolve());
      // 30秒超时兜底
      setTimeout(() => resolve(), 30000).unref?.();
    } catch (e) {
      resolve();
    }
  });
}

module.exports = { setDesktopLevel };
