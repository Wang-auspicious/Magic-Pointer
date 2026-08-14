using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Text;

internal static class UiaSelectionProbe
{
    private const int MaxTextChars = 65536;
    // Measured 2026-08-03 against live windows with the cap lifted to 3000ms:
    // RunProbeCore needs 199-975ms depending on the target. Most of it is the
    // FindDocumentSelection phase waiting on the app's automation provider
    // (115-227ms of a ~300ms probe; see the comment there for what that cost is
    // and is not). At the old 200ms cap every window tested came back as
    // "uia_probe_timeout_200ms", which reports a *read failure* for what is
    // really "nothing is selected here" - and a read failure sends the caller
    // down the OCR fallback instead of staying silent.
    //
    // 1200ms clears the slowest measured window with headroom. It is a ceiling
    // for pathological trees, not a latency budget: a window with a selection
    // answers far sooner, and the Python caller applies its own shorter timeout.
    private const int UiaProbeHardTimeoutMs = 1200;
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
        // FindDocumentSelection 数出来的 Document 节点个数。-1 = 那一趟没跑
        // （提前读到选区了，按定义就不是冷树）。Python 侧的 is_cold_tree 靠它
        // 区分「壳起来了但正文没挂上」和「这窗口本来就没有正文」——
        // 之前这个数只 TracePhase 到 stderr，判据拿不到，冷树重试从没触发过。
        public int DocumentCount = -1;
        public string Error = "";
    }

    private sealed class RegionElement
    {
        public string Text = "";
        public string ControlType = "";
        public string AutomationId = "";
        public Rect Rectangle = Rect.Empty;
    }

#if !RESIDENT_HOST
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
                result.Error = "uia_probe_timeout_" + UiaProbeHardTimeoutMs + "ms";
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
#endif

    private static readonly bool TraceEnabled =
        !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAGIC_POINTER_UIA_PROBE_TRACE"));
    private static Stopwatch TraceClock;
    private static long TraceLastMs;

    /// <summary>
    /// Emits per-phase timings to stderr when MAGIC_POINTER_UIA_PROBE_TRACE is set.
    ///
    /// stderr, never stdout: callers parse the last stdout line as the result JSON,
    /// so anything written there would corrupt the contract. Off by default and a
    /// single bool check when off, because this runs on every probe.
    /// </summary>
    private static void TracePhase(string phase)
    {
        if (!TraceEnabled)
        {
            return;
        }
        try
        {
            if (TraceClock == null)
            {
                TraceClock = Stopwatch.StartNew();
                TraceLastMs = 0;
            }
            long now = TraceClock.ElapsedMilliseconds;
            Console.Error.WriteLine(
                "@@uia phase=" + phase
                + " at=" + now.ToString(System.Globalization.CultureInfo.InvariantCulture)
                + " d=" + (now - TraceLastMs).ToString(System.Globalization.CultureInfo.InvariantCulture));
            TraceLastMs = now;
        }
        catch
        {
        }
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
                    if (IsTerminalWindow(root))
                    {
                        TryTerminalBufferAtPoint(root, RegionCenter(targetRegion.Value), result);
                    }
                    if (!result.Ok)
                    {
                        TryRegionElements(root, targetRegion.Value, result);
                    }
                    if (!result.Ok)
                    {
                        TryDocumentTextFallback(root, result);
                    }
                }
                else
                {
                    if (targetPoint.HasValue && IsTerminalWindow(root))
                    {
                        TryTerminalBufferAtPoint(root, targetPoint.Value, result);
                    }
                    TracePhase("terminal_buffer");
                    AutomationElement focused = null;
                    try
                    {
                        focused = AutomationElement.FocusedElement;
                    }
                    catch
                    {
                    }
                    TracePhase("focused_element");

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
                    TracePhase("focused_ancestors");

                    if (!result.Ok)
                    {
                        TryElement(root, result);
                        if (targetPoint.HasValue)
                        {
                            RejectSelectionOutsideTargetPoint(result, targetPoint.Value);
                        }
                    }
                    TracePhase("root_element");

                    if (!result.Ok)
                    {
                        FindDocumentSelection(root, result);
                        if (targetPoint.HasValue)
                        {
                            RejectSelectionOutsideTargetPoint(result, targetPoint.Value);
                        }
                    }
                    TracePhase("document_scan");

                    if (!result.Ok && targetPoint.HasValue)
                    {
                        TryPointElement(root, targetPoint.Value, result);
                    }
                    TracePhase("point_element");

                    // Editors without an active text selection (Notepad,
                    // WordPad, RichEdit Documents) expose the whole document
                    // through TextPattern. A stroke over unselected text must
                    // still yield the file content instead of an empty
                    // structured layer that silently degrades to pixels.
                    if (!result.Ok)
                    {
                        TryDocumentTextFallback(root, result);
                    }
                    TracePhase("document_text_fallback");
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

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern bool IsChild(IntPtr parentHwnd, IntPtr childHwnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);

    // DPI awareness decides which coordinate space UI Automation answers in.
    // A DPI-unaware probe gets Windows' virtualized (logical) rectangles, while
    // the caller hands it physical screen pixels — on a 200% display that is a
    // 2x mismatch, every point lands outside every element, and the whole
    // structured read reports "unavailable". That is what sent the acceptance
    // run down the full-screen OCR fallback on every window.
    //
    // The old code called SetProcessDpiAwareness and returned unconditionally,
    // so a failed call silently left the process unaware. Each step is now
    // checked, newest API first.
    private static readonly IntPtr DpiAwarenessContextPerMonitorAwareV2 = new IntPtr(-4);

    private static string dpiAwarenessMode = "none";

    private static void EnableDpiAwareness()
    {
        try
        {
            if (SetProcessDpiAwarenessContext(DpiAwarenessContextPerMonitorAwareV2))
            {
                dpiAwarenessMode = "per_monitor_v2";
                return;
            }
        }
        catch
        {
        }
        try
        {
            // S_OK (0) or E_ACCESSDENIED (already set by an earlier call/manifest)
            // both mean the process ends up aware; anything else does not.
            int hr = SetProcessDpiAwareness(2);
            if (hr == 0 || (uint)hr == 0x80070005u)
            {
                dpiAwarenessMode = "per_monitor";
                return;
            }
        }
        catch
        {
        }
        try
        {
            if (SetProcessDPIAware())
            {
                dpiAwarenessMode = "system";
            }
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
        // FindAll stays, despite being O(full tree) in principle.
        //
        // This scan is the most expensive phase of a probe that finds nothing:
        // 115-227ms of a ~300ms probe, against 50-78ms for everything before it.
        // The obvious fix -- a depth- and node-bounded TreeWalker like the one in
        // TryRegionElements -- was built and measured. It lost.
        //
        // A/B with the variant alternating on every run (6 runs each, medians, so
        // machine load hit both equally; absolute numbers drift by 200ms between
        // sessions and cannot be compared across time):
        //
        //     window         FindAll    TreeWalker
        //     cc-switch        329ms       372ms
        //     clash-verge      318ms       316ms
        //     msedge           291ms       302ms
        //
        // The walk visited only 24-94 nodes to be that slow, which is ~8ms per
        // node. The cost here is round trips, not tree size: FindAll is a single
        // cross-process call the provider resolves internally, while
        // GetFirstChild/GetNextSibling per node is dozens of calls, and against a
        // Tauri or CEF provider each is slow enough to swamp the savings. The
        // remaining ~200ms is that provider's response time, not our algorithm.
        //
        // If you want this faster, the lever is calling it less often, not walking
        // differently. Set MAGIC_POINTER_UIA_PROBE_TRACE=1 for the phase split
        // before changing anything, and A/B interleaved -- measuring before and
        // after in sequence will tell you whatever the machine was doing instead.
        try
        {
            Condition condition = new PropertyCondition(
                AutomationElement.ControlTypeProperty,
                ControlType.Document);
            AutomationElementCollection documents = root.FindAll(TreeScope.Descendants, condition);
            result.DocumentCount = documents.Count;
            TracePhase(
                "document_scan.findall["
                + documents.Count.ToString(System.Globalization.CultureInfo.InvariantCulture)
                + "]");
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
            string documentText = "";
            bool documentRead = false;
            try
            {
                documentText = pattern.DocumentRange.GetText(MaxTextChars) ?? "";
                documentRead = true;
            }
            catch
            {
                // Windows Terminal 对超大 maxLength 的 DocumentRange.GetText
                // 可能直接抛异常；视同空结果，走逐行窗口读取。
            }
            if (!documentRead || string.IsNullOrWhiteSpace(documentText))
            {
                // Windows Terminal 的 DocumentRange 常返回整段空白（缓冲区
                // 开头是空行）。走 RangeFromPoint 的逐行窗口读取：这是实测
                // 可用的终端路径（STATUS 记录过 RangeFromPoint 已验证）。
                documentText = ReadLineWindowAroundPoint(pattern, point);
                if (string.IsNullOrWhiteSpace(documentText))
                {
                    return false;
                }
            }
            string anchorText = "";
            List<Rect> anchorRectangles = new List<Rect>();
            try
            {
                // 与行窗口读取一致：手势可能落在空白列，偏移重试直到拿到
                // 非空锚点行。
                for (int attempt = 0; attempt < 6 && anchorText.Length == 0; attempt++)
                {
                    Point probePoint = new Point(
                        point.X + attempt * 80,
                        point.Y + attempt * 40);
                    TextPatternRange anchor = pattern.RangeFromPoint(probePoint);
                    if (anchor == null)
                    {
                        continue;
                    }
                    anchor.ExpandToEnclosingUnit(TextUnit.Line);
                    anchorText = (anchor.GetText(2048) ?? "").Trim();
                    if (anchorText.Length == 0)
                    {
                        continue;
                    }
                    Rect[] lineRectangles = anchor.GetBoundingRectangles();
                    if (lineRectangles != null)
                    {
                        for (int index = 0; index < lineRectangles.Length && anchorRectangles.Count < 32; index++)
                        {
                            Rect lineRectangle = lineRectangles[index];
                            if (!lineRectangle.IsEmpty && lineRectangle.Width > 0 && lineRectangle.Height > 0)
                            {
                                anchorRectangles.Add(lineRectangle);
                            }
                        }
                    }
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
            if (anchorRectangles.Count > 0)
            {
                result.Rectangles.AddRange(anchorRectangles);
                result.RectangleCountTotal = anchorRectangles.Count;
            }
            else if (!rectangle.IsEmpty)
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

    private static string ReadLineWindowAroundPoint(TextPattern pattern, Point point)
    {
        // 以点所在行为中心，向前 60 行、向后 140 行，逐行收集文本窗口。
        // 空行保留为换行占位，保持输出缓冲区的相对结构。总量封顶
        // MaxTextChars，防止 200 行 x 1024 字失控。
        // 手势可能落在窗口边框/空白列上（RangeFromPoint 退化），向右下
        // 偏移重试几次，直到拿到有内容的行窗口。
        for (int attempt = 0; attempt < 6; attempt++)
        {
            Point probePoint = new Point(
                point.X + attempt * 80,
                point.Y + attempt * 40);
            string window = ReadLineWindowAt(pattern, probePoint);
            if (!string.IsNullOrWhiteSpace(window))
            {
                return window;
            }
        }
        return "";
    }

    private static string ReadLineWindowAt(TextPattern pattern, Point point)
    {
        StringBuilder lines = new StringBuilder();
        try
        {
            TextPatternRange cursor = pattern.RangeFromPoint(point);
            if (cursor == null)
            {
                return "";
            }
            cursor.ExpandToEnclosingUnit(TextUnit.Line);
            int moved = cursor.Move(TextUnit.Line, -60);
            for (int index = 0; index < 200 && lines.Length < MaxTextChars; index++)
            {
                string lineText = cursor.GetText(1024) ?? "";
                lines.Append(lineText);
                lines.Append('\n');
                int movedNext = cursor.Move(TextUnit.Line, 1);
                if (movedNext == 0 && index >= Math.Max(0, 60 + moved))
                {
                    break;
                }
            }
        }
        catch
        {
            return "";
        }
        return lines.ToString();
    }

    private static void TryDocumentTextFallback(
        AutomationElement root,
        SelectionResult result)
    {
        // Whole-document fallback: editors without an active text selection
        // (Notepad / WordPad / RichEdit Documents) expose the entire document
        // through TextPattern. Read it (capped at MaxTextChars) so a stroke
        // over unselected text still yields the file content instead of an
        // empty structured layer. Terminals never reach this path: they are
        // handled by TryTerminalBufferAtPoint before the selection chain.
        try
        {
            AutomationElement document = FindFirstTextPatternElement(root);
            if (document == null)
            {
                return;
            }
            object patternObject;
            if (!document.TryGetCurrentPattern(TextPattern.Pattern, out patternObject))
            {
                return;
            }
            TextPattern pattern = patternObject as TextPattern;
            if (pattern == null)
            {
                return;
            }
            string documentText;
            try
            {
                documentText = pattern.DocumentRange.GetText(MaxTextChars) ?? "";
            }
            catch
            {
                return;
            }
            if (string.IsNullOrWhiteSpace(documentText))
            {
                return;
            }
            result.Ok = true;
            result.ResultKind = "document_text";
            result.Text = documentText;
            result.Truncated = documentText.Length >= MaxTextChars;
            result.ElementName = SafeString(document, AutomationElement.NameProperty);
            result.AutomationId = SafeString(document, AutomationElement.AutomationIdProperty);
            result.ControlType = SafeControlType(document);
            result.LocalizedControlType = SafeString(document, AutomationElement.LocalizedControlTypeProperty);
            result.ClassName = SafeString(document, AutomationElement.ClassNameProperty);
            result.ElementRectangle = SafeBoundingRectangle(document);
            Rect rectangle = SafeBoundingRectangle(document);
            if (!rectangle.IsEmpty)
            {
                result.Rectangles.Add(rectangle);
                result.RectangleCountTotal = 1;
            }
            result.Error = "";
        }
        catch
        {
        }
    }

    private static AutomationElement FindFirstTextPatternElement(AutomationElement root)
    {
        // Prefer the root itself, then one bounded lookup for the first
        // descendant that supports TextPattern (Document/Edit controls sit
        // near the top of editor window trees).
        try
        {
            object patternObject;
            if (root.TryGetCurrentPattern(TextPattern.Pattern, out patternObject))
            {
                return root;
            }
        }
        catch
        {
        }
        try
        {
            PropertyCondition condition = new PropertyCondition(
                AutomationElement.IsTextPatternAvailableProperty,
                true);
            return root.FindFirst(TreeScope.Descendants, condition);
        }
        catch
        {
            return null;
        }
    }

    private static Point RegionCenter(Rect region)
    {
        return new Point(region.Left + (region.Width / 2.0), region.Top + (region.Height / 2.0));
    }    private static bool IsRegionControlType(string controlType)
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
            // RichEdit-based apps such as Windows 11 Notepad expose the whole
            // editor as one Document and no row-level children. Keeping it as
            // a last-resort result lets the caller identify a container after
            // one region probe instead of repeating ElementFromPoint across
            // the stroke. It is removed below whenever tighter elements exist.
            case "ControlType.Document":
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

        bool hasNonDocumentElement = found.Exists(delegate(RegionElement item) {
            return item.ControlType != "ControlType.Document";
        });
        if (hasNonDocumentElement)
        {
            found.RemoveAll(delegate(RegionElement item) {
                return item.ControlType == "ControlType.Document";
            });
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
            element = null;
        }

        // ElementFromPoint asks the desktop what is painted on top at this
        // pixel, and what is on top is us: Magic Pointer's own full-screen
        // transparent overlay. On the 2026-08-04 acceptance machine that made
        // every structured read fail with "outside the target window tree",
        // which pushed every command down the full-screen OCR fallback -- the
        // reason a Notepad selection came back holding the text of a CMD window
        // behind it. The target hwnd is known and trusted, so when the top-most
        // answer is not usable, descend the target's own tree instead. This also
        // covers other apps' overlays, IME candidate windows and tooltips.
        bool insideTree = element != null && BelongsToWindowTree(element, root);
        if (insideTree && TryAcceptPointChain(element, root, point, result))
        {
            return;
        }

        AutomationElement descended = FindDeepestElementAtPoint(root, point);
        if (descended != null && !SameElement(descended, element) && TryAcceptPointChain(descended, root, point, result))
        {
            return;
        }

        if (element == null)
        {
            result.Error = "UI Automation ElementFromPoint returned no element.";
            return;
        }
        if (!insideTree)
        {
            result.Error = "UI Automation point element was outside the target window tree. "
                + DescribeWindowBinding(element, root);
            return;
        }
        result.Error = "UI Automation point element had no bounded meaningful ancestor.";
    }

    // Walk from `start` up to the window root and take the first element that is
    // both meaningful and bounded. Failing that, take the tightest bounded box
    // that is not simply the whole window: geometry alone is worth reporting,
    // because it clips the pixel fallback to the thing the user pointed at
    // instead of letting a full-screen OCR read the window behind it.
    private static bool TryAcceptPointChain(
        AutomationElement start,
        AutomationElement root,
        Point point,
        SelectionResult result)
    {
        AutomationElement current = start;
        TreeWalker walker = TreeWalker.ControlViewWalker;
        AutomationElement boundedFallback = null;
        Rect boundedFallbackRectangle = Rect.Empty;
        string boundedFallbackControlType = "";

        for (int depth = 0; current != null && depth < 16; depth++)
        {
            Rect rectangle = SafeBoundingRectangle(current);
            string name = SafeString(current, AutomationElement.NameProperty);
            string automationId = SafeString(current, AutomationElement.AutomationIdProperty);
            string value = SafeValue(current);
            string helpText = SafeString(current, AutomationElement.HelpTextProperty);
            string controlType = SafeControlType(current);
            bool bounded = (
                !rectangle.IsEmpty
                && rectangle.Width > 0
                && rectangle.Height > 0
                && rectangle.Contains(point)
            );
            bool meaningful = (
                !string.IsNullOrWhiteSpace(name)
                || !string.IsNullOrWhiteSpace(automationId)
                || !string.IsNullOrWhiteSpace(value)
                || !string.IsNullOrWhiteSpace(helpText)
            );
            if (meaningful && bounded && !IsCatchAllPointElement(current, root, rectangle))
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
                return true;
            }
            if (
                boundedFallback == null
                && bounded
                && !SameElement(current, root)
                && !IsCatchAllPointElement(current, root, rectangle)
            )
            {
                boundedFallback = current;
                boundedFallbackRectangle = rectangle;
                boundedFallbackControlType = controlType;
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

        if (boundedFallback == null)
        {
            return false;
        }

        result.Ok = true;
        result.ResultKind = "point_region";
        result.ElementName = "";
        result.AutomationId = SafeString(boundedFallback, AutomationElement.AutomationIdProperty);
        result.ControlType = boundedFallbackControlType;
        result.LocalizedControlType = SafeString(
            boundedFallback,
            AutomationElement.LocalizedControlTypeProperty);
        result.ClassName = SafeString(boundedFallback, AutomationElement.ClassNameProperty);
        result.ElementRectangle = boundedFallbackRectangle;
        result.Rectangles.Add(boundedFallbackRectangle);
        result.RectangleCountTotal = 1;
        result.Text = "";
        result.Error = "";
        return true;
    }

    // Walk the target window's own tree down to the smallest element that still
    // contains the point. Bounded in both depth and breadth: a deep Electron or
    // Chromium tree must not turn a 200ms probe into a walk of ten thousand
    // nodes, so each level scans at most a fixed number of siblings and the
    // whole descent is capped. Returning the best partial match beats returning
    // nothing — the caller only needs a bounded, meaningful element.
    private const int PointDescentMaxDepth = 24;
    private const int PointDescentMaxSiblings = 256;

    private static AutomationElement FindDeepestElementAtPoint(AutomationElement root, Point point)
    {
        if (root == null)
        {
            return null;
        }
        Rect rootRectangle = SafeBoundingRectangle(root);
        if (!rootRectangle.IsEmpty && !rootRectangle.Contains(point))
        {
            return null;
        }

        AutomationElement best = root;
        AutomationElement current = root;
        TreeWalker walker = TreeWalker.ControlViewWalker;

        for (int depth = 0; depth < PointDescentMaxDepth; depth++)
        {
            AutomationElement child;
            try
            {
                child = walker.GetFirstChild(current);
            }
            catch
            {
                break;
            }

            AutomationElement chosen = null;
            double chosenArea = double.MaxValue;
            for (int seen = 0; child != null && seen < PointDescentMaxSiblings; seen++)
            {
                Rect rectangle = SafeBoundingRectangle(child);
                if (
                    !rectangle.IsEmpty
                    && rectangle.Width > 0
                    && rectangle.Height > 0
                    && rectangle.Contains(point)
                )
                {
                    double area = rectangle.Width * rectangle.Height;
                    if (area < chosenArea)
                    {
                        chosen = child;
                        chosenArea = area;
                    }
                }
                try
                {
                    child = walker.GetNextSibling(child);
                }
                catch
                {
                    break;
                }
            }

            if (chosen == null)
            {
                break;
            }
            best = chosen;
            current = chosen;
        }

        return best;
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
        Console.WriteLine(BuildResultJson(result, hwnd, elapsedMilliseconds));
    }

    private static string BuildResultJson(SelectionResult result, long hwnd, long elapsedMilliseconds)
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
        json.Append(",\"dpi_awareness\":");
        json.Append(JsonString(dpiAwarenessMode));
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
        json.Append(",\"document_count\":");
        json.Append(result.DocumentCount);
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
        return json.ToString();
    }

#if RESIDENT_HOST
    // -----------------------------------------------------------------------
    // 常驻 UIA 宿主（Phase C，评审 2026-08-13 优先级第一）：
    // 同一个探针逻辑，但进程只启动一次，通过 named pipe 接请求——
    // 每次读不再付 ~570ms 的进程冷启动 + COM 重建税。空闲时零扫描、
    // 零 UIA 活动：只有管道上来请求才干活（idle/event-driven 契约）。
    //
    // 协议（每行一条请求，UTF-8）：
    //   id|ping                     -> {"id":N,"ok":true,"result_kind":"ping"}
    //   id|hwnd                     -> 探针结果 JSON（多一个 "id" 字段）
    //   id|hwnd|x|y                 -> 以点为目标
    //   id|hwnd|region|x|y|w|h      -> 以区域为目标
    // -----------------------------------------------------------------------
    private static readonly bool ResidenteHostTrace =
        !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAGIC_POINTER_UIA_HOST_TRACE"));

    // 桥接审计 P1：resident 管道是本地隐私边界。单连接只接受少量请求，
    // 单行只接受有限字节——任何本地进程不能借它无限读窗口文本或喂无界内存。
    private const int ResidenteMaxLineChars = 256;
    private const int ResidenteMaxRequestsPerConnection = 8;

    private static PipeSecurity ResidentePipeSecurity()
    {
        var security = new PipeSecurity();
        // 仅当前用户 + SYSTEM 可连：默认 DACL 会放行同用户全部进程，
        // 而这条管道没有任何应用层认证。
        var currentUser = WindowsIdentity.GetCurrent().User;
        var userRule = new PipeAccessRule(
            currentUser,
            PipeAccessRights.ReadWrite,
            AccessControlType.Allow);
        security.AddAccessRule(userRule);
        security.SetOwner(currentUser);
        return security;
    }

    private static void ResidenteHostLog(string message)
    {
        if (!ResidenteHostTrace)
        {
            return;
        }
        try
        {
            Console.Error.WriteLine("@@uiahost " + message);
        }
        catch
        {
        }
    }

    private static void HandleResidenteRequest(string line, TextWriter writer)
    {
        long id = 0;
        string[] parts = line.Split('|');
        if (parts.Length >= 1)
        {
            long.TryParse(parts[0], out id);
        }
        if (parts.Length >= 2 && parts[1] == "ping")
        {
            writer.WriteLine("{\"id\":" + id + ",\"ok\":true,\"result_kind\":\"ping\"}");
            return;
        }
        long hwnd = 0;
        if (parts.Length < 2 || !long.TryParse(parts[1], out hwnd) || hwnd == 0)
        {
            writer.WriteLine("{\"id\":" + id + ",\"ok\":false,\"error\":\"invalid_request\"}");
            return;
        }
        Point? targetPoint = null;
        Rect? targetRegion = null;
        double px, py, pw, ph;
        if (parts.Length >= 8 && parts[2] == "region"
            && double.TryParse(parts[3], NumberStyles.Float, CultureInfo.InvariantCulture, out px)
            && double.TryParse(parts[4], NumberStyles.Float, CultureInfo.InvariantCulture, out py)
            && double.TryParse(parts[5], NumberStyles.Float, CultureInfo.InvariantCulture, out pw)
            && double.TryParse(parts[6], NumberStyles.Float, CultureInfo.InvariantCulture, out ph)
            && pw > 0 && ph > 0)
        {
            targetRegion = new Rect(px, py, pw, ph);
        }
        else if (parts.Length >= 4
            && double.TryParse(parts[2], NumberStyles.Float, CultureInfo.InvariantCulture, out px)
            && double.TryParse(parts[3], NumberStyles.Float, CultureInfo.InvariantCulture, out py))
        {
            targetPoint = new Point(px, py);
        }

        SelectionResult result = new SelectionResult();
        Stopwatch stopwatch = Stopwatch.StartNew();
        try
        {
            Task readTask = Task.Run(() => RunProbeCore(hwnd, targetPoint, targetRegion, result));
            if (!readTask.Wait(UiaProbeHardTimeoutMs))
            {
                result.Error = "uia_probe_timeout_" + UiaProbeHardTimeoutMs + "ms";
            }
        }
        catch (Exception ex)
        {
            result.Error = ex.GetType().Name + ": " + ex.Message;
        }
        stopwatch.Stop();
        string json = BuildResultJson(result, hwnd, stopwatch.ElapsedMilliseconds);
        writer.WriteLine("{\"id\":" + id + "," + json.Substring(1));
    }

    public static int Main(string[] args)
    {
        EnableDpiAwareness();
        Console.OutputEncoding = new UTF8Encoding(false);
        string pipeName = Environment.GetEnvironmentVariable("MAGIC_POINTER_UIA_HOST_PIPE");
        if (string.IsNullOrEmpty(pipeName))
        {
            pipeName = "MagicPointerUIAHost";
        }
        ResidenteHostLog("starting pipe=" + pipeName);
        while (true)
        {
            NamedPipeServerStream server = null;
            try
            {
                // .NET Framework 的 NamedPipeServerStream 断连后不能复用：
                // 每次连接都新建一个（客户端也是每请求一条连接）。
                server = new NamedPipeServerStream(
                    pipeName,
                    PipeDirection.InOut,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous,
                    0,
                    0,
                    ResidentePipeSecurity());
                server.WaitForConnection();
                ResidenteHostLog("client connected");
            }
            catch (Exception ex)
            {
                ResidenteHostLog("wait failed: " + ex.GetType().Name);
                try { if (server != null) server.Close(); } catch { }
                Thread.Sleep(200);
                continue;
            }
            try
            {
                int handled = 0;
                using (var reader = new StreamReader(server, new UTF8Encoding(false)))
                using (var writer = new StreamWriter(server, new UTF8Encoding(false)) { AutoFlush = true })
                {
                    string line;
                    while ((line = ReadBoundedLine(reader)) != null)
                    {
                        if (line.Length == 0)
                        {
                            continue;
                        }
                        handled += 1;
                        if (handled > ResidenteMaxRequestsPerConnection)
                        {
                            writer.WriteLine("{\"ok\":false,\"error\":\"too_many_requests\"}");
                            break;
                        }
                        HandleResidenteRequest(line, writer);
                    }
                }
            }
            catch (Exception ex)
            {
                ResidenteHostLog("session failed: " + ex.GetType().Name);
            }
            try
            {
                server.Disconnect();
                server.Close();
            }
            catch
            {
            }
        }
    }

    // 有界行读：超长行立刻拒绝而不是整行读进内存（内存 DoS 面）。
    private static string ReadBoundedLine(StreamReader reader)
    {
        var buffer = new StringBuilder();
        while (true)
        {
            int next = reader.Read();
            if (next < 0)
            {
                return buffer.Length == 0 ? null : buffer.ToString();
            }
            char ch = (char)next;
            if (ch == '\n')
            {
                return buffer.ToString().TrimEnd('\r');
            }
            buffer.Append(ch);
            if (buffer.Length > ResidenteMaxLineChars)
            {
                // 丢弃超长行的剩余部分直到换行，保持流同步。
                while ((next = reader.Read()) >= 0 && next != '\n')
                {
                }
                return "";
            }
        }
    }
#endif
}
