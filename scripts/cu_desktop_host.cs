using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

internal static class CuDesktopHost
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 64000000 };

    [StructLayout(LayoutKind.Sequential)]
    struct Rect { public int left, top, right, bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct Point { public int x, y; public Point(int x, int y) { this.x = x; this.y = y; } }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation
    {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct GuiThreadInfo
    {
        public int cbSize;
        public uint flags;
        public IntPtr active, focus, capture, menuOwner, moveSize, caret;
        public Rect caretRect;
    }

    delegate bool EnumDesktopWindowsProc(IntPtr hwnd, IntPtr lParam);
    delegate bool EnumChildProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateDesktopW(string desktop, string device, IntPtr devmode, int flags, uint desiredAccess, IntPtr lpsa);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetThreadDesktop(IntPtr hDesktop);

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr GetThreadDesktop(uint threadId);

    [DllImport("user32.dll")]
    static extern IntPtr GetProcessWindowStation();

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetUserObjectInformationW(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumDesktopWindowsProc lpfn, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool EnumChildWindows(IntPtr hWndParent, EnumChildProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool IsWindowEnabled(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hWnd, out Rect lpRect);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern IntPtr SetActiveWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern IntPtr SetFocus(IntPtr hWnd);

    [DllImport("user32.dll")]
    static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    static extern bool ScreenToClient(IntPtr hWnd, ref Point lpPoint);

    [DllImport("user32.dll")]
    static extern IntPtr ChildWindowFromPointEx(IntPtr hwndParent, Point pt, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool PostMessageW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr SendMessageTimeoutW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);

    [DllImport("user32.dll")]
    static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("user32.dll")]
    static extern bool GetGUIThreadInfo(uint idThread, ref GuiThreadInfo lpgui);

    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    [DllImport("user32.dll")]
    static extern short VkKeyScanW(char ch);

    [DllImport("user32.dll")]
    static extern uint MapVirtualKeyW(uint uCode, uint uMapType);

    [DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref StartupInfo lpStartupInfo, out ProcessInformation lpProcessInformation);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr hObject);

    [DllImport("dwmapi.dll")]
    static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttribute, out int pvAttribute, int cbAttribute);

    const uint GENERIC_ALL = 0x10000000;
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOZORDER = 0x0004;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_SHOWWINDOW = 0x0040;
    const uint WM_CLOSE = 0x0010;
    const uint WM_SETTEXT = 0x000C;
    const uint WM_NCHITTEST = 0x0084;
    const uint WM_KEYDOWN = 0x0100;
    const uint WM_KEYUP = 0x0101;
    const uint WM_CHAR = 0x0102;
    const uint WM_SYSKEYDOWN = 0x0104;
    const uint WM_SYSKEYUP = 0x0105;
    const uint WM_MOUSEMOVE = 0x0200;
    const uint WM_LBUTTONDOWN = 0x0201;
    const uint WM_LBUTTONUP = 0x0202;
    const uint WM_LBUTTONDBLCLK = 0x0203;
    const uint WM_RBUTTONDOWN = 0x0204;
    const uint WM_RBUTTONUP = 0x0205;
    const uint WM_MOUSEWHEEL = 0x020A;
    const uint WM_CUT = 0x0300;
    const uint WM_COPY = 0x0301;
    const uint WM_PASTE = 0x0302;
    const uint WM_PRINT = 0x0317;
    const uint EM_SETSEL = 0x00B1;

    static readonly Dictionary<string, ushort> Keys = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
        {"ctrl",17},{"control",17},{"alt",18},{"menu",18},{"shift",16},{"enter",13},{"return",13},{"tab",9},{"esc",27},{"escape",27},
        {"backspace",8},{"delete",46},{"del",46},{"space",32},{"left",37},{"up",38},{"right",39},{"down",40},
        {"home",36},{"end",35},{"pageup",33},{"pagedown",34},{"insert",45},{"f1",112},{"f2",113},{"f3",114},{"f4",115},{"f5",116},{"f6",117},{"f7",118},{"f8",119},{"f9",120},{"f10",121},{"f11",122},{"f12",123}
    };

    static IntPtr _origDesktop = IntPtr.Zero;
    static IntPtr _agentDesktop = IntPtr.Zero;
    static string _desktopName = "";
    static string _desktopPath = "";
    static int _width = 1280;
    static int _height = 720;
    static IntPtr _activeHwnd = IntPtr.Zero;
    static readonly HashSet<int> _trackedPids = new HashSet<int>();

    // Dedicated STA worker thread bound exclusively to _agentDesktop
    static Thread _workerThread;
    static readonly Queue<Action> _queue = new Queue<Action>();
    static readonly AutoResetEvent _workSignal = new AutoResetEvent(false);
    static readonly object _queueLock = new object();
    static bool _workerStop = false;

    static object Get(IDictionary<string, object> d, string key, object fallback = null)
    {
        object value;
        return d != null && d.TryGetValue(key, out value) ? value : fallback;
    }

    static int Num(IDictionary<string, object> d, string key, int fallback = 0)
    {
        object v = Get(d, key, null);
        if (v == null) return fallback;
        try { return Convert.ToInt32(v); } catch { return fallback; }
    }

    static long Num64(IDictionary<string, object> d, string key, long fallback = 0)
    {
        object v = Get(d, key, null);
        if (v == null) return fallback;
        try { return Convert.ToInt64(v); } catch { return fallback; }
    }

    static string Str(IDictionary<string, object> d, string key, string fallback = "")
    {
        object v = Get(d, key, fallback);
        return v == null ? fallback : Convert.ToString(v);
    }

    static Dictionary<string, object> Obj(object value)
    {
        return value as Dictionary<string, object> ?? new Dictionary<string, object>();
    }

    static IntPtr MakeLParam(int x, int y)
    {
        int lp = (y << 16) | (x & 0xFFFF);
        return new IntPtr(lp);
    }

    static string CurrentWindowStationName()
    {
        try
        {
            IntPtr hw = GetProcessWindowStation();
            if (hw != IntPtr.Zero)
            {
                var sb = new StringBuilder(256);
                int needed;
                if (GetUserObjectInformationW(hw, 2, sb, sb.Capacity * 2, out needed) && sb.Length > 0)
                {
                    return sb.ToString();
                }
            }
        }
        catch { }
        return "WinSta0";
    }

    static T RunOnDesktopThread<T>(Func<T> work, int timeoutMs = 15000)
    {
        if (_agentDesktop == IntPtr.Zero || _workerThread == null || !_workerThread.IsAlive)
        {
            throw new Exception("second_desktop_not_open");
        }
        T result = default(T);
        Exception failure = null;
        var done = new ManualResetEventSlim(false);
        lock (_queueLock)
        {
            _queue.Enqueue(() =>
            {
                try { result = work(); }
                catch (Exception ex) { failure = ex; }
                finally { done.Set(); }
            });
            _workSignal.Set();
        }
        if (!done.Wait(timeoutMs))
        {
            throw new Exception("second_desktop_worker_timeout");
        }
        if (failure != null) throw failure;
        return result;
    }

    static string ClassOf(IntPtr hwnd)
    {
        var sb = new StringBuilder(256);
        GetClassName(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    static string TitleOf(IntPtr hwnd)
    {
        var sb = new StringBuilder(2048);
        GetWindowText(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    static bool Cloaked(IntPtr hwnd)
    {
        int v = 0;
        return DwmGetWindowAttribute(hwnd, 14, out v, 4) == 0 && v != 0;
    }

    static Dictionary<string, object> WindowRow(IntPtr hwnd, int zOrder)
    {
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        string procName = "";
        try
        {
            using (var p = Process.GetProcessById((int)pid))
            {
                procName = p.ProcessName + ".exe";
            }
        }
        catch { }
        Rect r;
        GetWindowRect(hwnd, out r);
        return new Dictionary<string, object>
        {
            {"hwnd", hwnd.ToInt64()},
            {"window_id", "w-" + hwnd.ToInt64()},
            {"pid", (int)pid},
            {"processId", (int)pid},
            {"process_name", procName},
            {"processName", procName},
            {"title", TitleOf(hwnd)},
            {"class_name", ClassOf(hwnd)},
            {"bbox", new[] { r.left, r.top, r.right, r.bottom }},
            {"minimized", IsIconic(hwnd)},
            {"focused", _activeHwnd == hwnd},
            {"z_order", zOrder},
            {"desktop", "agent"}
        };
    }

    static List<IntPtr> RawDesktopWindows()
    {
        var list = new List<IntPtr>();
        if (_agentDesktop == IntPtr.Zero) return list;
        EnumDesktopWindows(_agentDesktop, delegate(IntPtr hwnd, IntPtr unused)
        {
            try
            {
                if (!IsWindowVisible(hwnd) || Cloaked(hwnd)) return true;
                string cls = ClassOf(hwnd);
                if (cls == "Progman" || cls == "WorkerW" || cls == "IME" || cls == "MSCTFIME UI" || cls == "Shell_TrayWnd") return true;
                Rect r;
                if (!GetWindowRect(hwnd, out r)) return true;
                if (r.right - r.left < 40 || r.bottom - r.top < 30) return true;
                if (string.IsNullOrWhiteSpace(TitleOf(hwnd)) && cls != "Chrome_WidgetWin_1") return true;
                list.Add(hwnd);
            }
            catch { }
            return true;
        }, IntPtr.Zero);
        return list;
    }

    static object ListDesktopWindows()
    {
        return RunOnDesktopThread(() =>
        {
            var hwnds = RawDesktopWindows();
            var rows = new List<object>();
            for (int i = 0; i < hwnds.Count; i++)
            {
                rows.Add(WindowRow(hwnds[i], i + 1));
            }
            return (object)rows;
        });
    }

    static object OpenDesktopSession(IDictionary<string, object> args)
    {
        int w = ClampDesktopWidth(Num(args, "width", 1280));
        int h = ClampDesktopHeight(Num(args, "height", 720));
        string reqName = Str(args, "name", "MagicPointer_AgentDesktop").Trim();
        if (string.IsNullOrEmpty(reqName)) reqName = "MagicPointer_AgentDesktop";

        if (_agentDesktop != IntPtr.Zero && _workerThread != null && _workerThread.IsAlive)
        {
            _width = w;
            _height = h;
            RunOnDesktopThread(() => { RefitAllWindowsToBounds(); return true; });
            return new { ok = true, desktopName = _desktopName, desktopPath = _desktopPath, width = _width, height = _height, reused = true };
        }

        _width = w;
        _height = h;
        _desktopName = reqName;
        _desktopPath = CurrentWindowStationName() + "\\" + _desktopName;
        if (_origDesktop == IntPtr.Zero) _origDesktop = GetThreadDesktop(GetCurrentThreadId());

        _agentDesktop = CreateDesktopW(_desktopName, null, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
        if (_agentDesktop == IntPtr.Zero)
        {
            throw new Exception("create_desktop_failed:" + Marshal.GetLastWin32Error());
        }

        _workerStop = false;
        var started = new ManualResetEventSlim(false);
        Exception initErr = null;
        _workerThread = new Thread(() =>
        {
            try
            {
                if (!SetThreadDesktop(_agentDesktop))
                {
                    initErr = new Exception("set_thread_desktop_failed:" + Marshal.GetLastWin32Error());
                }
            }
            catch (Exception ex) { initErr = ex; }
            finally { started.Set(); }

            if (initErr != null) return;

            while (true)
            {
                Action job = null;
                lock (_queueLock)
                {
                    if (_queue.Count > 0) job = _queue.Dequeue();
                    else if (_workerStop) break;
                }
                if (job != null)
                {
                    try { job(); } catch { }
                }
                else
                {
                    _workSignal.WaitOne(100);
                }
            }
            try { if (_origDesktop != IntPtr.Zero) SetThreadDesktop(_origDesktop); } catch { }
        });
        _workerThread.IsBackground = true;
        _workerThread.SetApartmentState(ApartmentState.STA);
        _workerThread.Start();
        started.Wait(5000);
        if (initErr != null)
        {
            CloseDesktop(_agentDesktop);
            _agentDesktop = IntPtr.Zero;
            throw initErr;
        }
        return new { ok = true, desktopName = _desktopName, desktopPath = _desktopPath, width = _width, height = _height };
    }

    static int ClampDesktopWidth(int raw)
    {
        int w = Math.Max(480, Math.Min(1920, raw));
        return w & ~1;
    }

    static int ClampDesktopHeight(int raw)
    {
        int h = Math.Max(420, Math.Min(1200, raw));
        return h & ~1;
    }

    static void FitWindowToDesktop(IntPtr hwnd, bool bringTop)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return;
        if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
        Rect r;
        int curW = _width - 24;
        int curH = _height - 52;
        int curX = 12;
        int curY = 12;
        if (GetWindowRect(hwnd, out r))
        {
            curX = r.left;
            curY = r.top;
            curW = Math.Max(320, r.right - r.left);
            curH = Math.Max(220, r.bottom - r.top);
        }
        int usableW = Math.Max(360, _width - 24);
        int usableH = Math.Max(280, _height - 52);
        int minW = Math.Min(usableW, 560);
        int minH = Math.Min(usableH, 420);
        int nw = Math.Min(usableW, Math.Max(minW, curW));
        int nh = Math.Min(usableH, Math.Max(minH, curH));
        int maxX = Math.Max(8, _width - nw - 8);
        int maxY = Math.Max(8, _height - 36 - nh - 8);
        int nx = curX >= 0 && curX <= maxX ? curX : Math.Min(12, maxX);
        int ny = curY >= 0 && curY <= maxY ? curY : Math.Min(12, maxY);
        SetWindowPos(hwnd, IntPtr.Zero, nx, ny, nw, nh, SWP_SHOWWINDOW | SWP_NOZORDER);
        if (bringTop) BringWindowToTop(hwnd);
    }

    static void RefitAllWindowsToBounds()
    {
        foreach (var hwnd in RawDesktopWindows())
        {
            Rect r;
            if (!GetWindowRect(hwnd, out r)) continue;
            int w = r.right - r.left;
            int h = r.bottom - r.top;
            bool outOfBounds = r.left < 0 || r.top < 0 || r.right > _width || r.bottom > _height - 36 || w > _width - 16 || h > _height - 44;
            if (outOfBounds)
            {
                FitWindowToDesktop(hwnd, false);
            }
        }
    }

    static object ResizeDesktopSession(IDictionary<string, object> args)
    {
        int w = ClampDesktopWidth(Num(args, "width", _width));
        int h = ClampDesktopHeight(Num(args, "height", _height));
        _width = w;
        _height = h;
        if (_agentDesktop != IntPtr.Zero && _workerThread != null && _workerThread.IsAlive)
        {
            RunOnDesktopThread(() =>
            {
                RefitAllWindowsToBounds();
                return true;
            });
        }
        return new
        {
            ok = true,
            width = _width,
            height = _height,
            desktopName = _desktopName,
            usedBackend = "win32_create_desktop"
        };
    }

    static string ResolveLaunchExecutable(string rawApp, out string extraArgs, out bool isChromium)
    {
        string trimmed = (rawApp ?? "").Trim().Trim('"');
        string lower = trimmed.ToLowerInvariant();
        extraArgs = "";
        isChromium = false;

        if (lower.StartsWith("http://") || lower.StartsWith("https://"))
        {
            extraArgs = trimmed;
            lower = "msedge";
        }

        string edge64 = @"C:\Program Files\Microsoft\Edge\Application\msedge.exe";
        string edge86 = @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
        string chrome64 = @"C:\Program Files\Google\Chrome\Application\chrome.exe";
        string chrome86 = @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe";

        if (lower == "notepad" || lower == "notepad.exe")
        {
            return Path.Combine(Environment.SystemDirectory, "notepad.exe");
        }
        if (lower == "calc" || lower == "calculator" || lower == "calc.exe")
        {
            return Path.Combine(Environment.SystemDirectory, "calc.exe");
        }
        if (lower == "cmd" || lower == "cmd.exe" || lower == "terminal")
        {
            return Path.Combine(Environment.SystemDirectory, "cmd.exe");
        }
        if (lower == "powershell" || lower == "powershell.exe")
        {
            return Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
        }
        if (lower == "explorer" || lower == "explorer.exe")
        {
            extraArgs = "/separate";
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
        }
        if (lower == "msedge" || lower == "edge" || lower == "browser" || lower == "msedge.exe")
        {
            isChromium = true;
            if (File.Exists(edge86)) return edge86;
            if (File.Exists(edge64)) return edge64;
        }
        if (lower == "chrome" || lower == "chrome.exe")
        {
            isChromium = true;
            if (File.Exists(chrome64)) return chrome64;
            if (File.Exists(chrome86)) return chrome86;
        }
        if (lower.EndsWith("msedge.exe") || lower.EndsWith("chrome.exe") || lower.EndsWith("electron.exe"))
        {
            isChromium = true;
        }
        return trimmed;
    }

    static object LaunchOnDesktop(IDictionary<string, object> args)
    {
        if (_agentDesktop == IntPtr.Zero) OpenDesktopSession(args);
        string appRaw = Str(args, "app");
        if (string.IsNullOrWhiteSpace(appRaw)) throw new Exception("app_required");
        string userArgs = Str(args, "args", "").Trim();
        string cwd = Str(args, "cwd", "").Trim();
        if (string.IsNullOrEmpty(cwd) || !Directory.Exists(cwd)) cwd = null;

        string autoArgs;
        bool isChromium;
        string exe = ResolveLaunchExecutable(appRaw, out autoArgs, out isChromium);

        var cmd = new StringBuilder();
        cmd.Append('"').Append(exe).Append('"');
        if (isChromium)
        {
            string profileDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MagicPointer", "cu-desktop-browser");
            Directory.CreateDirectory(profileDir);
            cmd.Append(" --user-data-dir=\"").Append(profileDir).Append('"');
            cmd.Append(" --disable-gpu-compositing --disable-gpu --no-first-run --no-default-browser-check --new-window");
            cmd.AppendFormat(" --window-size={0},{1}", Math.Max(480, _width - 24), Math.Max(360, _height - 52));
        }
        if (!string.IsNullOrEmpty(autoArgs))
        {
            if (!(autoArgs == "/separate" && userArgs.IndexOf("/separate", StringComparison.OrdinalIgnoreCase) >= 0))
            {
                cmd.Append(' ').Append(autoArgs);
            }
        }
        if (!string.IsNullOrEmpty(userArgs)) cmd.Append(' ').Append(userArgs);

        var existingHwnds = RunOnDesktopThread(() => new HashSet<long>(RawDesktopWindows().ConvertAll(h => h.ToInt64())));

        var si = new StartupInfo();
        si.cb = Marshal.SizeOf(typeof(StartupInfo));
        si.lpDesktop = _desktopPath;
        si.dwFlags = 0x00000001;
        si.wShowWindow = 1;

        ProcessInformation pi;
        if (!CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x04000000 /* CREATE_UNICODE_ENVIRONMENT */, IntPtr.Zero, cwd, ref si, out pi))
        {
            throw new Exception("create_process_failed:" + Marshal.GetLastWin32Error() + ":" + exe);
        }
        int spawnedPid = (int)pi.dwProcessId;
        lock (_trackedPids) { _trackedPids.Add(spawnedPid); }
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);

        IntPtr targetHwnd = IntPtr.Zero;
        var watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < 3800)
        {
            targetHwnd = RunOnDesktopThread(() =>
            {
                var cur = RawDesktopWindows();
                foreach (var h in cur)
                {
                    uint wp;
                    GetWindowThreadProcessId(h, out wp);
                    if ((int)wp == spawnedPid) return h;
                }
                foreach (var h in cur)
                {
                    if (!existingHwnds.Contains(h.ToInt64())) return h;
                }
                return IntPtr.Zero;
            });
            if (targetHwnd != IntPtr.Zero) break;
            Thread.Sleep(80);
        }

        Dictionary<string, object> windowInfo = null;
        if (targetHwnd != IntPtr.Zero)
        {
            windowInfo = RunOnDesktopThread(() =>
            {
                uint wp;
                GetWindowThreadProcessId(targetHwnd, out wp);
                lock (_trackedPids) { _trackedPids.Add((int)wp); }
                FitWindowToDesktop(targetHwnd, true);
                _activeHwnd = targetHwnd;
                return WindowRow(targetHwnd, 1);
            });
        }

        return new
        {
            ok = true,
            pid = spawnedPid,
            window = windowInfo,
            windows = ListDesktopWindows(),
            desktop = "agent",
            usedBackend = "win32_create_desktop"
        };
    }

    static bool HasNonBlankPixels(Bitmap bmp)
    {
        int stepX = Math.Max(1, bmp.Width / 12);
        int stepY = Math.Max(1, bmp.Height / 12);
        for (int y = 4; y < bmp.Height - 4; y += stepY)
        {
            for (int x = 4; x < bmp.Width - 4; x += stepX)
            {
                Color c = bmp.GetPixel(x, y);
                if (c.A > 10 && (c.R > 3 || c.G > 3 || c.B > 3)) return true;
            }
        }
        return false;
    }

    static Bitmap CaptureSingleWindowBitmap(IntPtr hwnd, int w, int h)
    {
        var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.White);
            IntPtr hdc = g.GetHdc();
            try
            {
                PrintWindow(hwnd, hdc, 2); // PW_RENDERFULLCONTENT
            }
            finally
            {
                g.ReleaseHdc(hdc);
            }
        }
        if (HasNonBlankPixels(bmp)) return bmp;

        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.White);
            IntPtr hdc = g.GetHdc();
            try
            {
                PrintWindow(hwnd, hdc, 0);
            }
            finally
            {
                g.ReleaseHdc(hdc);
            }
        }
        if (HasNonBlankPixels(bmp)) return bmp;

        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.White);
            IntPtr hdc = g.GetHdc();
            try
            {
                IntPtr ignored;
                SendMessageTimeoutW(hwnd, WM_PRINT, hdc, new IntPtr(0x1E), 2, 350, out ignored);
            }
            finally
            {
                g.ReleaseHdc(hdc);
            }
        }
        return bmp;
    }

    static ImageCodecInfo GetJpegEncoder()
    {
        foreach (var codec in ImageCodecInfo.GetImageEncoders())
        {
            if (codec.MimeType == "image/jpeg") return codec;
        }
        return null;
    }

    static object CaptureDesktop(IDictionary<string, object> args)
    {
        int quality = Math.Max(30, Math.Min(95, Num(args, "quality", 78)));
        return RunOnDesktopThread(() =>
        {
            var hwnds = RawDesktopWindows();
            var windowRows = new List<object>();
            for (int i = 0; i < hwnds.Count; i++) windowRows.Add(WindowRow(hwnds[i], i + 1));

            using (var canvas = new Bitmap(_width, _height, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(canvas))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    // Calm stone-paper wallpaper matching Claude Studio neutral aesthetic
                    using (var bgBrush = new LinearGradientBrush(new Rectangle(0, 0, _width, _height), Color.FromArgb(245, 243, 238), Color.FromArgb(236, 233, 226), 135f))
                    {
                        g.FillRectangle(bgBrush, 0, 0, _width, _height);
                    }
                    // Paint windows bottom-to-top (reverse z-order)
                    for (int i = hwnds.Count - 1; i >= 0; i--)
                    {
                        IntPtr hwnd = hwnds[i];
                        if (IsIconic(hwnd)) continue;
                        Rect r;
                        if (!GetWindowRect(hwnd, out r)) continue;
                        int ww = r.right - r.left;
                        int wh = r.bottom - r.top;
                        if (ww <= 0 || wh <= 0) continue;
                        try
                        {
                            using (var wbmp = CaptureSingleWindowBitmap(hwnd, ww, wh))
                            {
                                g.DrawImageUnscaled(wbmp, r.left, r.top);
                            }
                            if (hwnd == _activeHwnd)
                            {
                                using (var pen = new Pen(Color.FromArgb(140, 217, 119, 87), 2))
                                {
                                    g.DrawRectangle(pen, r.left, r.top, Math.Max(1, ww - 1), Math.Max(1, wh - 1));
                                }
                            }
                        }
                        catch { }
                    }
                    // Subtle virtual taskbar at bottom 36px
                    int tbY = _height - 36;
                    using (var tbBrush = new SolidBrush(Color.FromArgb(235, 248, 247, 244)))
                    {
                        g.FillRectangle(tbBrush, 0, tbY, _width, 36);
                    }
                    using (var sep = new Pen(Color.FromArgb(40, 20, 20, 19), 1))
                    {
                        g.DrawLine(sep, 0, tbY, _width, tbY);
                    }
                    using (var font = new Font("Segoe UI", 12f, FontStyle.Regular, GraphicsUnit.Pixel))
                    using (var bold = new Font("Segoe UI", 12f, FontStyle.Bold, GraphicsUnit.Pixel))
                    using (var sf = new StringFormat { Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap, LineAlignment = StringAlignment.Center })
                    using (var textBrush = new SolidBrush(Color.FromArgb(45, 44, 41)))
                    using (var mutedBrush = new SolidBrush(Color.FromArgb(120, 118, 112)))
                    using (var dotBrush = new SolidBrush(Color.FromArgb(217, 119, 87)))
                    {
                        g.FillEllipse(dotBrush, 14, tbY + 13, 10, 10);
                        g.DrawString("Second Desktop", bold, textBrush, new RectangleF(30, tbY, 140, 36), sf);
                        int chipX = 166;
                        foreach (var hwnd in hwnds)
                        {
                            int remaining = _width - chipX - 10;
                            if (remaining < 72) break;
                            string t = TitleOf(hwnd);
                            if (string.IsNullOrWhiteSpace(t)) t = "App";
                            bool active = hwnd == _activeHwnd;
                            int measured = (int)Math.Ceiling(g.MeasureString(t, font).Width) + 20;
                            int chipW = Math.Min(remaining, Math.Min(196, Math.Max(84, measured)));
                            using (var cb = new SolidBrush(active ? Color.FromArgb(255, 255, 255) : Color.FromArgb(228, 225, 218)))
                            {
                                g.FillRectangle(cb, chipX, tbY + 6, chipW, 24);
                            }
                            if (active)
                            {
                                using (var ab = new Pen(Color.FromArgb(217, 119, 87), 1))
                                {
                                    g.DrawRectangle(ab, chipX, tbY + 6, chipW, 24);
                                }
                            }
                            g.DrawString(t, font, active ? textBrush : mutedBrush, new RectangleF(chipX + 8, tbY + 6, chipW - 14, 24), sf);
                            chipX += chipW + 8;
                        }
                    }
                }
                using (var ms = new MemoryStream())
                {
                    var jpg = GetJpegEncoder();
                    if (jpg != null)
                    {
                        using (var ep = new EncoderParameters(1))
                        {
                            ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                            canvas.Save(ms, jpg, ep);
                        }
                    }
                    else
                    {
                        canvas.Save(ms, ImageFormat.Jpeg);
                    }
                    return (object)new
                    {
                        ok = true,
                        mimeType = "image/jpeg",
                        image = Convert.ToBase64String(ms.ToArray()),
                        width = _width,
                        height = _height,
                        windows = windowRows,
                        desktopName = _desktopName,
                        capturedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                    };
                }
            }
        });
    }

    static IntPtr HitWindow(int x, int y, long explicitHwnd)
    {
        var hwnds = RawDesktopWindows();
        if (explicitHwnd != 0)
        {
            foreach (var h in hwnds)
            {
                if (h.ToInt64() == explicitHwnd) return h;
            }
        }
        foreach (var h in hwnds)
        {
            if (IsIconic(h)) continue;
            Rect r;
            if (GetWindowRect(h, out r) && x >= r.left && x < r.right && y >= r.top && y < r.bottom)
            {
                return h;
            }
        }
        if (_activeHwnd != IntPtr.Zero && IsWindow(_activeHwnd)) return _activeHwnd;
        return hwnds.Count > 0 ? hwnds[0] : IntPtr.Zero;
    }

    static void FocusLocalWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return;
        if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
        SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        BringWindowToTop(hwnd);
        _activeHwnd = hwnd;
        uint ignoredPid;
        uint targetThread = GetWindowThreadProcessId(hwnd, out ignoredPid);
        uint selfThread = GetCurrentThreadId();
        bool attached = targetThread != 0 && targetThread != selfThread && AttachThreadInput(selfThread, targetThread, true);
        try
        {
            SetActiveWindow(hwnd);
        }
        finally
        {
            if (attached) AttachThreadInput(selfThread, targetThread, false);
        }
    }

    static IntPtr DeepestChildAt(IntPtr rootHwnd, int screenX, int screenY)
    {
        IntPtr current = rootHwnd;
        for (int depth = 0; depth < 12; depth++)
        {
            var pt = new Point(screenX, screenY);
            if (!ScreenToClient(current, ref pt)) break;
            IntPtr child = ChildWindowFromPointEx(current, pt, 0x0001 | 0x0002 /* CWP_SKIPINVISIBLE | CWP_SKIPDISABLED */);
            if (child == IntPtr.Zero || child == current) break;
            current = child;
        }
        return current;
    }

    static bool IsEditableClass(string cls)
    {
        if (string.IsNullOrEmpty(cls)) return false;
        string lower = cls.ToLowerInvariant();
        return lower == "edit" || lower.Contains("richedit") || lower.Contains("scintilla") || lower.Contains("renderwidgethost") || lower.Contains("notepad") || lower.Contains("textbox");
    }

    static IntPtr FindBestInputTarget(IntPtr rootHwnd, int? optX, int? optY)
    {
        if (optX.HasValue && optY.HasValue)
        {
            IntPtr hit = DeepestChildAt(rootHwnd, optX.Value, optY.Value);
            if (hit != IntPtr.Zero && IsEditableClass(ClassOf(hit))) return hit;
        }
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(rootHwnd, delegate(IntPtr child, IntPtr unused)
        {
            if (!IsWindowVisible(child) || !IsWindowEnabled(child)) return true;
            if (IsEditableClass(ClassOf(child)))
            {
                found = child;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        if (found != IntPtr.Zero) return found;
        uint ignoredTidPid;
        uint tid = GetWindowThreadProcessId(rootHwnd, out ignoredTidPid);
        var gui = new GuiThreadInfo { cbSize = Marshal.SizeOf(typeof(GuiThreadInfo)) };
        if (GetGUIThreadInfo(tid, ref gui) && gui.focus != IntPtr.Zero) return gui.focus;
        if (optX.HasValue && optY.HasValue) return DeepestChildAt(rootHwnd, optX.Value, optY.Value);
        return rootHwnd;
    }

    static void FocusTargetControl(IntPtr rootHwnd, IntPtr targetHwnd)
    {
        uint ignoredFocusPid;
        uint targetThread = GetWindowThreadProcessId(rootHwnd, out ignoredFocusPid);
        uint selfThread = GetCurrentThreadId();
        bool attached = targetThread != 0 && targetThread != selfThread && AttachThreadInput(selfThread, targetThread, true);
        try
        {
            SetActiveWindow(rootHwnd);
            if (targetHwnd != IntPtr.Zero) SetFocus(targetHwnd);
        }
        finally
        {
            if (attached) AttachThreadInput(selfThread, targetThread, false);
        }
    }

    static bool TryTypeViaUia(IntPtr rootHwnd, string text, bool clear)
    {
        try
        {
            var root = AutomationElement.FromHandle(rootHwnd);
            if (root == null) return false;
            var cond = new OrCondition(
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit)
            );
            var target = root.FindFirst(TreeScope.Descendants, cond);
            if (target == null) return false;
            object vpObj;
            if (target.TryGetCurrentPattern(ValuePattern.Pattern, out vpObj))
            {
                var vp = (ValuePattern)vpObj;
                if (!vp.Current.IsReadOnly)
                {
                    string prev = clear ? "" : (vp.Current.Value ?? "");
                    vp.SetValue(prev + text);
                    return true;
                }
            }
        }
        catch { }
        return false;
    }

    static void SendKeyChordToHwnd(IntPtr targetHwnd, string chordRaw)
    {
        if (string.IsNullOrWhiteSpace(chordRaw)) return;
        string[] parts = chordRaw.ToLowerInvariant().Split(new[] { '+', ' ' }, StringSplitOptions.RemoveEmptyEntries);
        bool hasCtrl = false, hasAlt = false;
        ushort mainKey = 0;
        foreach (string part in parts)
        {
            ushort code;
            if (part == "ctrl" || part == "control") hasCtrl = true;
            else if (part == "alt" || part == "menu") hasAlt = true;
            else if (part == "shift") { }
            else if (Keys.TryGetValue(part, out code)) mainKey = code;
            else if (part.Length == 1)
            {
                short vk = VkKeyScanW(part[0]);
                if (vk != -1) mainKey = (ushort)(vk & 0xff);
            }
        }
        if (hasCtrl && mainKey == (ushort)'A')
        {
            PostMessageW(targetHwnd, EM_SETSEL, IntPtr.Zero, new IntPtr(-1));
            return;
        }
        if (hasCtrl && mainKey == (ushort)'C') { PostMessageW(targetHwnd, WM_COPY, IntPtr.Zero, IntPtr.Zero); return; }
        if (hasCtrl && mainKey == (ushort)'X') { PostMessageW(targetHwnd, WM_CUT, IntPtr.Zero, IntPtr.Zero); return; }
        if (hasCtrl && mainKey == (ushort)'V') { PostMessageW(targetHwnd, WM_PASTE, IntPtr.Zero, IntPtr.Zero); return; }
        if (hasAlt && mainKey == 115) // Alt+F4
        {
            PostMessageW(targetHwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            return;
        }
        if (mainKey != 0)
        {
            uint downMsg = hasAlt ? WM_SYSKEYDOWN : WM_KEYDOWN;
            uint upMsg = hasAlt ? WM_SYSKEYUP : WM_KEYUP;
            PostMessageW(targetHwnd, downMsg, new IntPtr(mainKey), new IntPtr(1));
            Thread.Sleep(10);
            PostMessageW(targetHwnd, upMsg, new IntPtr(mainKey), new IntPtr(unchecked((int)0xC0000001)));
        }
    }

    static object ActDesktop(IDictionary<string, object> args)
    {
        return RunOnDesktopThread(() =>
        {
            string action = Str(args, "action", "click").ToLowerInvariant();
            int x = Num(args, "x", _width / 2);
            int y = Num(args, "y", _height / 2);
            long explicitHwnd = Num64(args, "hwnd", 0);
            IntPtr hwnd = HitWindow(x, y, explicitHwnd);

            if (action == "noop")
            {
                return (object)new { ok = true, action = "noop", hwnd = hwnd.ToInt64() };
            }
            if (hwnd == IntPtr.Zero)
            {
                throw new Exception("no_window_on_second_desktop");
            }

            if (action == "focus_window")
            {
                FocusLocalWindow(hwnd);
                return new { ok = true, hwnd = hwnd.ToInt64(), action = "focus_window" };
            }
            if (action == "close_window")
            {
                PostMessageW(hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                return new { ok = true, hwnd = hwnd.ToInt64(), action = "close_window" };
            }
            if (action == "resize_window")
            {
                int w = Math.Max(200, Num(args, "width", 800));
                int h = Math.Max(160, Num(args, "height", 560));
                SetWindowPos(hwnd, IntPtr.Zero, x, y, w, h, SWP_SHOWWINDOW | SWP_NOZORDER);
                FocusLocalWindow(hwnd);
                return new { ok = true, hwnd = hwnd.ToInt64(), action = "resize_window" };
            }

            FocusLocalWindow(hwnd);

            if (action == "click" || action == "double_click" || action == "right_click")
            {
                IntPtr ncRes = IntPtr.Zero;
                SendMessageTimeoutW(hwnd, WM_NCHITTEST, IntPtr.Zero, MakeLParam(x, y), 2, 150, out ncRes);
                int hitCode = ncRes.ToInt32();
                if (hitCode == 20) { PostMessageW(hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); return new { ok = true, hwnd = hwnd.ToInt64(), action = action, nc = "close" }; }
                if (hitCode == 8) { ShowWindow(hwnd, 6); return new { ok = true, hwnd = hwnd.ToInt64(), action = action, nc = "minimize" }; }
                if (hitCode == 9) { ShowWindow(hwnd, 3); return new { ok = true, hwnd = hwnd.ToInt64(), action = action, nc = "maximize" }; }

                IntPtr child = DeepestChildAt(hwnd, x, y);
                FocusTargetControl(hwnd, child);
                var cpt = new Point(x, y);
                ScreenToClient(child, ref cpt);
                IntPtr lParam = MakeLParam(cpt.x, cpt.y);
                int count = action == "double_click" ? 2 : Math.Max(1, Math.Min(2, Num(args, "count", 1)));
                if (action == "right_click" || Str(args, "button", "left").ToLowerInvariant() == "right")
                {
                    PostMessageW(child, WM_RBUTTONDOWN, new IntPtr(2), lParam);
                    Thread.Sleep(20);
                    PostMessageW(child, WM_RBUTTONUP, IntPtr.Zero, lParam);
                }
                else
                {
                    for (int i = 0; i < count; i++)
                    {
                        PostMessageW(child, i == 1 ? WM_LBUTTONDBLCLK : WM_LBUTTONDOWN, new IntPtr(1), lParam);
                        Thread.Sleep(20);
                        PostMessageW(child, WM_LBUTTONUP, IntPtr.Zero, lParam);
                        if (i + 1 < count) Thread.Sleep(40);
                    }
                }
                return new { ok = true, hwnd = hwnd.ToInt64(), targetHwnd = child.ToInt64(), x = x, y = y, action = action, method = "second_desktop_postmessage" };
            }

            if (action == "move")
            {
                IntPtr child = DeepestChildAt(hwnd, x, y);
                var cpt = new Point(x, y);
                ScreenToClient(child, ref cpt);
                PostMessageW(child, WM_MOUSEMOVE, IntPtr.Zero, MakeLParam(cpt.x, cpt.y));
                return new { ok = true, hwnd = hwnd.ToInt64(), x = x, y = y, action = "move" };
            }

            if (action == "drag")
            {
                int tx = Num(args, "to_x", x);
                int ty = Num(args, "to_y", y);
                IntPtr ncRes = IntPtr.Zero;
                SendMessageTimeoutW(hwnd, WM_NCHITTEST, IntPtr.Zero, MakeLParam(x, y), 2, 150, out ncRes);
                if (ncRes.ToInt32() == 2) // HTCAPTION: drag window cleanly on Second Desktop
                {
                    Rect r;
                    GetWindowRect(hwnd, out r);
                    SetWindowPos(hwnd, IntPtr.Zero, r.left + (tx - x), r.top + (ty - y), 0, 0, SWP_NOSIZE | SWP_NOZORDER);
                    return new { ok = true, hwnd = hwnd.ToInt64(), action = "drag", movedWindow = true };
                }
                IntPtr child = DeepestChildAt(hwnd, x, y);
                var p1 = new Point(x, y); ScreenToClient(child, ref p1);
                var p2 = new Point(tx, ty); ScreenToClient(child, ref p2);
                PostMessageW(child, WM_LBUTTONDOWN, new IntPtr(1), MakeLParam(p1.x, p1.y));
                for (int s = 1; s <= 8; s++)
                {
                    int mx = p1.x + (p2.x - p1.x) * s / 8;
                    int my = p1.y + (p2.y - p1.y) * s / 8;
                    PostMessageW(child, WM_MOUSEMOVE, new IntPtr(1), MakeLParam(mx, my));
                    Thread.Sleep(12);
                }
                PostMessageW(child, WM_LBUTTONUP, IntPtr.Zero, MakeLParam(p2.x, p2.y));
                return new { ok = true, hwnd = hwnd.ToInt64(), action = "drag", to_x = tx, to_y = ty };
            }

            if (action == "scroll")
            {
                int dy = Num(args, "dy", -120);
                IntPtr child = DeepestChildAt(hwnd, x, y);
                IntPtr wParam = new IntPtr((dy & 0xFFFF) << 16);
                PostMessageW(child, WM_MOUSEWHEEL, wParam, MakeLParam(x, y));
                return new { ok = true, hwnd = hwnd.ToInt64(), action = "scroll", dy = dy };
            }

            if (action == "type_text")
            {
                string text = Str(args, "text", "");
                bool clear = Convert.ToBoolean(Get(args, "clear", false));
                IntPtr targetChild = FindBestInputTarget(hwnd, Get(args, "x") != null ? (int?)x : null, Get(args, "y") != null ? (int?)y : null);
                FocusTargetControl(hwnd, targetChild);
                if (clear)
                {
                    PostMessageW(targetChild, EM_SETSEL, IntPtr.Zero, new IntPtr(-1));
                    Thread.Sleep(15);
                }
                bool uiaSet = TryTypeViaUia(hwnd, text, clear);
                if (!uiaSet)
                {
                    foreach (char ch in text)
                    {
                        if (ch == '\r') continue;
                        if (ch == '\n')
                        {
                            PostMessageW(targetChild, WM_KEYDOWN, new IntPtr(13), new IntPtr(1));
                            PostMessageW(targetChild, WM_KEYUP, new IntPtr(13), new IntPtr(unchecked((int)0xC0000001)));
                        }
                        else
                        {
                            PostMessageW(targetChild, WM_CHAR, new IntPtr(ch), new IntPtr(1));
                        }
                        Thread.Sleep(2);
                    }
                }
                if (Convert.ToBoolean(Get(args, "submit", false)))
                {
                    Thread.Sleep(20);
                    PostMessageW(targetChild, WM_KEYDOWN, new IntPtr(13), new IntPtr(1));
                    PostMessageW(targetChild, WM_KEYUP, new IntPtr(13), new IntPtr(unchecked((int)0xC0000001)));
                }
                return new { ok = true, hwnd = hwnd.ToInt64(), targetHwnd = targetChild.ToInt64(), action = "type_text", length = text.Length, method = uiaSet ? "second_desktop_uia" : "second_desktop_wm_char" };
            }

            if (action == "press_key")
            {
                string keys = Str(args, "keys", "");
                IntPtr targetChild = FindBestInputTarget(hwnd, null, null);
                FocusTargetControl(hwnd, targetChild);
                SendKeyChordToHwnd(targetChild, keys);
                return new { ok = true, hwnd = hwnd.ToInt64(), action = "press_key", keys = keys };
            }

            throw new Exception("unsupported_second_desktop_action:" + action);
        });
    }

    static object ElementsOnDesktop(long hwnd, int limit)
    {
        return RunOnDesktopThread(() =>
        {
            IntPtr h = new IntPtr(hwnd);
            if (!IsWindow(h)) throw new Exception("window_not_found");
            var root = AutomationElement.FromHandle(h);
            var rows = new List<object>();
            var queue = new Queue<Tuple<AutomationElement, int, int>>();
            queue.Enqueue(Tuple.Create(root, 0, 0));
            while (queue.Count > 0 && rows.Count < limit)
            {
                var item = queue.Dequeue();
                AutomationElement el = item.Item1;
                int index = rows.Count + 1;
                try
                {
                    var r = el.Current.BoundingRectangle;
                    string role = el.Current.ControlType == null ? "" : el.Current.ControlType.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant();
                    string val = "";
                    object vp;
                    if (!el.Current.IsPassword && el.TryGetCurrentPattern(ValuePattern.Pattern, out vp))
                    {
                        val = ((ValuePattern)vp).Current.Value ?? "";
                    }
                    string docText = "";
                    object tp;
                    if (!el.Current.IsPassword && el.TryGetCurrentPattern(TextPattern.Pattern, out tp))
                    {
                        docText = ((TextPattern)tp).DocumentRange.GetText(4096) ?? "";
                    }
                    rows.Add(new Dictionary<string, object>
                    {
                        {"index", index},
                        {"parent_index", item.Item2},
                        {"depth", item.Item3},
                        {"hwnd", hwnd},
                        {"role", role},
                        {"name", el.Current.Name ?? ""},
                        {"value", val},
                        {"text", docText},
                        {"rect", r.IsEmpty ? new[] {0,0,0,0} : new[] {(int)r.Left,(int)r.Top,(int)r.Right,(int)r.Bottom}},
                        {"enabled", el.Current.IsEnabled},
                        {"focused", el.Current.HasKeyboardFocus}
                    });
                    if (item.Item3 < 20)
                    {
                        var children = el.FindAll(TreeScope.Children, Condition.TrueCondition);
                        for (int i = 0; i < children.Count; i++)
                        {
                            queue.Enqueue(Tuple.Create(children[i], index, item.Item3 + 1));
                        }
                    }
                }
                catch { }
            }
            return (object)new { elements = rows.ToArray(), usedBackend = "second_desktop_uia" };
        });
    }

    static object InspectAxOnDesktop(long targetHwnd, int limit)
    {
        int cappedLimit = Math.Max(20, Math.Min(200, limit));
        return RunOnDesktopThread(() =>
        {
            IntPtr h = targetHwnd != 0 ? new IntPtr(targetHwnd) : HitWindow(_width / 2, _height / 2, 0);
            if (h == IntPtr.Zero || !IsWindow(h))
            {
                return (object)new
                {
                    ok = false,
                    reason = "window_not_found",
                    hwnd = 0L,
                    title = "",
                    elements = new object[0],
                    treeText = "",
                    usedBackend = "second_desktop_uia"
                };
            }
            string winTitle = TitleOf(h);
            var rows = new List<Dictionary<string, object>>();
            var lines = new List<string>();
            var sw = Stopwatch.StartNew();
            try
            {
                var root = AutomationElement.FromHandle(h);
                if (root != null)
                {
                    var queue = new Queue<Tuple<AutomationElement, int>>();
                    queue.Enqueue(Tuple.Create(root, 0));
                    while (queue.Count > 0 && rows.Count < cappedLimit && sw.ElapsedMilliseconds < 900)
                    {
                        var item = queue.Dequeue();
                        AutomationElement el = item.Item1;
                        int depth = item.Item2;
                        try
                        {
                            var r = el.Current.BoundingRectangle;
                            string role = el.Current.ControlType == null ? "element" : el.Current.ControlType.ProgrammaticName.Replace("ControlType.", "");
                            string name = el.Current.Name ?? "";
                            string val = "";
                            object vp;
                            if (!el.Current.IsPassword && el.TryGetCurrentPattern(ValuePattern.Pattern, out vp))
                            {
                                val = ((ValuePattern)vp).Current.Value ?? "";
                            }
                            bool hasBox = !r.IsEmpty && r.Width > 1 && r.Height > 1;
                            int cx = hasBox ? (int)Math.Round(r.Left + r.Width / 2.0) : 0;
                            int cy = hasBox ? (int)Math.Round(r.Top + r.Height / 2.0) : 0;
                            int idx = rows.Count + 1;
                            rows.Add(new Dictionary<string, object>
                            {
                                {"index", idx},
                                {"depth", depth},
                                {"hwnd", h.ToInt64()},
                                {"role", role},
                                {"name", name},
                                {"value", val.Length > 160 ? val.Substring(0, 160) : val},
                                {"x", cx},
                                {"y", cy},
                                {"width", hasBox ? (int)Math.Round(r.Width) : 0},
                                {"height", hasBox ? (int)Math.Round(r.Height) : 0},
                                {"focusable", el.Current.IsKeyboardFocusable},
                                {"enabled", el.Current.IsEnabled}
                            });
                            string shortName = name.Length > 48 ? name.Substring(0, 48) + "..." : name;
                            lines.Add(string.Format("[e{0}] {1}{2} ({3}, {4})", idx, role, string.IsNullOrEmpty(shortName) ? "" : " \"" + shortName + "\"", cx, cy));
                            if (depth < 8 && rows.Count < cappedLimit)
                            {
                                var children = el.FindAll(TreeScope.Children, Condition.TrueCondition);
                                for (int i = 0; i < children.Count && rows.Count + queue.Count < cappedLimit * 2; i++)
                                {
                                    queue.Enqueue(Tuple.Create(children[i], depth + 1));
                                }
                            }
                        }
                        catch { }
                    }
                }
            }
            catch { }
            return (object)new
            {
                ok = true,
                hwnd = h.ToInt64(),
                title = winTitle,
                elements = rows.ToArray(),
                treeText = string.Join("\n", lines.ToArray()),
                usedBackend = "second_desktop_uia"
            };
        });
    }

    static object CloseDesktopClean()
    {
        if (_agentDesktop != IntPtr.Zero)
        {
            try
            {
                RunOnDesktopThread(() =>
                {
                    foreach (var hwnd in RawDesktopWindows())
                    {
                        try { PostMessageW(hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); } catch { }
                    }
                    return true;
                }, 2000);
            }
            catch { }
            Thread.Sleep(220);
        }

        lock (_trackedPids)
        {
            foreach (int pid in _trackedPids)
            {
                try
                {
                    using (var p = Process.GetProcessById(pid))
                    {
                        if (!p.HasExited) p.Kill();
                    }
                }
                catch { }
            }
            _trackedPids.Clear();
        }

        if (_workerThread != null && _workerThread.IsAlive)
        {
            _workerStop = true;
            _workSignal.Set();
            _workerThread.Join(1500);
            _workerThread = null;
        }
        if (_agentDesktop != IntPtr.Zero)
        {
            CloseDesktop(_agentDesktop);
            _agentDesktop = IntPtr.Zero;
        }
        _activeHwnd = IntPtr.Zero;
        return new { ok = true };
    }

    static object Dispatch(string method, Dictionary<string, object> args)
    {
        if (method == "ping") return new { ok = true, open = _agentDesktop != IntPtr.Zero };
        if (method == "open") return OpenDesktopSession(args);
        if (method == "resize") return ResizeDesktopSession(args);
        if (method == "launch") return LaunchOnDesktop(args);
        if (method == "windows" || method == "list_windows") return ListDesktopWindows();
        if (method == "capture" || method == "screenshot") return CaptureDesktop(args);
        if (method == "elements") return ElementsOnDesktop(Num64(args, "hwnd", 0), Num(args, "limit", 400));
        if (method == "inspect_ax") return InspectAxOnDesktop(Num64(args, "hwnd", 0), Num(args, "limit", 120));
        if (method == "act") return ActDesktop(args);
        if (method == "close") return CloseDesktopClean();
        throw new Exception("unknown_cu_desktop_method:" + method);
    }

    [STAThread]
    public static int Main()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { SetProcessDPIAware(); }
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            object id = null;
            try
            {
                var req = Json.Deserialize<Dictionary<string, object>>(line);
                id = Get(req, "id");
                string method = Str(req, "method");
                var args = Obj(Get(req, "params"));
                var result = Dispatch(method, args);
                Console.WriteLine(Json.Serialize(new { id = id, result = result }));
            }
            catch (Exception ex)
            {
                Console.WriteLine(Json.Serialize(new { id = id, error = new { code = ex.Message, message = ex.ToString() } }));
            }
        }
        CloseDesktopClean();
        return 0;
    }
}
