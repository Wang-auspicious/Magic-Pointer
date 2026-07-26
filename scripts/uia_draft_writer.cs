using System;
using System.Collections.Generic;
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

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

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
        public string error = null;
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
        object[] items = value as object[];
        if (items == null || items.Length != 2) return null;
        int x;
        int y;
        if (!Int32.TryParse(Convert.ToString(items[0]), out x)) return null;
        if (!Int32.TryParse(Convert.ToString(items[1]), out y)) return null;
        return new int[] { x, y };
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
        if (!element.TryGetCurrentPattern(TextPattern.Pattern, out textPattern)) return false;
        TextPattern pattern = textPattern as TextPattern;
        if (pattern == null) return false;
        string actual = NormalizeNewlines(pattern.DocumentRange.GetText(-1));
        return actual.Contains(NormalizeNewlines(expected));
    }

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
        if (hwndValue <= 0 || point == null) { result.error = "target identity is incomplete"; return result; }
        if (coordinateSpace != "physical_screen_pixels") { result.error = "target coordinate space is not physical screen pixels"; return result; }
        if (String.IsNullOrWhiteSpace(expectedTitle)) { result.error = "target title is missing"; return result; }
        IntPtr hwnd = new IntPtr(hwndValue);
        if (!IsWindow(hwnd)) { result.error = "target window no longer exists"; return result; }
        uint actualProcessId;
        GetWindowThreadProcessId(hwnd, out actualProcessId);
        if (expectedProcessId > 0 && actualProcessId != (uint)expectedProcessId)
        {
            result.error = "target process changed before draft delivery";
            return result;
        }
        string actualTitle = WindowText(hwnd);
        if (!String.Equals(actualTitle, expectedTitle, StringComparison.Ordinal))
        {
            result.error = "target window title changed before draft delivery";
            return result;
        }
        NativePoint nativePoint = new NativePoint { X = point[0], Y = point[1] };
        IntPtr pointedWindow = WindowFromPoint(nativePoint);
        if (pointedWindow == IntPtr.Zero || GetAncestor(pointedWindow, GA_ROOT) != hwnd)
        {
            result.error = "user-pointed input no longer belongs to the target window";
            return result;
        }
        result.target_title = actualTitle;
        ShowWindow(hwnd, SW_RESTORE);
        SetForegroundWindow(hwnd);
        Thread.Sleep(100);
        if (GetForegroundWindow() != hwnd)
        {
            result.error = "target window could not be restored to foreground";
            return result;
        }

        bool hasValuePattern;
        AutomationElement editable = EditableAtPoint(point[0], point[1], out hasValuePattern);
        if (editable == null) { result.error = "the pointed element is not an editable input surface"; return result; }
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
