// Dump what UI Automation actually exposes for a window. Read-only.
//
// Written 2026-08-04 because the question "can UIA read a WeChat message / a
// browser card / a console line" was being answered by reading our own probe's
// source instead of by looking. Our probe applies a control-type whitelist and a
// node budget before it reports anything, so "the probe found nothing" and "the
// app exposes nothing" are indistinguishable from the outside. This tool applies
// no whitelist: every node, its control type, its name, its value, its rect.
//
//   uia_tree_dump.exe <hwnd> [--region x y w h] [--max-nodes N] [--all]
//
// Without --all only nodes carrying text are printed, which is what you want when
// asking "is the text reachable at all". With --all you get the shape of the tree
// including the silent containers, which is what you want when the answer is no.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Text;

internal static class UiaTreeDump
{
    private static int maxNodes = 4000;
    private static bool includeSilent;
    private static Rect region = Rect.Empty;
    private static Point textAt = new Point(double.NaN, double.NaN);
    private static IntPtr dumpRoot = IntPtr.Zero;

    private static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            Console.Error.WriteLine("usage: uia_tree_dump.exe <hwnd> [--region x y w h] [--max-nodes N] [--all]");
            return 2;
        }
        IntPtr handle;
        try
        {
            handle = new IntPtr(long.Parse(args[0], CultureInfo.InvariantCulture));
        }
        catch (Exception)
        {
            Console.Error.WriteLine("first argument must be an hwnd");
            return 2;
        }
        for (int index = 1; index < args.Length; index++)
        {
            if (args[index] == "--all") includeSilent = true;
            else if (args[index] == "--max-nodes" && index + 1 < args.Length)
            {
                maxNodes = int.Parse(args[++index], CultureInfo.InvariantCulture);
            }
            else if (args[index] == "--region" && index + 4 < args.Length)
            {
                double x = double.Parse(args[++index], CultureInfo.InvariantCulture);
                double y = double.Parse(args[++index], CultureInfo.InvariantCulture);
                double w = double.Parse(args[++index], CultureInfo.InvariantCulture);
                double h = double.Parse(args[++index], CultureInfo.InvariantCulture);
                region = new Rect(x, y, w, h);
            }
            else if (args[index] == "--text-at" && index + 2 < args.Length)
            {
                double x = double.Parse(args[++index], CultureInfo.InvariantCulture);
                double y = double.Parse(args[++index], CultureInfo.InvariantCulture);
                textAt = new Point(x, y);
            }
        }

        dumpRoot = handle;
        AutomationElement root;
        try
        {
            root = AutomationElement.FromHandle(handle);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("FromHandle failed: " + ex.GetType().Name + ": " + ex.Message);
            return 1;
        }
        if (root == null)
        {
            Console.Error.WriteLine("no automation element for that hwnd");
            return 1;
        }

        Console.OutputEncoding = Encoding.UTF8;
        Console.WriteLine("root  : " + Describe(root, 0));
        if (!region.IsEmpty)
        {
            Console.WriteLine("region: " + Format(region) + "  (only intersecting nodes are marked *)");
        }
        Console.WriteLine(new string('-', 100));

        int visited = 0;
        int printed = 0;
        int withText = 0;
        Dictionary<string, int> typeCounts = new Dictionary<string, int>(StringComparer.Ordinal);

        // Breadth-first with a cache request, matching how the production probe
        // walks so the numbers here are comparable to what it would see.
        CacheRequest cache = new CacheRequest();
        cache.Add(AutomationElement.BoundingRectangleProperty);
        cache.Add(AutomationElement.ControlTypeProperty);
        cache.Add(AutomationElement.NameProperty);
        cache.Add(AutomationElement.AutomationIdProperty);
        cache.Add(AutomationElement.ClassNameProperty);
        cache.TreeFilter = Condition.TrueCondition;

        TreeWalker walker = TreeWalker.ControlViewWalker;
        List<KeyValuePair<AutomationElement, int>> queue = new List<KeyValuePair<AutomationElement, int>>();
        using (cache.Activate())
        {
            queue.Add(new KeyValuePair<AutomationElement, int>(root, 0));
            for (int index = 0; index < queue.Count && visited < maxNodes; index++)
            {
                AutomationElement element = queue[index].Key;
                int depth = queue[index].Value;
                visited++;

                string controlType = SafeControlType(element);
                typeCounts[controlType] = typeCounts.ContainsKey(controlType) ? typeCounts[controlType] + 1 : 1;
                string text = TextOf(element);
                if (!string.IsNullOrWhiteSpace(text)) withText++;
                if (includeSilent || !string.IsNullOrWhiteSpace(text))
                {
                    Console.WriteLine(Describe(element, depth));
                    printed++;
                }

                try
                {
                    AutomationElement child = walker.GetFirstChild(element);
                    while (child != null && queue.Count < maxNodes)
                    {
                        queue.Add(new KeyValuePair<AutomationElement, int>(child, depth + 1));
                        child = walker.GetNextSibling(child);
                    }
                }
                catch (Exception)
                {
                    // A subtree in another process may refuse; keep going.
                }
            }
        }

        Console.WriteLine(new string('-', 100));
        Console.WriteLine("visited=" + visited + " printed=" + printed + " with_text=" + withText);
        List<string> types = new List<string>(typeCounts.Keys);
        types.Sort();
        StringBuilder summary = new StringBuilder();
        foreach (string type in types)
        {
            if (summary.Length > 0) summary.Append("  ");
            summary.Append(type.Replace("ControlType.", "")).Append("=").Append(typeCounts[type]);
        }
        Console.WriteLine("types : " + summary);
        ReportTextAtPoint();
        return 0;
    }

    // Console buffers expose one Text element for the whole buffer whose Name is
    // the executable path — useless — but a TextPattern on it can still answer
    // "what is on the line under this point". This is the difference between
    // reading a terminal exactly and OCR-ing a picture of it.
    private static void ReportTextAtPoint()
    {
        if (double.IsNaN(textAt.X)) return;
        Console.WriteLine(new string('-', 100));
        Console.WriteLine("TextPattern probe at " + Format(new Rect(textAt.X, textAt.Y, 1, 1)));
        try
        {
            AutomationElement element = AutomationElement.FromPoint(textAt);
            if (element == null)
            {
                Console.WriteLine("  FromPoint returned nothing");
                return;
            }
            Console.WriteLine("  element: " + SafeControlType(element).Replace("ControlType.", "")
                + " cls=" + Safe(element, AutomationElement.ClassNameProperty)
                + " name=\"" + Safe(element, AutomationElement.NameProperty) + "\"");
            object raw;
            if (!element.TryGetCurrentPattern(TextPattern.Pattern, out raw))
            {
                Console.WriteLine("  no TextPattern on the element FromPoint returned; searching the tree instead");
                element = FindTextPatternElementAt(textAt);
                if (element == null)
                {
                    Console.WriteLine("  no element in the tree supports TextPattern at this point");
                    return;
                }
                Console.WriteLine("  found  : " + SafeControlType(element).Replace("ControlType.", "")
                    + " cls=" + Safe(element, AutomationElement.ClassNameProperty)
                    + " " + Format(SafeRect(element)));
                if (!element.TryGetCurrentPattern(TextPattern.Pattern, out raw)) return;
            }
            TextPattern text = (TextPattern)raw;
            TextPatternRange range = text.RangeFromPoint(textAt);
            if (range == null)
            {
                Console.WriteLine("  RangeFromPoint returned nothing");
                return;
            }
            range.ExpandToEnclosingUnit(TextUnit.Line);
            string line = range.GetText(400);
            Console.WriteLine("  line   : \"" + line.Replace("\r", " ").Replace("\n", " ").TrimEnd() + "\"");
            Rect[] bounds = range.GetBoundingRectangles();
            for (int index = 0; index < bounds.Length && index < 4; index++)
            {
                Console.WriteLine("  rect   : " + Format(bounds[index]));
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("  failed: " + ex.GetType().Name + ": " + ex.Message);
        }
    }

    // FromPoint stops at the window for apps that render their own content (a
    // terminal's TermControl, for one). The element is still in the tree, so
    // look for the deepest one that both contains the point and offers text.
    private static AutomationElement FindTextPatternElementAt(Point point)
    {
        AutomationElement best = null;
        double bestArea = double.MaxValue;
        try
        {
            TreeWalker walker = TreeWalker.ControlViewWalker;
            List<AutomationElement> queue = new List<AutomationElement>();
            queue.Add(AutomationElement.FromHandle(dumpRoot));
            for (int index = 0; index < queue.Count && index < 2000; index++)
            {
                AutomationElement element = queue[index];
                Rect rectangle = SafeRect(element);
                if (!rectangle.IsEmpty && rectangle.Contains(point))
                {
                    object ignored;
                    if (element.TryGetCurrentPattern(TextPattern.Pattern, out ignored))
                    {
                        double area = rectangle.Width * rectangle.Height;
                        if (area < bestArea)
                        {
                            bestArea = area;
                            best = element;
                        }
                    }
                }
                try
                {
                    AutomationElement child = walker.GetFirstChild(element);
                    while (child != null && queue.Count < 2000)
                    {
                        queue.Add(child);
                        child = walker.GetNextSibling(child);
                    }
                }
                catch (Exception) { }
            }
        }
        catch (Exception) { }
        return best;
    }

    private static string Describe(AutomationElement element, int depth)
    {
        Rect rectangle = SafeRect(element);
        string hit = (!region.IsEmpty && !rectangle.IsEmpty && rectangle.IntersectsWith(region)) ? "*" : " ";
        string text = TextOf(element);
        if (text.Length > 120) text = text.Substring(0, 120) + "…";
        text = text.Replace("\r", " ").Replace("\n", " ");
        return string.Format(
            CultureInfo.InvariantCulture,
            "{0}{1}{2,-22} {3,-26} cls={4,-22} {5}",
            hit,
            new string(' ', Math.Min(depth, 20) * 2),
            SafeControlType(element).Replace("ControlType.", ""),
            Format(rectangle),
            Safe(element, AutomationElement.ClassNameProperty),
            text.Length > 0 ? "\"" + text + "\"" : "");
    }

    private static string TextOf(AutomationElement element)
    {
        string value = "";
        try
        {
            object pattern;
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
            {
                value = ((ValuePattern)pattern).Current.Value ?? "";
            }
        }
        catch (Exception) { }
        if (!string.IsNullOrWhiteSpace(value)) return value.Trim();
        string name = Safe(element, AutomationElement.NameProperty);
        if (!string.IsNullOrWhiteSpace(name)) return name.Trim();
        return Safe(element, AutomationElement.HelpTextProperty).Trim();
    }

    private static string Safe(AutomationElement element, AutomationProperty property)
    {
        try
        {
            object value = element.GetCurrentPropertyValue(property);
            return value == null ? "" : value.ToString();
        }
        catch (Exception)
        {
            return "";
        }
    }

    private static string SafeControlType(AutomationElement element)
    {
        try
        {
            ControlType type = element.Current.ControlType;
            return type == null ? "?" : type.ProgrammaticName;
        }
        catch (Exception)
        {
            return "?";
        }
    }

    private static Rect SafeRect(AutomationElement element)
    {
        try
        {
            return element.Current.BoundingRectangle;
        }
        catch (Exception)
        {
            return Rect.Empty;
        }
    }

    private static string Format(Rect rectangle)
    {
        if (rectangle.IsEmpty) return "[empty]";
        return string.Format(
            CultureInfo.InvariantCulture,
            "[{0},{1} {2}x{3}]",
            Math.Round(rectangle.Left),
            Math.Round(rectangle.Top),
            Math.Round(rectangle.Width),
            Math.Round(rectangle.Height));
    }
}
