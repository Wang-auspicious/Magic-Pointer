using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Text;

internal static class UiaSelectionProbe
{
    private const int MaxTextChars = 65536;

    private sealed class SelectionResult
    {
        public bool Ok;
        public string Text = "";
        public bool Truncated;
        public string ElementName = "";
        public string AutomationId = "";
        public string ControlType = "";
        public int ProcessId;
        public int RootHwnd;
        public int RangeCount;
        public readonly List<Rect> Rectangles = new List<Rect>();
        public string Error = "";
    }

    public static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Stopwatch stopwatch = Stopwatch.StartNew();
        SelectionResult result = new SelectionResult();
        long hwndValue = 0;

        if (args.Length < 1 || !long.TryParse(args[0], out hwndValue) || hwndValue == 0)
        {
            result.Error = "A valid target window handle is required.";
            WriteResult(result, hwndValue, stopwatch.ElapsedMilliseconds);
            return 2;
        }

        try
        {
            AutomationElement root = AutomationElement.FromHandle(new IntPtr(hwndValue));
            if (root == null)
            {
                result.Error = "UI Automation could not resolve the target window.";
            }
            else
            {
                result.ProcessId = SafeProcessId(root);
                result.RootHwnd = SafeInt(root, AutomationElement.NativeWindowHandleProperty);
                AutomationElement focused = null;
                try
                {
                    focused = AutomationElement.FocusedElement;
                }
                catch
                {
                }

                if (
                    focused != null
                    && SafeProcessId(focused) == result.ProcessId
                    && IsDescendantOrSelf(focused, root))
                {
                    TryElementAndAncestors(focused, root, result);
                }

                if (!result.Ok)
                {
                    TryElement(root, result);
                }

                if (!result.Ok)
                {
                    FindDocumentSelection(root, result);
                }

                if (!result.Ok && string.IsNullOrEmpty(result.Error))
                {
                    result.Error = "No non-empty UI Automation text selection was exposed.";
                }
            }
        }
        catch (Exception ex)
        {
            result.Error = ex.GetType().Name + ": " + ex.Message;
        }

        stopwatch.Stop();
        WriteResult(result, hwndValue, stopwatch.ElapsedMilliseconds);
        return result.Ok ? 0 : 1;
    }

    private static void TryElementAndAncestors(
        AutomationElement element,
        AutomationElement root,
        SelectionResult result)
    {
        AutomationElement current = element;
        TreeWalker walker = TreeWalker.ControlViewWalker;

        for (int depth = 0; current != null && depth < 24 && !result.Ok; depth++)
        {
            TryElement(current, result);
            if (result.Ok || SameElement(current, root))
            {
                break;
            }

            try
            {
                current = walker.GetParent(current);
            }
            catch
            {
                break;
            }
        }
    }

    private static void FindDocumentSelection(AutomationElement root, SelectionResult result)
    {
        try
        {
            Condition condition = new PropertyCondition(
                AutomationElement.ControlTypeProperty,
                ControlType.Document);
            AutomationElementCollection documents = root.FindAll(TreeScope.Descendants, condition);
            int limit = Math.Min(documents.Count, 12);
            for (int index = 0; index < limit && !result.Ok; index++)
            {
                TryElement(documents[index], result);
            }
        }
        catch (Exception ex)
        {
            result.Error = "Document scan failed: " + ex.GetType().Name + ": " + ex.Message;
        }
    }

    private static void TryElement(AutomationElement element, SelectionResult result)
    {
        object patternObject;
        try
        {
            if (!element.TryGetCurrentPattern(TextPattern.Pattern, out patternObject))
            {
                return;
            }
        }
        catch
        {
            return;
        }

        TextPattern pattern = patternObject as TextPattern;
        if (pattern == null)
        {
            return;
        }

        TextPatternRange[] ranges;
        try
        {
            ranges = pattern.GetSelection();
        }
        catch
        {
            return;
        }

        StringBuilder text = new StringBuilder();
        List<Rect> rectangles = new List<Rect>();
        int nonEmptyRanges = 0;
        bool truncated = false;

        foreach (TextPatternRange range in ranges)
        {
            string rangeText;
            try
            {
                rangeText = range.GetText(-1) ?? "";
            }
            catch
            {
                continue;
            }

            if (string.IsNullOrWhiteSpace(rangeText))
            {
                continue;
            }

            if (text.Length > 0)
            {
                text.Append("\n");
            }

            int remaining = MaxTextChars - text.Length;
            if (remaining <= 0)
            {
                truncated = true;
                break;
            }

            if (rangeText.Length > remaining)
            {
                text.Append(rangeText.Substring(0, remaining));
                truncated = true;
            }
            else
            {
                text.Append(rangeText);
            }

            nonEmptyRanges++;
            try
            {
                Rect[] rangeRectangles = range.GetBoundingRectangles();
                if (rangeRectangles != null)
                {
                    int rectangleLimit = Math.Min(rangeRectangles.Length, 32 - rectangles.Count);
                    for (int index = 0; index < rectangleLimit; index++)
                    {
                        Rect rectangle = rangeRectangles[index];
                        if (!rectangle.IsEmpty && rectangle.Width > 0 && rectangle.Height > 0)
                        {
                            rectangles.Add(rectangle);
                        }
                    }
                }
            }
            catch
            {
            }

            if (truncated)
            {
                break;
            }
        }

        if (text.Length == 0)
        {
            return;
        }

        result.Ok = true;
        result.Text = text.ToString();
        result.Truncated = truncated;
        result.ElementName = SafeString(element, AutomationElement.NameProperty);
        result.AutomationId = SafeString(element, AutomationElement.AutomationIdProperty);
        result.ControlType = SafeControlType(element);
        result.ProcessId = SafeProcessId(element);
        result.RangeCount = nonEmptyRanges;
        result.Rectangles.AddRange(rectangles);
        result.Error = "";
    }

    private static int SafeProcessId(AutomationElement element)
    {
        try
        {
            return element.Current.ProcessId;
        }
        catch
        {
            return 0;
        }
    }

    private static int SafeInt(AutomationElement element, AutomationProperty property)
    {
        try
        {
            object value = element.GetCurrentPropertyValue(property, true);
            return value == null || value == AutomationElement.NotSupported
                ? 0
                : Convert.ToInt32(value);
        }
        catch
        {
            return 0;
        }
    }

    private static string SafeString(AutomationElement element, AutomationProperty property)
    {
        try
        {
            object value = element.GetCurrentPropertyValue(property, true);
            return value == null || value == AutomationElement.NotSupported
                ? ""
                : Convert.ToString(value) ?? "";
        }
        catch
        {
            return "";
        }
    }

    private static string SafeControlType(AutomationElement element)
    {
        try
        {
            ControlType controlType = element.Current.ControlType;
            return controlType == null ? "" : controlType.ProgrammaticName;
        }
        catch
        {
            return "";
        }
    }

    private static bool SameElement(AutomationElement left, AutomationElement right)
    {
        try
        {
            return Automation.Compare(left, right);
        }
        catch
        {
            return false;
        }
    }

    private static bool IsDescendantOrSelf(AutomationElement element, AutomationElement root)
    {
        AutomationElement current = element;
        TreeWalker walker = TreeWalker.RawViewWalker;
        for (int depth = 0; current != null && depth < 128; depth++)
        {
            if (SameElement(current, root))
            {
                return true;
            }
            try
            {
                current = walker.GetParent(current);
            }
            catch
            {
                return false;
            }
        }
        return false;
    }

    private static string JsonString(string value)
    {
        if (value == null)
        {
            return "null";
        }

        StringBuilder builder = new StringBuilder(value.Length + 2);
        builder.Append('"');
        foreach (char character in value)
        {
            switch (character)
            {
                case '"':
                    builder.Append("\\\"");
                    break;
                case '\\':
                    builder.Append("\\\\");
                    break;
                case '\b':
                    builder.Append("\\b");
                    break;
                case '\f':
                    builder.Append("\\f");
                    break;
                case '\n':
                    builder.Append("\\n");
                    break;
                case '\r':
                    builder.Append("\\r");
                    break;
                case '\t':
                    builder.Append("\\t");
                    break;
                default:
                    if (character < 0x20)
                    {
                        builder.Append("\\u");
                        builder.Append(((int)character).ToString("x4"));
                    }
                    else
                    {
                        builder.Append(character);
                    }
                    break;
            }
        }
        builder.Append('"');
        return builder.ToString();
    }

    private static void WriteResult(SelectionResult result, long hwnd, long elapsedMilliseconds)
    {
        StringBuilder json = new StringBuilder();
        json.Append("{\"ok\":");
        json.Append(result.Ok ? "true" : "false");
        json.Append(",\"hwnd\":");
        json.Append(hwnd);
        json.Append(",\"process_id\":");
        json.Append(result.ProcessId);
        json.Append(",\"root_hwnd\":");
        json.Append(result.RootHwnd);
        json.Append(",\"text\":");
        json.Append(JsonString(result.Text));
        json.Append(",\"truncated\":");
        json.Append(result.Truncated ? "true" : "false");
        json.Append(",\"range_count\":");
        json.Append(result.RangeCount);
        json.Append(",\"element_name\":");
        json.Append(JsonString(result.ElementName));
        json.Append(",\"automation_id\":");
        json.Append(JsonString(result.AutomationId));
        json.Append(",\"control_type\":");
        json.Append(JsonString(result.ControlType));
        json.Append(",\"rectangles\":[");
        for (int index = 0; index < result.Rectangles.Count; index++)
        {
            if (index > 0)
            {
                json.Append(',');
            }
            Rect rectangle = result.Rectangles[index];
            json.Append('[');
            json.Append(rectangle.Left.ToString("R", System.Globalization.CultureInfo.InvariantCulture));
            json.Append(',');
            json.Append(rectangle.Top.ToString("R", System.Globalization.CultureInfo.InvariantCulture));
            json.Append(',');
            json.Append(rectangle.Width.ToString("R", System.Globalization.CultureInfo.InvariantCulture));
            json.Append(',');
            json.Append(rectangle.Height.ToString("R", System.Globalization.CultureInfo.InvariantCulture));
            json.Append(']');
        }
        json.Append("],\"elapsed_ms\":");
        json.Append(elapsedMilliseconds);
        json.Append(",\"error\":");
        json.Append(JsonString(result.Error));
        json.Append('}');
        Console.WriteLine(json.ToString());
    }
}
