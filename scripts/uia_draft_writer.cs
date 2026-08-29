using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;
using System.Web.Script.Serialization;

public static class UiaDraftWriter
{
    private const int SW_RESTORE = 9;
    private const uint GA_ROOT = 2;

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out NativePoint point);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out NativeRect rect);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(NativePoint point);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);

    public sealed class WriterResult
    {
        public bool ok = false;
        public long target_hwnd = 0;
        public string target_title = "";
        public int written_chars = 0;
        public int source_chars = 0;
        public string method = "";
        public bool verified = false;
        public bool submit_sent = false;
        public string delivery_mode = "";
        public string target_resolution = "";
        public bool resolved_from_trusted_native_evidence = false;
        public string error = null;
    }

    private sealed class DeliveryTarget
    {
        public IntPtr hwnd = IntPtr.Zero;
        public AutomationElement editable = null;
        public bool hasValuePattern = false;
        public string resolution = "";
        public string processName = "";
    }

    private static int Integer(Dictionary<string, object> data, string key, int fallback)
    {
        object value;
        if (!data.TryGetValue(key, out value) || value == null) return fallback;
        int parsed;
        return Int32.TryParse(Convert.ToString(value), out parsed) ? parsed : fallback;
    }

    private static long LongInteger(Dictionary<string, object> data, string key, long fallback)
    {
        object value;
        if (!data.TryGetValue(key, out value) || value == null) return fallback;
        long parsed;
        return Int64.TryParse(Convert.ToString(value), out parsed) ? parsed : fallback;
    }

    private static string Text(Dictionary<string, object> data, string key)
    {
        object value;
        return data.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : "";
    }

    private static bool Boolean(Dictionary<string, object> data, string key, bool fallback)
    {
        object value;
        if (!data.TryGetValue(key, out value) || value == null) return fallback;
        bool parsed;
        return System.Boolean.TryParse(Convert.ToString(value), out parsed) ? parsed : fallback;
    }

    private static int[] Point(Dictionary<string, object> data)
    {
        object value;
        if (!data.TryGetValue("target_point", out value) || value == null) return null;
        // JavaScriptSerializer 反序列化 JSON 数组的运行时类型不保证是
        // object[]（实测 as object[] 恒 null → 写入永远「target point is
        // missing」）。按 IEnumerable 逐项解析，数组/List 通吃。
        System.Collections.IEnumerable items = value as System.Collections.IEnumerable;
        if (items == null) return null;
        List<int> parsed = new List<int>();
        foreach (object item in items)
        {
            int coordinate;
            if (!Int32.TryParse(Convert.ToString(item), out coordinate)) return null;
            parsed.Add(coordinate);
        }
        if (parsed.Count != 2) return null;
        return parsed.ToArray();
    }

    private static string WindowText(IntPtr hwnd)
    {
        StringBuilder value = new StringBuilder(1024);
        GetWindowText(hwnd, value, value.Capacity);
        return value.ToString();
    }

    private static string WindowClass(IntPtr hwnd)
    {
        StringBuilder value = new StringBuilder(512);
        GetClassName(hwnd, value, value.Capacity);
        return value.ToString();
    }

    private static string NormalizeNewlines(string value)
    {
        return (value ?? "").Replace("\r\n", "\n").Replace("\r", "\n");
    }

    private static bool IsTerminal(string className, string processName, string title)
    {
        string value = ((className ?? "") + " " + (processName ?? "") + " " + (title ?? "")).ToLowerInvariant();
        return value.Contains("cascadia_hosting_window_class")
            || value.Contains("consolewindowclass")
            || value.Contains("windowsterminal")
            || value.Contains("powershell")
            || value.Contains("cmd.exe");
    }

    private static bool IsPassword(AutomationElement element)
    {
        object value = element.GetCurrentPropertyValue(AutomationElement.IsPasswordProperty, true);
        return value is bool && (bool)value;
    }

    private static string WindowProcessName(IntPtr hwnd)
    {
        try
        {
            uint processId;
            GetWindowThreadProcessId(hwnd, out processId);
            return processId > 0 ? Process.GetProcessById((int)processId).ProcessName : "";
        }
        catch { return ""; }
    }

    private static bool IsMagicPointerWindow(IntPtr hwnd, string processName)
    {
        string identity = ((processName ?? "") + " " + WindowProcessName(hwnd) + " "
            + WindowText(hwnd) + " " + WindowClass(hwnd)).ToLowerInvariant();
        return identity.Contains("magic pointer")
            || identity.Contains("magicpointer")
            || identity.Contains("vida overlay");
    }

    private static bool IsUsableEditable(AutomationElement element, out bool hasValuePattern)
    {
        hasValuePattern = false;
        if (element == null) return false;
        try
        {
            if (!element.Current.IsEnabled || element.Current.IsOffscreen || IsPassword(element)) return false;
            object valuePattern;
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out valuePattern))
            {
                ValuePattern pattern = valuePattern as ValuePattern;
                if (pattern != null && !pattern.Current.IsReadOnly)
                {
                    hasValuePattern = true;
                    return true;
                }
            }
            ControlType type = element.Current.ControlType;
            return (type == ControlType.Edit || type == ControlType.Document)
                && element.Current.IsKeyboardFocusable;
        }
        catch { return false; }
    }

    private static AutomationElement EditableFromElement(AutomationElement element, out bool hasValuePattern)
    {
        hasValuePattern = false;
        AutomationElement current = element;
        for (int depth = 0; current != null && depth < 12; depth++)
        {
            bool candidateHasValuePattern;
            if (IsUsableEditable(current, out candidateHasValuePattern))
            {
                hasValuePattern = candidateHasValuePattern;
                return current;
            }
            try { current = TreeWalker.ControlViewWalker.GetParent(current); }
            catch { current = null; }
        }
        return null;
    }

    private static bool ElementBelongsToWindow(AutomationElement element, IntPtr hwnd)
    {
        if (element == null || hwnd == IntPtr.Zero) return false;
        try
        {
            uint windowProcessId;
            GetWindowThreadProcessId(hwnd, out windowProcessId);
            return windowProcessId > 0 && element.Current.ProcessId == (int)windowProcessId;
        }
        catch { return false; }
    }

    private static AutomationElement FindBestEditableInWindow(
        IntPtr hwnd,
        NativePoint anchor,
        out bool hasValuePattern)
    {
        hasValuePattern = false;
        try
        {
            AutomationElement root = AutomationElement.FromHandle(hwnd);
            Condition editableTypes = new OrCondition(
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
            AutomationElementCollection candidates = root.FindAll(TreeScope.Descendants, editableTypes);
            AutomationElement best = null;
            bool bestHasValuePattern = false;
            double bestScore = Double.NegativeInfinity;
            int limit = Math.Min(candidates.Count, 256);
            for (int index = 0; index < limit; index++)
            {
                AutomationElement candidate = candidates[index];
                bool candidateHasValuePattern;
                if (!IsUsableEditable(candidate, out candidateHasValuePattern)) continue;
                System.Windows.Rect bounds = candidate.Current.BoundingRectangle;
                if (bounds.IsEmpty) continue;
                double centerX = bounds.Left + bounds.Width / 2.0;
                double centerY = bounds.Top + bounds.Height / 2.0;
                double dx = centerX - anchor.X;
                double dy = centerY - anchor.Y;
                double score = -Math.Sqrt(dx * dx + dy * dy);
                if (bounds.Contains(anchor.X, anchor.Y)) score += 1000000;
                if (candidate.Current.HasKeyboardFocus) score += 500000;
                if (candidateHasValuePattern) score += 1000;
                if (score > bestScore)
                {
                    best = candidate;
                    bestHasValuePattern = candidateHasValuePattern;
                    bestScore = score;
                }
            }
            hasValuePattern = bestHasValuePattern;
            return best;
        }
        catch { return null; }
    }

    private static bool WindowMatches(IntPtr hwnd, int expectedProcessId, string expectedTitle)
    {
        if (!IsWindow(hwnd)) return false;
        uint actualProcessId;
        GetWindowThreadProcessId(hwnd, out actualProcessId);
        if (expectedProcessId > 0 && actualProcessId != (uint)expectedProcessId) return false;
        string actualTitle = WindowText(hwnd);
        return String.IsNullOrEmpty(expectedTitle)
            || String.Equals(actualTitle, expectedTitle, StringComparison.Ordinal);
    }

    private static NativePoint WindowCenter(IntPtr hwnd, NativePoint fallback)
    {
        NativeRect rect;
        if (!GetWindowRect(hwnd, out rect) || rect.Right <= rect.Left || rect.Bottom <= rect.Top) return fallback;
        return new NativePoint {
            X = rect.Left + (rect.Right - rect.Left) / 2,
            Y = rect.Top + (rect.Bottom - rect.Top) / 2,
        };
    }

    private static DeliveryTarget Candidate(
        IntPtr hwnd,
        string resolution,
        string processName,
        int expectedProcessId,
        string expectedTitle,
        AutomationElement focused,
        NativePoint cursor,
        NativePoint originalPoint,
        bool preferCursor,
        bool preferOriginalPoint)
    {
        if (!WindowMatches(hwnd, expectedProcessId, expectedTitle)) return null;
        if (IsMagicPointerWindow(hwnd, processName)) return null;
        bool hasValuePattern;
        AutomationElement editable = null;
        if (resolution == "focused_editable" && ElementBelongsToWindow(focused, hwnd))
        {
            editable = EditableFromElement(focused, out hasValuePattern);
            if (editable != null)
            {
                return new DeliveryTarget { hwnd = hwnd, editable = editable, hasValuePattern = hasValuePattern,
                    resolution = resolution, processName = processName };
            }
        }
        if (resolution == "focused_editable") return null;
        if (preferCursor)
        {
            IntPtr pointed = GetAncestor(WindowFromPoint(cursor), GA_ROOT);
            if (pointed == hwnd)
            {
                editable = EditableAtPoint(cursor.X, cursor.Y, out hasValuePattern);
                if (editable != null && ElementBelongsToWindow(editable, hwnd))
                {
                    return new DeliveryTarget { hwnd = hwnd, editable = editable, hasValuePattern = hasValuePattern,
                        resolution = resolution, processName = processName };
                }
            }
        }
        if (preferOriginalPoint)
        {
            IntPtr pointed = GetAncestor(WindowFromPoint(originalPoint), GA_ROOT);
            if (pointed == hwnd)
            {
                editable = EditableAtPoint(originalPoint.X, originalPoint.Y, out hasValuePattern);
                if (editable != null && ElementBelongsToWindow(editable, hwnd))
                {
                    return new DeliveryTarget { hwnd = hwnd, editable = editable, hasValuePattern = hasValuePattern,
                        resolution = resolution, processName = processName };
                }
            }
        }
        if (ElementBelongsToWindow(focused, hwnd))
        {
            editable = EditableFromElement(focused, out hasValuePattern);
            if (editable != null)
            {
                return new DeliveryTarget { hwnd = hwnd, editable = editable, hasValuePattern = hasValuePattern,
                    resolution = resolution, processName = processName };
            }
        }
        NativePoint anchor = preferCursor
            ? cursor
            : (preferOriginalPoint ? originalPoint : WindowCenter(hwnd, originalPoint));
        editable = FindBestEditableInWindow(hwnd, anchor, out hasValuePattern);
        return editable == null ? null : new DeliveryTarget {
            hwnd = hwnd,
            editable = editable,
            hasValuePattern = hasValuePattern,
            resolution = resolution,
            processName = processName,
        };
    }

    private static DeliveryTarget ResolveDeliveryTarget(
        Dictionary<string, object> data,
        IntPtr originalHwnd,
        int originalProcessId,
        string originalTitle,
        string originalProcessName,
        NativePoint originalPoint)
    {
        string mode = Text(data, "target_resolution");
        AutomationElement focused = null;
        try { focused = AutomationElement.FocusedElement; } catch { }
        NativePoint cursor;
        if (!GetCursorPos(out cursor)) cursor = originalPoint;
        if (mode != "adaptive")
        {
            if (!WindowMatches(originalHwnd, originalProcessId, originalTitle)
                || IsMagicPointerWindow(originalHwnd, originalProcessName)
                || GetAncestor(WindowFromPoint(originalPoint), GA_ROOT) != originalHwnd)
            {
                return null;
            }
            bool exactHasValuePattern;
            AutomationElement exactEditable = EditableAtPoint(
                originalPoint.X, originalPoint.Y, out exactHasValuePattern);
            return exactEditable == null || !ElementBelongsToWindow(exactEditable, originalHwnd)
                ? null
                : new DeliveryTarget {
                    hwnd = originalHwnd,
                    editable = exactEditable,
                    hasValuePattern = exactHasValuePattern,
                    resolution = "exact_target",
                    processName = originalProcessName,
                };
        }

        IntPtr foreground = GetForegroundWindow();
        DeliveryTarget target = Candidate(foreground, "focused_editable", "", 0, "",
            focused, cursor, originalPoint, false, false);
        if (target != null) return target;

        IntPtr cursorWindow = GetAncestor(WindowFromPoint(cursor), GA_ROOT);
        target = Candidate(cursorWindow, "cursor_window", "", 0, "",
            focused, cursor, originalPoint, true, false);
        if (target != null) return target;

        IntPtr stableWindow = new IntPtr(LongInteger(data, "current_target_hwnd", 0));
        target = Candidate(stableWindow, "stable_foreground", Text(data, "current_target_process_name"),
            Integer(data, "current_target_process_id", 0), "", focused, cursor, originalPoint, false, false);
        if (target != null) return target;

        target = Candidate(foreground, "foreground_window", "", 0, "",
            focused, cursor, originalPoint, false, false);
        if (target != null) return target;

        return Candidate(originalHwnd, "original_target", originalProcessName, originalProcessId,
            originalTitle, focused, cursor, originalPoint, false, true);
    }

    private static AutomationElement EditableAtPoint(int x, int y, out bool hasValuePattern)
    {
        hasValuePattern = false;
        AutomationElement current = AutomationElement.FromPoint(new System.Windows.Point(x, y));
        AutomationElement keyboardCandidate = null;
        for (int depth = 0; current != null && depth < 12; depth++)
        {
            object valuePattern;
            if (current.TryGetCurrentPattern(ValuePattern.Pattern, out valuePattern))
            {
                ValuePattern pattern = valuePattern as ValuePattern;
                if (pattern != null && !pattern.Current.IsReadOnly)
                {
                    hasValuePattern = true;
                    return current;
                }
            }
            ControlType type = current.Current.ControlType;
            if (keyboardCandidate == null
                && (type == ControlType.Edit || type == ControlType.Document)
                && current.Current.IsKeyboardFocusable)
            {
                keyboardCandidate = current;
            }
            current = TreeWalker.ControlViewWalker.GetParent(current);
        }
        return keyboardCandidate;
    }

    private static bool VerifyTextPattern(AutomationElement element, string expected)
    {
        object textPattern;
        if (element.TryGetCurrentPattern(TextPattern.Pattern, out textPattern))
        {
            TextPattern pattern = textPattern as TextPattern;
            if (pattern != null)
            {
                string actual = NormalizeNewlines(pattern.DocumentRange.GetText(-1));
                if (actual.Contains(NormalizeNewlines(expected))) return true;
            }
        }
        // 经典 Win32 控件（旧版记事本的 Edit、部分 WinForms 框）没有
        // TextPattern/ValuePattern 可读回——WM_GETTEXT 是最后一道可靠的读回。
        // 没有它，写入明明落地却被判「无法验证」，用户以为失败。
        return VerifyNativeWindowText(element, expected);
    }

    private static bool VerifyNativeWindowText(AutomationElement element, string expected)
    {
        try
        {
            IntPtr handle = new IntPtr(element.Current.NativeWindowHandle);
            if (handle == IntPtr.Zero)
            {
                IntPtr focused = GetFocus();
                handle = focused;
            }
            if (handle == IntPtr.Zero) return false;
            int length = SendMessageWindowTextLength(handle, 0x000E /*WM_GETTEXTLENGTH*/, IntPtr.Zero, IntPtr.Zero).ToInt32();
            if (length <= 0) return false;
            var builder = new System.Text.StringBuilder(length + 16);
            SendMessageWindowText(handle, 0x000D /*WM_GETTEXT*/, new IntPtr(length + 16), builder);
            return NormalizeNewlines(builder.ToString()).Contains(NormalizeNewlines(expected));
        }
        catch { return false; }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern IntPtr SendMessageWindowText(IntPtr hWnd, int msg, IntPtr wParam, System.Text.StringBuilder lParam);

    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern IntPtr SendMessageWindowTextLength(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern IntPtr GetFocus();

    private static WriterResult Write(Dictionary<string, object> data)
    {
        WriterResult result = new WriterResult();
        result.submit_sent = false;
        string text = Text(data, "text");
        string artifact = Text(data, "prompt_artifact");
        string processName = Text(data, "target_process_name");
        string expectedTitle = Text(data, "target_title");
        string coordinateSpace = Text(data, "target_point_space");
        long hwndValue = LongInteger(data, "target_hwnd", 0);
        int expectedProcessId = Integer(data, "target_process_id", 0);
        int[] point = Point(data);
        result.target_hwnd = hwndValue;
        result.source_chars = text.Length;
        if (Boolean(data, "submit", true)) { result.error = "submit must be false"; return result; }
        if (String.IsNullOrWhiteSpace(text)) { result.error = "text is empty"; return result; }
        if (coordinateSpace != "physical_screen_pixels") { result.error = "target coordinate space is not physical screen pixels"; return result; }
        if (point == null) { result.error = "target point is missing"; return result; }
        NativePoint nativePoint = new NativePoint { X = point[0], Y = point[1] };
        DeliveryTarget target = ResolveDeliveryTarget(
            data,
            new IntPtr(hwndValue),
            expectedProcessId,
            expectedTitle,
            processName,
            nativePoint);
        if (target == null)
        {
            result.error = "no trusted editable input surface could be resolved";
            return result;
        }
        IntPtr hwnd = target.hwnd;
        AutomationElement editable = target.editable;
        bool hasValuePattern = target.hasValuePattern;
        processName = String.IsNullOrWhiteSpace(target.processName) ? WindowProcessName(hwnd) : target.processName;
        result.target_hwnd = hwnd.ToInt64();
        result.target_title = WindowText(hwnd);
        result.target_resolution = target.resolution;
        result.resolved_from_trusted_native_evidence = Text(data, "target_resolution") == "adaptive";
        ShowWindow(hwnd, SW_RESTORE);
        IntPtr foreground = GetForegroundWindow();
        if (foreground != hwnd)
        {
            uint targetThread;
            GetWindowThreadProcessId(hwnd, out targetThread);
            uint foregroundThread = 0;
            if (foreground != IntPtr.Zero) GetWindowThreadProcessId(foreground, out foregroundThread);
            bool attached = foregroundThread != 0
                && foregroundThread != targetThread
                && AttachThreadInput(foregroundThread, targetThread, true);
            try
            {
                SetForegroundWindow(hwnd);
                Thread.Sleep(60);
            }
            finally
            {
                if (attached) AttachThreadInput(foregroundThread, targetThread, false);
            }
        }
        if (GetForegroundWindow() != hwnd)
        {
            result.error = "target window could not be restored to foreground";
            return result;
        }
        if (!editable.Current.IsEnabled) { result.error = "the pointed input surface is disabled"; return result; }
        if (IsPassword(editable)) { result.error = "password inputs are never eligible for draft delivery"; return result; }
        editable.SetFocus();
        Thread.Sleep(60);

        if (hasValuePattern)
        {
            ValuePattern pattern = (ValuePattern)editable.GetCurrentPattern(ValuePattern.Pattern);
            string before = NormalizeNewlines(pattern.Current.Value);
            string expected = NormalizeNewlines(text);
            if (!String.IsNullOrWhiteSpace(before) && before != expected)
            {
                result.error = "target input already contains a different draft; clear it before delivery";
                return result;
            }
            if (before != expected) pattern.SetValue(text);
            Thread.Sleep(80);
            string after = NormalizeNewlines(((ValuePattern)editable.GetCurrentPattern(ValuePattern.Pattern)).Current.Value);
            result.written_chars = text.Length;
            result.method = "uia:value-pattern";
            result.delivery_mode = "full_prompt";
            result.verified = after == expected;
            result.ok = result.verified;
            if (!result.ok) result.error = "UI Automation value verification failed";
            return result;
        }

        string className = WindowClass(hwnd);
        bool terminal = IsTerminal(className, processName, result.target_title);
        string inserted = text;
        if (terminal)
        {
            if (String.IsNullOrWhiteSpace(artifact))
            {
                result.error = "terminal delivery requires a local prompt artifact";
                return result;
            }
            inserted = "请读取并执行本地上下文任务文件：\"" + artifact + "\"。完整要求与证据均在该文件中；执行后逐项报告。";
            inserted = inserted.Replace("\r", " ").Replace("\n", " ");
            result.delivery_mode = "artifact_reference";
        }
        else
        {
            result.delivery_mode = "full_prompt";
        }

        IDataObject previousClipboard = null;
        bool hadClipboard = false;
        try
        {
            previousClipboard = Clipboard.GetDataObject();
            hadClipboard = previousClipboard != null;
        }
        catch { }
        try
        {
            Clipboard.SetText(inserted);
            editable.SetFocus();
            SendKeys.SendWait("^v");
            Thread.Sleep(180);
            result.written_chars = inserted.Length;
            result.method = terminal ? "keyboard:terminal-artifact-reference" : "keyboard:verified-paste";
            result.verified = VerifyTextPattern(editable, inserted);
            result.ok = result.verified;
            if (!result.ok) result.error = "keyboard paste could not be verified from the editable element";
            return result;
        }
        finally
        {
            try
            {
                if (hadClipboard) Clipboard.SetDataObject(previousClipboard, true);
                else Clipboard.Clear();
            }
            catch { }
        }
    }

    [STAThread]
    public static int Main()
    {
        WriterResult result;
        try
        {
            // stdin 是管道时 Console.In 用控制台默认编码（本机 GBK）：
            // UTF-8 的中文被按 GBK 解码，字符数膨胀（24→26），字数校验必挂。
            try { Console.InputEncoding = System.Text.Encoding.UTF8; } catch { }
            string raw = Console.In.ReadToEnd();
            Dictionary<string, object> data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(raw);
            result = data == null ? new WriterResult { error = "invalid JSON payload" } : Write(data);
        }
        catch (Exception ex)
        {
            result = new WriterResult { error = ex.GetType().Name + ": " + ex.Message, submit_sent = false };
        }
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.WriteLine(new JavaScriptSerializer().Serialize(result));
        return result.ok ? 0 : 1;
    }
}
