param([switch]$SelfTest)

$ErrorActionPreference = "Stop"

# Source is compiled once and cached (see Import-InputStateType). It must be
# assigned, not passed straight to Add-Type as a bare here-string: a here-string
# that is not an argument becomes an expression, and its value would be written
# to stdout, which is the snapshot wire.
$Source = @"
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

    // Pure read of the same predicate. IsCaptureNextActive() calls Navigate()
    // when the deadline has passed, so the state poller must not use it: asking
    // the question would answer it. This one only looks.
    public static bool IsCaptureArmed() {
        if (Interlocked.CompareExchange(ref captureNextStroke, 0, 0) == 0) return false;
        return DateTime.UtcNow.Ticks <= Interlocked.Read(ref captureDeadlineTicks);
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

    // ---- Snapshot path -------------------------------------------------
    //
    // Everything below exists because the polling loop used to be written in
    // PowerShell: `Get-Process`, `New-Object`, `Marshal::SizeOf` and
    // `ConvertTo-Json` ran once per tick. Those are cmdlet/reflection calls
    // costing single-digit milliseconds each, so the loop asked for 35 ms and
    // delivered ~63 ms (measured p50; 15.6 Hz against an intended 28.6 Hz) —
    // and the wake detector's budget is 50 ms. The work moved here, where the
    // same reads are microsecond P/Invokes, and the loop below is back to
    // four calls per tick.

    /// <summary>The six GetAsyncKeyState reads the poller assembles into the
    /// button mask, done in one transition instead of six.</summary>
    public static int ButtonsRaw() {
        int buttons = 0;
        if (IsDown(1)) buttons |= 1;
        if (IsDown(2)) buttons |= 2;
        if (IsDown(4)) buttons |= 4;
        if (IsDown(5)) buttons |= 8;
        if (IsDown(6)) buttons |= 16;
        return buttons;
    }

    // Get-Process was the single most expensive thing in the old loop, and the
    // foreground process changes maybe a few times an hour. Cache it; the pid
    // is the key, so a stale entry can never be returned for a different one.
    private static uint cachedProcessId = 0;
    private static string cachedProcessName = "";

    private static string ProcessNameOf(uint processId) {
        if (processId == cachedProcessId) return cachedProcessName;
        string name = "";
        if (processId > 0) {
            try {
                using (System.Diagnostics.Process p = System.Diagnostics.Process.GetProcessById((int)processId)) {
                    name = p.ProcessName;
                }
            } catch { name = ""; }
        }
        cachedProcessId = processId;
        cachedProcessName = name;
        return name;
    }

    private static string JsonString(string value) {
        if (string.IsNullOrEmpty(value)) return "\"\"";
        StringBuilder b = new StringBuilder(value.Length + 2);
        b.Append('"');
        foreach (char c in value) {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        b.Append('"');
        return b.ToString();
    }

    /// <summary>Reads the whole snapshot and writes one JSON line to stdout.
    /// The key set and key order are the wire contract `electron/main.ts`
    /// parses — do not reorder or rename without changing both sides.</summary>
    public static void EmitSnapshot(int buttons) {
        long hwnd = 0;
        uint processId = 0;
        bool isWindowMoving = false;
        string processName = "";
        try {
            IntPtr foreground = GetForegroundWindow();
            hwnd = foreground.ToInt64();
            uint threadId = GetWindowThreadProcessId(foreground, out processId);
            processName = ProcessNameOf(processId);
            GUITHREADINFO info = new GUITHREADINFO();
            info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
            if (GetGUIThreadInfo(threadId, ref info) && info.hwndMoveSize != IntPtr.Zero) {
                isWindowMoving = true;
            }
        } catch { }
        Console.Out.Write(
            "{\"buttons\":" + buttons
            + ",\"foregroundApp\":" + JsonString(processName)
            + ",\"foregroundHwnd\":" + hwnd
            + ",\"foregroundProcessId\":" + processId
            + ",\"isWindowMoving\":" + (isWindowMoving ? "true" : "false")
            + ",\"scrollDelta\":" + TakeWheelDelta()
            + ",\"swallowingLeft\":" + (IsSwallowingLeft() ? "true" : "false")
            + ",\"captureArmed\":" + (IsCaptureArmed() ? "true" : "false")
            + "}\n");
        Console.Out.Flush();
    }

    // ---- Pacing --------------------------------------------------------
    //
    // Start-Sleep rounds up to the Windows default 15.6 ms timer tick, so a
    // requested 35 ms became ~50 ms before any work was done. A
    // high-resolution waitable timer (Windows 10 1803+) paces at ~1 ms without
    // raising the global timer resolution for the whole machine.

    private const uint CREATE_WAITABLE_TIMER_HIGH_RESOLUTION = 0x00000002;
    private const uint TIMER_ALL_ACCESS = 0x001F0003;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint INFINITE = 0xFFFFFFFF;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateWaitableTimerEx(IntPtr lpTimerAttributes, string lpTimerName, uint dwFlags, uint dwDesiredAccess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetWaitableTimer(IntPtr hTimer, ref long pDueTime, int lPeriod, IntPtr pfnCompletionRoutine, IntPtr lpArgToCompletionRoutine, bool fResume);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    private static IntPtr tickTimer = IntPtr.Zero;

    /// <summary>Blocks until the next sample is due. Falls back to
    /// Thread.Sleep only if the high-resolution timer is unavailable.</summary>
    public static void WaitForNextTick(int intervalMs) {
        if (intervalMs <= 0) return;
        if (tickTimer == IntPtr.Zero) {
            tickTimer = CreateWaitableTimerEx(IntPtr.Zero, null, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
        }
        if (tickTimer != IntPtr.Zero) {
            long dueTime = -(long)intervalMs * 10000L; // relative, 100 ns units
            if (SetWaitableTimer(tickTimer, ref dueTime, 0, IntPtr.Zero, IntPtr.Zero, false)
                && WaitForSingleObject(tickTimer, INFINITE) == WAIT_OBJECT_0) {
                return;
            }
        }
        System.Threading.Thread.Sleep(intervalMs);
    }
}
"@

# Add-Type compiles this file's C# with the CodeDom provider on every start —
# measured at ~0.5 s for a trivial class, and this one is not trivial. The
# compiled assembly is cacheable, and loading a cached DLL is a LoadFrom
# instead of a compile, so the pointer stream stops paying a second of
# compiler time before its first sample. Bump CACHE_VERSION whenever the C#
# above changes; the version is in the filename, so a new version never
# collides with an old file.
$CACHE_VERSION = "3"
function Import-InputStateType {
    $cacheRoot = $env:LOCALAPPDATA
    if (-not $cacheRoot) { $cacheRoot = [System.IO.Path]::GetTempPath() }
    $cacheDir = Join-Path $cacheRoot "MagicPointer"
    $cacheDll = Join-Path $cacheDir "pointer_input_state_$CACHE_VERSION.dll"
    if (Test-Path $cacheDll) {
        try {
            Add-Type -Path $cacheDll -ErrorAction Stop
            return
        } catch {
            # A half-written or unloadable cache must never be fatal; fall
            # through and recompile.
        }
    }
    try {
        if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
        Add-Type -TypeDefinition $Source -OutputAssembly $cacheDll -ErrorAction Stop
        Add-Type -Path $cacheDll -ErrorAction Stop
        return
    } catch {
        # Read-only profile, locked file, missing compiler — in-memory is
        # slower to start but always works.
        Add-Type -TypeDefinition $Source
    }
}

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Import-InputStateType
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

# Sampling interval. The wake detector's budget is 50 ms, so the loop has to
# be comfortably under that; 16 ms is one 60 Hz frame. Override with
# MAGIC_POINTER_POINTER_POLL_MS for experiments (inherited from Electron).
$pollIntervalMs = 16
try {
    $configuredInterval = [int]$env:MAGIC_POINTER_POINTER_POLL_MS
    if ($configuredInterval -ge 4 -and $configuredInterval -le 200) { $pollIntervalMs = $configuredInterval }
} catch { }

while ($true) {
    try {
        # Four calls per tick. Everything expensive lives in EmitSnapshot.
        $buttons = [MagicPointerInputState]::ButtonsRaw()
        # A swallowed press never reaches the async key state table, so the
        # poller cannot see the very stroke the hook is capturing. The hook is
        # the only thing that still knows, so it has to say so.
        if ([MagicPointerInputState]::IsSwallowingLeft()) { $buttons = $buttons -bor 1 }
        [MagicPointerInputState]::EmitSnapshot($buttons)
    } catch {
        # One malformed tick must not kill the stream: Electron is watching
        # this pipe for liveness, and a dead stream means no pointer state at
        # all. Keep the shape Electron parses, keep the loop, try again.
        #
        # The fallback is itself guarded. If it throws too — a closed pipe, a
        # type that failed to load — an unguarded retry inside `catch` would
        # propagate out of the loop and take the whole stream down, which is
        # the one outcome this block exists to prevent.
        try {
            $buttons = 0
            if ([MagicPointerInputState]::IsSwallowingLeft()) { $buttons = $buttons -bor 1 }
            [MagicPointerInputState]::EmitSnapshot($buttons)
        } catch {
            '{"buttons":0,"foregroundApp":"","foregroundHwnd":0,"foregroundProcessId":0,"isWindowMoving":false,"scrollDelta":0,"swallowingLeft":false,"captureArmed":false}'
        }
    }
    [MagicPointerInputState]::WaitForNextTick($pollIntervalMs)
}
