param([switch]$SelfTest)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class MagicPointerInputState {
    private const int WH_MOUSE_LL = 14;
    private const int WM_MOUSEMOVE = 0x0200;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_LBUTTONUP = 0x0202;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_MBUTTONDOWN = 0x0207;
    private const int WM_MBUTTONUP = 0x0208;
    private const int WM_MOUSEWHEEL = 0x020A;
    private const int WM_XBUTTONDOWN = 0x020B;
    private const int WM_XBUTTONUP = 0x020C;
    private static int wheelDelta = 0;
    private static IntPtr wheelHook = IntPtr.Zero;
    private static LowLevelMouseProc wheelProc = HookCallback;
    private static Thread hookThread;
    private static Thread commandThread;
    private static int captureNextStroke = 0;
    private static long captureDeadlineTicks = 0;
    private static int burstGraceMs = 2500;
    private static int swallowingLeft = 0;
    private static int episodeChord = 0; // 0 none, 1 X1, 2 X2, 3 middle
    private static int chordHeld = 0;

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

    // A swallowed press never reaches the async key state table, so the poller
    // cannot see the very stroke this hook is capturing. The hook is the only
    // thing that still knows, so it has to say so.
    public static bool IsSwallowingLeft() {
        return Interlocked.CompareExchange(ref swallowingLeft, 0, 0) == 1;
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

    public static void StartCommandReader() {
        if (commandThread != null) return;
        commandThread = new Thread(() => {
            string line;
            while ((line = Console.In.ReadLine()) != null) {
                try {
                    string[] parts = line.Trim().Split(':');
                    string command = parts.Length > 0 ? parts[0].ToLowerInvariant() : "";
                    if (command == "capture-next") {
                        int timeout = parts.Length > 1 ? Int32.Parse(parts[1]) : 5000;
                        int grace = parts.Length > 2 ? Int32.Parse(parts[2]) : 2500;
                        CaptureNextStroke(timeout, grace);
                    } else if (command == "episode") {
                        SetEpisodeChord(parts.Length > 1 ? parts[1] : "none");
                    } else if (command == "navigate") {
                        Navigate();
                    } else if (command == "idle") {
                        Idle();
                    }
                } catch { }
            }
            Idle();
        });
        commandThread.IsBackground = true;
        commandThread.Name = "MagicPointerHookCommands";
        commandThread.Start();
    }

    public static void CaptureNextStroke(int timeoutMs, int graceMs) {
        burstGraceMs = Math.Max(1500, Math.Min(30000, graceMs));
        captureDeadlineTicks = DateTime.UtcNow.AddMilliseconds(Math.Max(250, timeoutMs)).Ticks;
        Interlocked.Exchange(ref captureNextStroke, 1);
    }

    public static void SetEpisodeChord(string chord) {
        string value = (chord ?? "none").Trim().ToLowerInvariant();
        int next = value == "xbutton1" ? 1 : value == "xbutton2" ? 2 : value == "middle_hold" ? 3 : 0;
        Interlocked.Exchange(ref episodeChord, next);
        Interlocked.Exchange(ref chordHeld, 0);
        Navigate();
    }

    public static void Navigate() {
        Interlocked.Exchange(ref captureNextStroke, 0);
        Interlocked.Exchange(ref swallowingLeft, 0);
    }

    public static void Idle() {
        Navigate();
        Interlocked.Exchange(ref episodeChord, 0);
        Interlocked.Exchange(ref chordHeld, 0);
    }

    public static int TakeWheelDelta() {
        return Interlocked.Exchange(ref wheelDelta, 0);
    }

    private static bool IsCaptureNextActive() {
        if (Interlocked.CompareExchange(ref captureNextStroke, 0, 0) == 0) return false;
        if (DateTime.UtcNow.Ticks <= Interlocked.Read(ref captureDeadlineTicks)) return true;
        Navigate();
        return false;
    }

    private static bool IsMatchingChordMessage(int message, MSLLHOOKSTRUCT value) {
        int configured = Interlocked.CompareExchange(ref episodeChord, 0, 0);
        if (configured == 3) return message == WM_MBUTTONDOWN || message == WM_MBUTTONUP;
        if ((configured == 1 || configured == 2) && (message == WM_XBUTTONDOWN || message == WM_XBUTTONUP)) {
            int button = (int)((value.mouseData >> 16) & 0xffff);
            return button == configured;
        }
        return false;
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode < 0) return CallNextHookEx(wheelHook, nCode, wParam, lParam);
        int message = wParam.ToInt32();
        MSLLHOOKSTRUCT value = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
        if (message == WM_MOUSEWHEEL) {
            short delta = unchecked((short)((value.mouseData >> 16) & 0xffff));
            Interlocked.Add(ref wheelDelta, delta);
        }
        if (IsMatchingChordMessage(message, value)) {
            bool down = message == WM_XBUTTONDOWN || message == WM_MBUTTONDOWN;
            Interlocked.Exchange(ref chordHeld, down ? 1 : 0);
            return (IntPtr)1;
        }
        if (message == WM_RBUTTONDOWN) Navigate();
        if (message == WM_LBUTTONDOWN) {
            bool shouldCapture = IsCaptureNextActive()
                || Interlocked.CompareExchange(ref chordHeld, 0, 0) == 1;
            if (shouldCapture) {
                Interlocked.Exchange(ref swallowingLeft, 1);
                return (IntPtr)1;
            }
        }
        if (message == WM_MOUSEMOVE && Interlocked.CompareExchange(ref swallowingLeft, 0, 0) == 1) {
            return (IntPtr)1;
        }
        if (message == WM_LBUTTONUP && Interlocked.Exchange(ref swallowingLeft, 0) == 1) {
            captureDeadlineTicks = DateTime.UtcNow.AddMilliseconds(burstGraceMs).Ticks;
            Interlocked.Exchange(ref captureNextStroke, 1);
            return (IntPtr)1;
        }
        return CallNextHookEx(wheelHook, nCode, wParam, lParam);
    }
}
"@

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ($SelfTest) {
    [MagicPointerInputState]::CaptureNextStroke(500, 2500)
    [MagicPointerInputState]::SetEpisodeChord("xbutton1")
    [MagicPointerInputState]::Navigate()
    [MagicPointerInputState]::Idle()
    '{"ok":true,"hook":"WH_MOUSE_LL","gate":"fail-open"}'
    exit 0
}
[MagicPointerInputState]::StartWheelHook()
[MagicPointerInputState]::StartCommandReader()

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
        if ([MagicPointerInputState]::IsSwallowingLeft()) { $buttons = $buttons -bor 1 }
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
