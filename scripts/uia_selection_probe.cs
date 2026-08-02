using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Text;

internal static class UiaSelectionProbe
{
    private const int MaxTextChars = 65536;
    private const int UiaProbeHardTimeoutMs = 200;
    private const double SelectionPointTolerance = 4.0;

    private sealed class SelectionResult
    {
        public bool Ok;
        public string ResultKind = "";
        public string Text = "";
        public bool Truncated;
        public string ElementName = "";
        public string AutomationId = "";
        public string ControlType = "";
        public string LocalizedControlType = "";
        public string ClassName = "";
        public string ElementValue = "";
        public string HelpText = "";
        public Rect ElementRectangle = Rect.Empty;
        public int ProcessId;
        public int RootHwnd;
        public int RangeCount;
        public int RectangleCountTotal;
        public bool RectanglesTruncated;
        public readonly List<Rect> Rectangles = new List<Rect>();
        public readonly List<RegionElement> RegionElements = new List<RegionElement>();
        public string DocumentLocation = "";
        public int PageNumber;
        public int PageSelectorNumber;
        public int PageAncestorNumber;
        public Rect PageRectangle = Rect.Empty;
        public string SelectionContainerText = "";
        public Rect SelectionContainerRectangle = Rect.Empty;
        public string TerminalAnchorText = "";
        public string RejectedSelectionReason = "";
        public string Error = "";
    }

    private sealed class RegionElement
    {
        public string Text = "";
        public string ControlType = "";
        public string AutomationId = "";
        public Rect Rectangle = Rect.Empty;
    }

    public static int Main(string[] args)
    {
        EnableDpiAwareness();
        Console.OutputEncoding = new UTF8Encoding(false);
        Stopwatch stopwatch = Stopwatch.StartNew();
        SelectionResult result = new SelectionResult();
        long hwndValue = 0;
        Point? targetPoint = null;
        Rect? targetRegion = null;

        if (args.Length < 1 || !long.TryParse(args[0], out hwndValue) || hwndValue == 0)
        {
            result.Error = "A valid target window handle is required.";
            WriteResult(result, hwndValue, stopwatch.ElapsedMilliseconds);
            return 2;
        }

        if (args.Length >= 6 && string.Equals(args[1], "--region", StringComparison.Ordinal))
        {
            double regionX;
            double regionY;
            double regionWidth;
            double regionHeight;
            if (
                double.TryParse(args[2], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out regionX)
                && double.TryParse(args[3], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out regionY)
                && double.TryParse(args[4], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out regionWidth)
                && double.TryParse(args[5], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out regionHeight)
                && regionWidth > 0
                && regionHeight > 0
            )
            {
                targetRegion = new Rect(regionX, regionY, regionWidth, regionHeight);
            }
        }
        else if (args.Length >= 3)
        {
            double pointX;
            double pointY;
            if (
                double.TryParse(args[1], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out pointX)
                && double.TryParse(args[2], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out pointY)
            )
            {
                targetPoint = new Point(pointX, pointY);
            }
        }

        try
        {
            Task readTask = Task.Run(() => RunProbeCore(hwndValue, targetPoint, targetRegion, result));
            if (!readTask.Wait(UiaProbeHardTimeoutMs))
            {
                result.Error = "uia_probe_timeout_200ms";
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

    private static void RunProbeCore(
        long hwndValue,
        Point? targetPoint,
        Rect? targetRegion,
        SelectionResult result)
    {
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
                if (targetRegion.HasValue)
                {
                    TryRegionElements(root, targetRegion.Value, result);
                }
                else
                {
                    if (targetPoint.HasValue && IsTerminalWindow(root))
                    {
                        TryTerminalBufferAtPoint(root, targetPoint.Value, result);
                    }
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
                        && BelongsToWindowTree(focused, root))
                    {
                        TryElementAndAncestors(focused, root, result);
                        if (targetPoint.HasValue)
                        {
                            RejectSelectionOutsideTargetPoint(result, targetPoint.Value);
                        }
                    }

                    if (!result.Ok)
                    {
                        TryElement(root, result);
                        if (targetPoint.HasValue)
                        {
                            RejectSelectionOutsideTargetPoint(result, targetPoint.Value);
                        }
                    }

                    if (!result.Ok)
                    {
                        FindDocumentSelection(root, result);
                        if (targetPoint.HasValue)
                        {
                            RejectSelectionOutsideTargetPoint(result, targetPoint.Value);
                        }
                    }

                    if (!result.Ok && targetPoint.HasValue)
                    {
                        TryPointElement(root, targetPoint.Value, result);
                    }
                }

                if (!result.Ok && string.IsNullOrEmpty(result.Error))
                {
                    result.Error = "No non-empty UI Automation text selection was exposed.";
                }

                if (result.Ok)
                {
                    PopulateSelectionMetadata(root, result);
                }
            }
        }
        catch (Exception ex)
        {
            result.Error = ex.GetType().Name + ": " + ex.Message;
        }
    }

    [DllImport("Shcore.dll")]
    private static extern int SetProcessDpiAwareness(int awareness);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern bool IsChild(IntPtr parentHwnd, IntPtr childHwnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);

    private static void EnableDpiAwareness()
    {
        try
        {
            SetProcessDpiAwareness(2);
            return;
        }
        catch
        {
        }
        try
        {
            SetProcessDPIAware();
        }
        catch
        {
        }
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
        int rectangleCountTotal = 0;
        bool rectanglesTruncated = false;
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
                    for (int index = 0; index < rangeRectangles.Length; index++)
                    {
                        Rect rectangle = rangeRectangles[index];
                        if (!rectangle.IsEmpty && rectangle.Width > 0 && rectangle.Height > 0)
                        {
                            rectangleCountTotal++;
                            if (rectangles.Count < 32)
                            {
                                rectangles.Add(rectangle);
                            }
                            else
                            {
                                rectanglesTruncated = true;
                            }
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
        result.ResultKind = "text_selection";
        result.Text = text.ToString();
        result.Truncated = truncated;
        result.ElementName = SafeString(element, AutomationElement.NameProperty);
        result.AutomationId = SafeString(element, AutomationElement.AutomationIdProperty);
        result.ControlType = SafeControlType(element);
        result.ProcessId = SafeProcessId(element);
        result.RangeCount = nonEmptyRanges;
        result.RectangleCountTotal = rectangleCountTotal;
        result.RectanglesTruncated = rectanglesTruncated;
        result.Rectangles.AddRange(rectangles);
        result.Error = "";
    }

    private static bool SelectionCoversTargetPoint(SelectionResult result, Point point)
    {
        if (!result.Ok || result.ResultKind != "text_selection" || result.Rectangles.Count == 0)
        {
            return false;
        }
        foreach (Rect rectangle in result.Rectangles)
        {
            Rect hitRectangle = new Rect(
                rectangle.X - SelectionPointTolerance,
                rectangle.Y - SelectionPointTolerance,
                rectangle.Width + (SelectionPointTolerance * 2.0),
                rectangle.Height + (SelectionPointTolerance * 2.0));
            if (hitRectangle.Contains(point))
            {
                return true;
            }
        }
        return false;
    }

    private static void RejectSelectionOutsideTargetPoint(SelectionResult result, Point point)
    {
        if (!result.Ok || result.ResultKind != "text_selection" || SelectionCoversTargetPoint(result, point))
        {
            return;
        }
        result.RejectedSelectionReason = "selection_outside_target_point";
        result.Ok = false;
        result.ResultKind = "";
        result.Text = "";
        result.Truncated = false;
        result.RangeCount = 0;
        result.RectangleCountTotal = 0;
        result.RectanglesTruncated = false;
        result.Rectangles.Clear();
        result.ElementName = "";
        result.AutomationId = "";
        result.ControlType = "";
        result.Error = "";
    }

    private static bool IsTerminalWindow(AutomationElement root)
    {
        string className = SafeString(root, AutomationElement.ClassNameProperty);
        if (
            string.Equals(className, "CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.OrdinalIgnoreCase)
            || string.Equals(className, "ConsoleWindowClass", StringComparison.OrdinalIgnoreCase)
        )
        {
            return true;
        }
        string name = SafeString(root, AutomationElement.NameProperty);
        string lowered = name.ToLowerInvariant();
        if (
            lowered.Contains("windows terminal")
            || lowered.Contains("powershell")
            || lowered.Contains("command prompt")
        )
        {
            return true;
        }
        try
        {
            string processName = Process.GetProcessById(SafeProcessId(root)).ProcessName.ToLowerInvariant();
            return processName == "windowsterminal"
                || processName == "openconsole"
                || processName == "conhost"
                || processName == "pwsh"
                || processName == "powershell"
                || processName == "cmd";
        }
        catch
        {
            return false;
        }
    }

    private static void TryTerminalBufferAtPoint(
        AutomationElement root,
        Point point,
        SelectionResult result)
    {
        AutomationElement element = null;
        try
        {
            element = AutomationElement.FromPoint(point);
        }
        catch
        {
            return;
        }
        if (
            element == null
            || SafeProcessId(element) != result.ProcessId
            || !IsDescendantOrSelf(element, root)
        )
        {
            return;
        }

        AutomationElement current = element;
        TreeWalker walker = TreeWalker.ControlViewWalker;
        for (int depth = 0; current != null && depth < 20; depth++)
        {
            if (TryReadTerminalElement(current, point, result))
            {
                return;
            }
            if (SameElement(current, root))
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
        TryTerminalDescendantBuffers(root, point, result);
    }

    private static void TryTerminalDescendantBuffers(
        AutomationElement root,
        Point point,
        SelectionResult result)
    {
        try
        {
            Condition condition = new PropertyCondition(
                AutomationElement.IsTextPatternAvailableProperty,
                true);
            AutomationElementCollection elements = root.FindAll(TreeScope.Descendants, condition);
            int limit = Math.Min(elements.Count, 64);
            for (int pass = 0; pass < 2 && !result.Ok; pass++)
            {
                for (int index = 0; index < limit && !result.Ok; index++)
                {
                    AutomationElement candidate = elements[index];
                    Rect rectangle = SafeBoundingRectangle(candidate);
                    bool containsPoint = !rectangle.IsEmpty && rectangle.Contains(point);
                    if ((pass == 0 && !containsPoint) || (pass == 1 && containsPoint))
                    {
                        continue;
                    }
                    TryReadTerminalElement(candidate, point, result);
                }
            }
        }
        catch
        {
        }
    }

    private static bool TryReadTerminalElement(
        AutomationElement element,
        Point point,
        SelectionResult result)
    {
        try
        {
            object patternObject;
            if (!element.TryGetCurrentPattern(TextPattern.Pattern, out patternObject))
            {
                return false;
            }
            TextPattern pattern = patternObject as TextPattern;
            if (pattern == null)
            {
                return false;
            }
            string documentText = pattern.DocumentRange.GetText(MaxTextChars) ?? "";
            if (string.IsNullOrWhiteSpace(documentText))
            {
                return false;
            }
            string anchorText = "";
            try
            {
                TextPatternRange anchor = pattern.RangeFromPoint(point);
                if (anchor != null)
                {
                    anchor.ExpandToEnclosingUnit(TextUnit.Line);
                    anchorText = (anchor.GetText(2048) ?? "").Trim();
                }
            }
            catch
            {
            }
            Rect rectangle = SafeBoundingRectangle(element);
            result.Ok = true;
            result.ResultKind = "terminal_buffer";
            result.Text = documentText;
            result.Truncated = documentText.Length >= MaxTextChars;
            result.TerminalAnchorText = anchorText;
            result.ElementName = SafeString(element, AutomationElement.NameProperty);
            result.AutomationId = SafeString(element, AutomationElement.AutomationIdProperty);
            result.ControlType = SafeControlType(element);
            result.LocalizedControlType = SafeString(element, AutomationElement.LocalizedControlTypeProperty);
            result.ClassName = SafeString(element, AutomationElement.ClassNameProperty);
            result.ElementRectangle = rectangle;
            if (!rectangle.IsEmpty)
            {
                result.Rectangles.Add(rectangle);
                result.RectangleCountTotal = 1;
            }
            result.Error = "";
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool IsRegionControlType(string controlType)
    {
        switch (controlType)
        {
            case "ControlType.Text":
            case "ControlType.Edit":
            case "ControlType.Button":
            case "ControlType.CheckBox":
            case "ControlType.RadioButton":
            case "ControlType.ComboBox":
            case "ControlType.ListItem":
            case "ControlType.DataItem":
            case "ControlType.HeaderItem":
            case "ControlType.Hyperlink":
            case "ControlType.TabItem":
            case "ControlType.MenuItem":
                return true;
            default:
                return false;
        }
    }

    private static void TryRegionElements(
        AutomationElement root,
        Rect region,
        SelectionResult result)
    {
        // Region enumeration must never walk the whole UIA tree: Excel and
        // other dense apps expose huge virtualized subtrees and FindAll(...,
        // TrueCondition) is O(full tree) even for small visible tables.
        // Use a bounded breadth-first ControlView walk with a CacheRequest so
        // every needed property is bulk-fetched in one cross-process pass.
        List<RegionElement> found = new List<RegionElement>();
        HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
        const int maxVisitedNodes = 1200;
        const int maxOutputElements = 64;
        try
        {
            CacheRequest cacheRequest = new CacheRequest();
            cacheRequest.Add(AutomationElement.BoundingRectangleProperty);
            cacheRequest.Add(AutomationElement.ControlTypeProperty);
            cacheRequest.Add(AutomationElement.NameProperty);
            cacheRequest.Add(AutomationElement.AutomationIdProperty);
            cacheRequest.Add(AutomationElement.HelpTextProperty);
            cacheRequest.TreeFilter = Condition.TrueCondition;
            TreeWalker walker = TreeWalker.ControlViewWalker;
            List<AutomationElement> queue = new List<AutomationElement>();
            bool truncated = false;
            using (cacheRequest.Activate())
            {
                queue.Add(root);
                int visited = 0;
                for (int index = 0; index < queue.Count && visited < maxVisitedNodes && found.Count < maxOutputElements; index++)
                {
                    AutomationElement element = queue[index];
                    visited++;
                    Rect rectangle = SafeBoundingRectangle(element);
                    if (rectangle.IsEmpty || rectangle.Width <= 0 || rectangle.Height <= 0)
                    {
                        // Still expand children; the element itself is not text.
                    }
                    else if (rectangle.IntersectsWith(region))
                    {
                        string controlType = SafeControlType(element);
                        if (IsRegionControlType(controlType))
                        {
                            string name = SafeString(element, AutomationElement.NameProperty).Trim();
                            string value = SafeValue(element).Trim();
                            string helpText = SafeString(element, AutomationElement.HelpTextProperty).Trim();
                            string text = !string.IsNullOrWhiteSpace(value)
                                ? value
                                : !string.IsNullOrWhiteSpace(name)
                                    ? name
                                    : helpText;
                            if (!string.IsNullOrWhiteSpace(text))
                            {
                                if (text.Length > 1000)
                                {
                                    text = text.Substring(0, 1000);
                                }
                                string key = string.Join("|", new string[] {
                                    text,
                                    Math.Round(rectangle.Left).ToString(System.Globalization.CultureInfo.InvariantCulture),
                                    Math.Round(rectangle.Top).ToString(System.Globalization.CultureInfo.InvariantCulture),
                                    Math.Round(rectangle.Width).ToString(System.Globalization.CultureInfo.InvariantCulture),
                                    Math.Round(rectangle.Height).ToString(System.Globalization.CultureInfo.InvariantCulture),
                                });
                                if (seen.Add(key))
                                {
                                    found.Add(new RegionElement {
                                        Text = text,
                                        ControlType = controlType,
                                        AutomationId = SafeString(element, AutomationElement.AutomationIdProperty),
                                        Rectangle = rectangle,
                                    });
                                }
                            }
                        }
                    }

                    if (visited >= maxVisitedNodes)
                    {
                        truncated = true;
                        break;
                    }
                    try
                    {
                        AutomationElement child = walker.GetFirstChild(element);
                        while (child != null && visited < maxVisitedNodes)
                        {
                            queue.Add(child);
                            child = walker.GetNextSibling(child);
                        }
                    }
                    catch (Exception)
                    {
                        // A subtree may be broken or in a different process; skip it.
                    }
                }
                if (visited >= maxVisitedNodes)
                {
                    truncated = true;
                }
            }
            if (truncated)
            {
                result.RectanglesTruncated = true;
                result.Truncated = true;
            }
        }
        catch (Exception ex)
        {
            result.Error = "UI Automation region enumeration failed: " + ex.GetType().Name;
            return;
        }

        found.Sort(delegate(RegionElement left, RegionElement right) {
            int top = left.Rectangle.Top.CompareTo(right.Rectangle.Top);
            if (top != 0)
            {
                return top;
            }
            return left.Rectangle.Left.CompareTo(right.Rectangle.Left);
        });
        int resultLimit = Math.Min(found.Count, maxOutputElements);
        StringBuilder textBuilder = new StringBuilder();
        for (int index = 0; index < resultLimit; index++)
        {
            RegionElement item = found[index];
            if (textBuilder.Length > 0)
            {
                textBuilder.Append('\n');
            }
            textBuilder.Append(item.Text);
            result.RegionElements.Add(item);
            if (result.Rectangles.Count < 32)
            {
                result.Rectangles.Add(item.Rectangle);
            }
            else
            {
                result.RectanglesTruncated = true;
            }
        }
        result.RectangleCountTotal = found.Count;
        result.Truncated = result.Truncated || found.Count > resultLimit;
        if (result.RegionElements.Count == 0)
        {
            result.Error = "No bounded UI Automation elements were found inside the target region.";
            return;
        }
        result.Ok = true;
        result.ResultKind = "region_elements";
        result.Text = textBuilder.ToString();
        result.ElementRectangle = region;
        result.Error = "";
    }

    private static void TryPointElement(
        AutomationElement root,
        Point point,
        SelectionResult result)
    {
        AutomationElement element = null;
        try
        {
            element = AutomationElement.FromPoint(point);
        }
        catch
        {
            result.Error = "UI Automation ElementFromPoint failed.";
            return;
        }
        if (element == null)
        {
            result.Error = "UI Automation ElementFromPoint returned no element.";
            return;
        }
        if (!BelongsToWindowTree(element, root))
        {
            result.Error = "UI Automation point element was outside the target window tree. "
                + DescribeWindowBinding(element, root);
            return;
        }

        AutomationElement current = element;
        TreeWalker walker = TreeWalker.ControlViewWalker;
        for (int depth = 0; current != null && depth < 16; depth++)
        {
            Rect rectangle = SafeBoundingRectangle(current);
            string name = SafeString(current, AutomationElement.NameProperty);
            string automationId = SafeString(current, AutomationElement.AutomationIdProperty);
            string value = SafeValue(current);
            string helpText = SafeString(current, AutomationElement.HelpTextProperty);
            string controlType = SafeControlType(current);
            bool meaningful = (
                !string.IsNullOrWhiteSpace(name)
                || !string.IsNullOrWhiteSpace(automationId)
                || !string.IsNullOrWhiteSpace(value)
                || !string.IsNullOrWhiteSpace(helpText)
            );
            if (
                meaningful
                && !IsCatchAllPointElement(current, root, rectangle)
                && !rectangle.IsEmpty
                && rectangle.Width > 0
                && rectangle.Height > 0
                && rectangle.Contains(point)
            )
            {
                result.Ok = true;
                result.ResultKind = "point_element";
                result.ElementName = name;
                result.AutomationId = automationId;
                result.ControlType = controlType;
                result.LocalizedControlType = SafeString(
                    current,
                    AutomationElement.LocalizedControlTypeProperty);
                result.ClassName = SafeString(
                    current,
                    AutomationElement.ClassNameProperty);
                result.ElementValue = value;
                result.HelpText = helpText;
                result.ElementRectangle = rectangle;
                result.Rectangles.Add(rectangle);
                result.RectangleCountTotal = 1;
                result.Text = !string.IsNullOrWhiteSpace(value)
                    ? value
                    : !string.IsNullOrWhiteSpace(name)
                        ? name
                        : helpText;
                result.Error = "";
                return;
            }
            if (SameElement(current, root))
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
        result.Error = "UI Automation point element had no bounded meaningful ancestor.";
    }

    private static bool IsCatchAllPointElement(
        AutomationElement element,
        AutomationElement root,
        Rect rectangle)
    {
        if (SameElement(element, root))
        {
            return true;
        }
        Rect rootRectangle = SafeBoundingRectangle(root);
        return !rectangle.IsEmpty
            && !rootRectangle.IsEmpty
            && rectangle.Width >= rootRectangle.Width * 0.90
            && rectangle.Height >= rootRectangle.Height * 0.90;
    }

    private static void PopulateSelectionMetadata(AutomationElement root, SelectionResult result)
    {
        TryReadDocumentLocationAndPage(root, result);
        TryFindSelectionContainerAndPage(root, result);
    }

    private static void TryReadDocumentLocationAndPage(
        AutomationElement root,
        SelectionResult result)
    {
        try
        {
            Condition condition = new PropertyCondition(
                AutomationElement.ControlTypeProperty,
                ControlType.Edit);
            AutomationElementCollection edits = root.FindAll(TreeScope.Descendants, condition);
            int limit = Math.Min(edits.Count, 24);
            for (int index = 0; index < limit; index++)
            {
                AutomationElement edit = edits[index];
                string automationId = SafeString(
                    edit,
                    AutomationElement.AutomationIdProperty);
                string value = SafeValue(edit);
                if (
                    string.IsNullOrEmpty(result.DocumentLocation)
                    && value.IndexOf(".pdf", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    result.DocumentLocation = value;
                }
                if (
                    result.PageSelectorNumber <= 0
                    && string.Equals(
                        automationId,
                        "pageselector",
                        StringComparison.OrdinalIgnoreCase))
                {
                    int parsedPage;
                    if (int.TryParse(value, out parsedPage) && parsedPage > 0)
                    {
                        result.PageSelectorNumber = parsedPage;
                    }
                }
            }
            if (result.PageNumber <= 0)
            {
                result.PageNumber = result.PageSelectorNumber;
            }
        }
        catch
        {
        }
    }

    private static void TryFindSelectionContainerAndPage(
        AutomationElement root,
        SelectionResult result)
    {
        Rect selectionBounds = UnionRectangles(result.Rectangles);
        if (selectionBounds.IsEmpty)
        {
            return;
        }

        AutomationElement bestElement = null;
        double bestOverlap = 0;
        double bestArea = double.PositiveInfinity;
        try
        {
            Condition condition = new PropertyCondition(
                AutomationElement.ControlTypeProperty,
                ControlType.Text);
            AutomationElementCollection textElements = root.FindAll(
                TreeScope.Descendants,
                condition);
            int limit = Math.Min(textElements.Count, 2048);
            for (int index = 0; index < limit; index++)
            {
                AutomationElement element = textElements[index];
                Rect rectangle = SafeBoundingRectangle(element);
                double overlap = IntersectionArea(rectangle, selectionBounds);
                if (overlap <= 0)
                {
                    continue;
                }
                double area = rectangle.Width * rectangle.Height;
                if (
                    area <= 0
                    || overlap < bestOverlap
                    || (Math.Abs(overlap - bestOverlap) < 0.5 && area >= bestArea))
                {
                    continue;
                }
                bestElement = element;
                bestOverlap = overlap;
                bestArea = area;
            }
        }
        catch
        {
        }

        if (bestElement != null)
        {
            result.SelectionContainerText = SafeString(
                bestElement,
                AutomationElement.NameProperty);
            result.SelectionContainerRectangle = SafeBoundingRectangle(bestElement);
            TryReadPageFromAncestors(bestElement, selectionBounds, result);
        }
    }

    private static void TryReadPageFromAncestors(
        AutomationElement element,
        Rect selectionBounds,
        SelectionResult result)
    {
        TreeWalker walker = TreeWalker.ControlViewWalker;
        AutomationElement current = element;
        for (int depth = 0; current != null && depth < 24; depth++)
        {
            try
            {
                ControlType controlType = current.Current.ControlType;
                Rect rectangle = SafeBoundingRectangle(current);
                if (
                    controlType == ControlType.Group
                    && ContainsRect(rectangle, selectionBounds, 3))
                {
                    result.PageRectangle = rectangle;
                    int ancestorPage = FirstPositiveInteger(
                        SafeString(current, AutomationElement.NameProperty));
                    if (ancestorPage > 0)
                    {
                        result.PageAncestorNumber = ancestorPage;
                        result.PageNumber = ancestorPage;
                    }
                    else if (result.PageNumber <= 0)
                    {
                        result.PageNumber = result.PageSelectorNumber;
                    }
                    return;
                }
                current = walker.GetParent(current);
            }
            catch
            {
                return;
            }
        }
    }

    private static string SafeValue(AutomationElement element)
    {
        try
        {
            object patternObject;
            if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out patternObject))
            {
                return "";
            }
            ValuePattern pattern = patternObject as ValuePattern;
            return pattern == null ? "" : pattern.Current.Value ?? "";
        }
        catch
        {
            return "";
        }
    }

    private static Rect SafeBoundingRectangle(AutomationElement element)
    {
        try
        {
            Rect rectangle = element.Current.BoundingRectangle;
            return rectangle.IsEmpty || rectangle.Width <= 0 || rectangle.Height <= 0
                ? Rect.Empty
                : rectangle;
        }
        catch
        {
            return Rect.Empty;
        }
    }

    private static Rect UnionRectangles(List<Rect> rectangles)
    {
        Rect union = Rect.Empty;
        foreach (Rect rectangle in rectangles)
        {
            if (rectangle.IsEmpty || rectangle.Width <= 0 || rectangle.Height <= 0)
            {
                continue;
            }
            if (union.IsEmpty)
            {
                union = rectangle;
            }
            else
            {
                union.Union(rectangle);
            }
        }
        return union;
    }

    private static bool ContainsRect(Rect outer, Rect inner, double tolerance)
    {
        if (outer.IsEmpty || inner.IsEmpty)
        {
            return false;
        }
        return (
            outer.Left <= inner.Left + tolerance
            && outer.Top <= inner.Top + tolerance
            && outer.Right >= inner.Right - tolerance
            && outer.Bottom >= inner.Bottom - tolerance
        );
    }

    private static double IntersectionArea(Rect left, Rect right)
    {
        if (left.IsEmpty || right.IsEmpty)
        {
            return 0;
        }
        double width = Math.Max(
            0,
            Math.Min(left.Right, right.Right) - Math.Max(left.Left, right.Left));
        double height = Math.Max(
            0,
            Math.Min(left.Bottom, right.Bottom) - Math.Max(left.Top, right.Top));
        return width * height;
    }

    private static int FirstPositiveInteger(string value)
    {
        int current = 0;
        bool hasDigits = false;
        foreach (char character in value ?? "")
        {
            if (character >= '0' && character <= '9')
            {
                hasDigits = true;
                current = (current * 10) + (character - '0');
            }
            else if (hasDigits)
            {
                return current > 0 ? current : 0;
            }
        }
        return hasDigits && current > 0 ? current : 0;
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

    private static bool BelongsToWindowTree(AutomationElement element, AutomationElement root)
    {
        if (IsDescendantOrSelf(element, root))
        {
            return true;
        }
        IntPtr rootHwnd = new IntPtr(SafeInt(root, AutomationElement.NativeWindowHandleProperty));
        if (rootHwnd == IntPtr.Zero)
        {
            return false;
        }
        AutomationElement current = element;
        TreeWalker walker = TreeWalker.RawViewWalker;
        for (int depth = 0; current != null && depth < 128; depth++)
        {
            IntPtr candidateHwnd = new IntPtr(SafeInt(
                current,
                AutomationElement.NativeWindowHandleProperty));
            if (
                candidateHwnd != IntPtr.Zero
                && (
                    candidateHwnd == rootHwnd
                    || IsChild(rootHwnd, candidateHwnd)
                    || GetAncestor(candidateHwnd, 2) == rootHwnd
                )
            )
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

    private static string DescribeWindowBinding(AutomationElement element, AutomationElement root)
    {
        List<string> chain = new List<string>();
        AutomationElement current = element;
        TreeWalker walker = TreeWalker.RawViewWalker;
        for (int depth = 0; current != null && depth < 24; depth++)
        {
            int hwnd = SafeInt(current, AutomationElement.NativeWindowHandleProperty);
            int processId = SafeInt(current, AutomationElement.ProcessIdProperty);
            if (hwnd != 0 || depth == 0)
            {
                chain.Add(hwnd.ToString() + ":" + processId.ToString());
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
        return "root="
            + SafeInt(root, AutomationElement.NativeWindowHandleProperty).ToString()
            + ":"
            + SafeInt(root, AutomationElement.ProcessIdProperty).ToString()
            + " chain="
            + string.Join(">", chain.ToArray());
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

    private static void AppendJsonRect(StringBuilder json, Rect rectangle)
    {
        if (rectangle.IsEmpty || rectangle.Width <= 0 || rectangle.Height <= 0)
        {
            json.Append("null");
            return;
        }
        json.Append('[');
        json.Append(rectangle.Left.ToString(
            "R",
            System.Globalization.CultureInfo.InvariantCulture));
        json.Append(',');
        json.Append(rectangle.Top.ToString(
            "R",
            System.Globalization.CultureInfo.InvariantCulture));
        json.Append(',');
        json.Append(rectangle.Width.ToString(
            "R",
            System.Globalization.CultureInfo.InvariantCulture));
        json.Append(',');
        json.Append(rectangle.Height.ToString(
            "R",
            System.Globalization.CultureInfo.InvariantCulture));
        json.Append(']');
    }

    private static void WriteResult(SelectionResult result, long hwnd, long elapsedMilliseconds)
    {
        StringBuilder json = new StringBuilder();
        json.Append("{\"ok\":");
        json.Append(result.Ok ? "true" : "false");
        json.Append(",\"result_kind\":");
        json.Append(JsonString(result.ResultKind));
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
        json.Append(",\"rectangle_count_total\":");
        json.Append(result.RectangleCountTotal);
        json.Append(",\"rectangles_truncated\":");
        json.Append(result.RectanglesTruncated ? "true" : "false");
        json.Append(",\"document_location\":");
        json.Append(JsonString(result.DocumentLocation));
        json.Append(",\"page_number\":");
        json.Append(result.PageNumber);
        json.Append(",\"page_selector_number\":");
        json.Append(result.PageSelectorNumber);
        json.Append(",\"page_ancestor_number\":");
        json.Append(result.PageAncestorNumber);
        json.Append(",\"page_rect\":");
        AppendJsonRect(json, result.PageRectangle);
        json.Append(",\"selection_container_text\":");
        json.Append(JsonString(result.SelectionContainerText));
        json.Append(",\"selection_container_rect\":");
        AppendJsonRect(json, result.SelectionContainerRectangle);
        json.Append(",\"terminal_anchor_text\":");
        json.Append(JsonString(result.TerminalAnchorText));
        json.Append(",\"rejected_selection_reason\":");
        json.Append(JsonString(result.RejectedSelectionReason));
        json.Append(",\"element_name\":");
        json.Append(JsonString(result.ElementName));
        json.Append(",\"automation_id\":");
        json.Append(JsonString(result.AutomationId));
        json.Append(",\"control_type\":");
        json.Append(JsonString(result.ControlType));
        json.Append(",\"localized_control_type\":");
        json.Append(JsonString(result.LocalizedControlType));
        json.Append(",\"class_name\":");
        json.Append(JsonString(result.ClassName));
        json.Append(",\"element_value\":");
        json.Append(JsonString(result.ElementValue));
        json.Append(",\"help_text\":");
        json.Append(JsonString(result.HelpText));
        json.Append(",\"element_rect\":");
        AppendJsonRect(json, result.ElementRectangle);
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
        json.Append("],\"region_elements\":[");
        for (int index = 0; index < result.RegionElements.Count; index++)
        {
            if (index > 0)
            {
                json.Append(',');
            }
            RegionElement element = result.RegionElements[index];
            json.Append("{\"text\":");
            json.Append(JsonString(element.Text));
            json.Append(",\"control_type\":");
            json.Append(JsonString(element.ControlType));
            json.Append(",\"automation_id\":");
            json.Append(JsonString(element.AutomationId));
            json.Append(",\"rect\":");
            AppendJsonRect(json, element.Rectangle);
            json.Append('}');
        }
        json.Append("],\"elapsed_ms\":");
        json.Append(elapsedMilliseconds);
        json.Append(",\"error\":");
        json.Append(JsonString(result.Error));
        json.Append('}');
        Console.WriteLine(json.ToString());
    }
}
