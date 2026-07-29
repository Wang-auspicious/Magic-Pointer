$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class MagicPointerInputState {
    private const int WH_MOUSE_LL = 14;
    private const int WM_MOUSEWHEEL = 0x020A;
    private static int wheelDelta = 0;
    private static IntPtr wheelHook = IntPtr.Zero;
    private static LowLevelMouseProc wheelProc = HookCallback;
    private static Thread hookThread;

    private delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO {
        public int cbSize;
        public int flags;
        public IntPtr hwndActive;
        public IntPtr hwndFocus;
        public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner;
        public IntPtr hwndMoveSize;
        public IntPtr hwndCaret;
        public RECT rcCaret;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO info);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc callback, IntPtr module, uint threadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG message, IntPtr hwnd, uint min, uint max);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetModuleHandle(string moduleName);

    public static bool IsDown(int key) {
        return (GetAsyncKeyState(key) & 0x8000) != 0;
    }

    public static void StartWheelHook() {
        if (hookThread != null) return;
        hookThread = new Thread(() => {
            wheelHook = SetWindowsHookEx(WH_MOUSE_LL, wheelProc, GetModuleHandle(null), 0);
            MSG message;
            while (wheelHook != IntPtr.Zero && GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { }
            if (wheelHook != IntPtr.Zero) UnhookWindowsHookEx(wheelHook);
            wheelHook = IntPtr.Zero;
        });
        hookThread.IsBackground = true;
        hookThread.Name = "MagicPointerWheelHook";
        hookThread.Start();
    }

    public static int TakeWheelDelta() {
        return Interlocked.Exchange(ref wheelDelta, 0);
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0 && wParam.ToInt32() == WM_MOUSEWHEEL) {
            MSLLHOOKSTRUCT value = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            short delta = unchecked((short)((value.mouseData >> 16) & 0xffff));
            Interlocked.Add(ref wheelDelta, delta);
        }
        return CallNextHookEx(wheelHook, nCode, wParam, lParam);
    }
}
"@

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[MagicPointerInputState]::StartWheelHook()

while ($true) {
    try {
        $hwnd = [MagicPointerInputState]::GetForegroundWindow()
        [uint32]$pidValue = 0
        $threadId = [MagicPointerInputState]::GetWindowThreadProcessId($hwnd, [ref]$pidValue)
        $processName = ""
        if ($pidValue -gt 0) {
            $processName = (Get-Process -Id $pidValue -ErrorAction SilentlyContinue).ProcessName
        }
        $info = New-Object MagicPointerInputState+GUITHREADINFO
        $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
        $hasInfo = [MagicPointerInputState]::GetGUIThreadInfo($threadId, [ref]$info)
        $buttons = 0
        if ([MagicPointerInputState]::IsDown(1)) { $buttons = $buttons -bor 1 }
        if ([MagicPointerInputState]::IsDown(2)) { $buttons = $buttons -bor 2 }
        if ([MagicPointerInputState]::IsDown(4)) { $buttons = $buttons -bor 4 }
        if ([MagicPointerInputState]::IsDown(5)) { $buttons = $buttons -bor 8 }
        if ([MagicPointerInputState]::IsDown(6)) { $buttons = $buttons -bor 16 }
        [ordered]@{
            buttons = $buttons
            foregroundApp = [string]$processName
            foregroundHwnd = [int64]$hwnd
            foregroundProcessId = [uint32]$pidValue
            isWindowMoving = [bool]($hasInfo -and $info.hwndMoveSize -ne [IntPtr]::Zero)
            scrollDelta = [MagicPointerInputState]::TakeWheelDelta()
        } | ConvertTo-Json -Compress
    } catch {
        '{"buttons":0,"foregroundApp":"","foregroundHwnd":0,"foregroundProcessId":0,"isWindowMoving":false,"scrollDelta":0}'
    }
    Start-Sleep -Milliseconds 35
}
