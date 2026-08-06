// Magic Pointer native element-picker prototype.
// Ctrl+Alt+F9 toggles highlighting; Ctrl+Alt+Shift+F9 exits.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Automation;
using System.Windows.Forms;

internal sealed class Candidate
{
    public Rectangle Bounds;
    public string Category;
    public string Type;
    public string Name;
    public Color Color;
    public int LatencyMs;
}

internal class EdgeForm : Form
{
    public EdgeForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        BackColor = Color.Cyan;
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            const int WS_EX_TRANSPARENT = 0x20;
            const int WS_EX_TOOLWINDOW = 0x80;
            const int WS_EX_NOACTIVATE = 0x08000000;
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
            return cp;
        }
    }

    protected override void WndProc(ref Message m)
    {
        const int WM_NCHITTEST = 0x84;
        const int HTTRANSPARENT = -1;
        if (m.Msg == WM_NCHITTEST) { m.Result = new IntPtr(HTTRANSPARENT); return; }
        base.WndProc(ref m);
    }
}

internal sealed class LabelForm : EdgeForm
{
    private string caption = "";

    public LabelForm()
    {
        BackColor = Color.FromArgb(22, 24, 30);
        ForeColor = Color.White;
        Font = new Font("Microsoft YaHei UI", 9.0f, FontStyle.Bold);
    }

    public void SetCaption(string value, Color accent)
    {
        caption = value;
        BackColor = Color.FromArgb(22, 24, 30);
        ForeColor = Color.White;
        Tag = accent;
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        Color accent = Tag is Color ? (Color)Tag : Color.Cyan;
        using (Brush strip = new SolidBrush(accent)) e.Graphics.FillRectangle(strip, 0, 0, 5, Height);
        TextRenderer.DrawText(e.Graphics, caption, Font, new Rectangle(11, 0, Width - 14, Height),
            ForeColor, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
    }
}

internal sealed class PickerController : Form
{
    private const int WM_HOTKEY = 0x0312;
    private const int HOTKEY_TOGGLE = 501;
    private const int HOTKEY_EXIT = 502;
    private const uint MOD_ALT = 0x0001;
    private const uint MOD_CONTROL = 0x0002;
    private const uint MOD_SHIFT = 0x0004;
    private readonly EdgeForm top = new EdgeForm();
    private readonly EdgeForm bottom = new EdgeForm();
    private readonly EdgeForm left = new EdgeForm();
    private readonly EdgeForm right = new EdgeForm();
    private readonly LabelForm label = new LabelForm();
    private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    private readonly int ownPid = Process.GetCurrentProcess().Id;
    private int queryRunning;
    private bool enabled = true;

    [DllImport("user32.dll")]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint key);
    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    public PickerController()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        Opacity = 0;
        StartPosition = FormStartPosition.Manual;
        Bounds = new Rectangle(-32000, -32000, 1, 1);
        timer.Interval = 45;
        timer.Tick += Poll;
        Load += delegate
        {
            RegisterHotKey(Handle, HOTKEY_TOGGLE, MOD_CONTROL | MOD_ALT, (uint)Keys.F9);
            RegisterHotKey(Handle, HOTKEY_EXIT, MOD_CONTROL | MOD_ALT | MOD_SHIFT, (uint)Keys.F9);
            timer.Start();
        };
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        UnregisterHotKey(Handle, HOTKEY_TOGGLE);
        UnregisterHotKey(Handle, HOTKEY_EXIT);
        HideAll();
        base.OnFormClosed(e);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == HOTKEY_TOGGLE)
        {
            enabled = !enabled;
            if (!enabled) HideAll();
            return;
        }
        if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == HOTKEY_EXIT)
        {
            Close();
            return;
        }
        base.WndProc(ref m);
    }

    private void Poll(object sender, EventArgs e)
    {
        if (!enabled || Interlocked.Exchange(ref queryRunning, 1) != 0) return;
        Point point = Cursor.Position;
        Task.Run(delegate
        {
            Stopwatch stopwatch = Stopwatch.StartNew();
            Candidate candidate = FindCandidate(point);
            if (candidate != null) candidate.LatencyMs = (int)stopwatch.ElapsedMilliseconds;
            return candidate;
        }).ContinueWith(task =>
        {
            try
            {
                if (IsDisposed) return;
                BeginInvoke((Action)delegate
                {
                    if (!enabled || task.IsFaulted || task.Result == null) HideAll();
                    else ShowCandidate(task.Result);
                });
            }
            finally { Interlocked.Exchange(ref queryRunning, 0); }
        });
    }

    private Candidate FindCandidate(Point point)
    {
        try
        {
            AutomationElement element = AutomationElement.FromPoint(new System.Windows.Point(point.X, point.Y));
            for (int depth = 0; element != null && depth < 7; depth++)
            {
                Candidate candidate = ReadCandidate(element);
                if (candidate != null) return candidate;
                element = TreeWalker.ControlViewWalker.GetParent(element);
            }
        }
        catch (ElementNotAvailableException) { }
        catch (InvalidOperationException) { }
        catch (COMException) { }
        return null;
    }

    private Candidate ReadCandidate(AutomationElement element)
    {
        AutomationElement.AutomationElementInformation info;
        try { info = element.Current; }
        catch (ElementNotAvailableException) { return null; }
        if (info.ProcessId == ownPid || info.IsOffscreen) return null;
        System.Windows.Rect raw = info.BoundingRectangle;
        if (raw.IsEmpty || raw.Width < 3 || raw.Height < 3 || raw.Width > 12000 || raw.Height > 12000) return null;

        Rectangle virtualScreen = SystemInformation.VirtualScreen;
        Rectangle rounded = Rectangle.FromLTRB(
            (int)Math.Floor(raw.Left),
            (int)Math.Floor(raw.Top),
            (int)Math.Ceiling(raw.Right),
            (int)Math.Ceiling(raw.Bottom));
        Rectangle bounds = Rectangle.Intersect(virtualScreen, rounded);
        if (bounds.Width < 3 || bounds.Height < 3) return null;
        string type = info.ControlType == null ? "Unknown" : info.ControlType.ProgrammaticName.Replace("ControlType.", "");
        string name = Clean(info.Name, 72);

        // A nameless pane covering almost the entire screen is only a fallback,
        // never a convincing semantic selection.
        double screenShare = (double)bounds.Width * bounds.Height / Math.Max(1.0, (double)virtualScreen.Width * virtualScreen.Height);
        if ((type == "Pane" || type == "Window" || type == "Custom") && name.Length == 0 && screenShare > 0.55) return null;

        string category;
        Color color;
        Categorize(type, out category, out color);
        return new Candidate { Bounds = bounds, Category = category, Type = type, Name = name, Color = color };
    }

    private static string Clean(string value, int max)
    {
        string text = (value ?? "").Replace('\r', ' ').Replace('\n', ' ').Trim();
        while (text.Contains("  ")) text = text.Replace("  ", " ");
        return text.Length <= max ? text : text.Substring(0, max - 1) + "…";
    }

    private static void Categorize(string type, out string category, out Color color)
    {
        HashSet<string> actions = new HashSet<string> { "Button", "Hyperlink", "MenuItem", "TabItem", "SplitButton", "CheckBox", "RadioButton" };
        HashSet<string> text = new HashSet<string> { "Text", "Edit", "Document", "Header", "HeaderItem" };
        HashSet<string> items = new HashSet<string> { "ListItem", "DataItem", "TreeItem", "Table", "List", "Tree" };
        HashSet<string> media = new HashSet<string> { "Image", "Video" };
        if (actions.Contains(type)) { category = "ACTION"; color = Color.FromArgb(177, 112, 255); }
        else if (text.Contains(type)) { category = "TEXT"; color = Color.FromArgb(38, 211, 255); }
        else if (items.Contains(type)) { category = "ITEM"; color = Color.FromArgb(255, 166, 54); }
        else if (media.Contains(type)) { category = "MEDIA"; color = Color.FromArgb(255, 91, 166); }
        else { category = "CONTAINER"; color = Color.FromArgb(255, 213, 72); }
    }

    private void ShowCandidate(Candidate candidate)
    {
        const int thickness = 3;
        Rectangle r = candidate.Bounds;
        Color c = candidate.Color;
        Place(top, new Rectangle(r.Left, r.Top, r.Width, thickness), c);
        Place(bottom, new Rectangle(r.Left, Math.Max(r.Top, r.Bottom - thickness), r.Width, thickness), c);
        Place(left, new Rectangle(r.Left, r.Top, thickness, r.Height), c);
        Place(right, new Rectangle(Math.Max(r.Left, r.Right - thickness), r.Top, thickness, r.Height), c);

        string caption = candidate.Category + " · " + candidate.Type + " · " + candidate.LatencyMs + "ms";
        if (candidate.Name.Length > 0) caption += " · " + candidate.Name;
        Size measured = TextRenderer.MeasureText(caption, label.Font);
        int width = Math.Max(150, Math.Min(460, measured.Width + 24));
        int y = r.Top - 29;
        if (y < SystemInformation.VirtualScreen.Top) y = Math.Min(r.Bottom + 2, SystemInformation.VirtualScreen.Bottom - 27);
        int x = Math.Max(SystemInformation.VirtualScreen.Left, Math.Min(r.Left, SystemInformation.VirtualScreen.Right - width));
        label.SetCaption(caption, c);
        label.Bounds = new Rectangle(x, y, width, 27);
        if (!label.Visible) label.Show();
    }

    private static void Place(EdgeForm form, Rectangle bounds, Color color)
    {
        form.BackColor = color;
        form.Bounds = bounds;
        if (!form.Visible) form.Show();
    }

    private void HideAll()
    {
        top.Hide(); bottom.Hide(); left.Hide(); right.Hide(); label.Hide();
    }
}

internal static class Program
{
    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [STAThread]
    private static void Main()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new PickerController());
    }
}
