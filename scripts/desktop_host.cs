using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

internal static class DesktopHost
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 32000000 };
    static readonly HashSet<ushort> HeldKeys = new HashSet<ushort>();
    static string CancelPath="";
    static void CheckCancellation(){if(CancelPath!=""&&File.Exists(CancelPath))throw new OperationCanceledException("native_action_cancelled");}
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; public Point(int x, int y) { this.x=x; this.y=y; } }
    [StructLayout(LayoutKind.Sequential)] struct LastInputInfo { public uint cbSize, dwTime; }
    [StructLayout(LayoutKind.Sequential)] struct Mouse { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct Keyboard { public ushort key,scan; public uint flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public Mouse mouse; [FieldOffset(0)] public Keyboard keyboard; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public InputUnion data; }
    delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point p);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] input, int size);
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInputInfo info);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern short VkKeyScanW(char c);
    [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint type);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref Point p);
    [DllImport("user32.dll")] static extern IntPtr ChildWindowFromPointEx(IntPtr parent, Point pt, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeoutW(IntPtr h, uint msg, IntPtr w, IntPtr l, uint fuFlags, uint uTimeout, out IntPtr res);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr FindWindowW(string cls,string title);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int cbSize; public Rect monitor; public Rect work; public uint flags; }
    delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdcMonitor, ref Rect lprcMonitor, IntPtr dwData);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc lpfnEnum, IntPtr dwData);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetMonitorInfoW(IntPtr hMonitor, ref MonitorInfo lpmi);
    [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll")] static extern bool CloseClipboard();
    [DllImport("user32.dll")] static extern bool EmptyClipboard();
    [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint uFormat);
    [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterClipboardFormatW(string lpszFormat);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr hMem);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr hMem);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr hMem);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h,int a,out int v,int n);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int cls, out int value, int length, out int returned);
    [StructLayout(LayoutKind.Sequential)] struct GuiThreadInfo { public int cbSize; public uint flags; public IntPtr active,focus,capture,menuOwner,moveSize,caret; public Rect caretRect; }
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref Point p);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr process,int flags,StringBuilder name,ref int size);
    [DllImport("psapi.dll",SetLastError=true)] static extern bool EnumProcessModulesEx(IntPtr process,[Out] IntPtr[] modules,int size,out int needed,uint filter);
    [DllImport("psapi.dll",CharSet=CharSet.Unicode)] static extern uint GetModuleBaseNameW(IntPtr process,IntPtr module,StringBuilder name,int size);
    [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern bool SHGetPathFromIDListW(IntPtr pidl,StringBuilder path);
    [ComImport,Guid("6D5140C1-7436-11CE-8034-00AA006009FA"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ServiceProvider { [PreserveSig] int QueryService(ref Guid service,ref Guid iid,out IntPtr result); }
    [ComImport,Guid("000214E2-0000-0000-C000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ShellBrowser {
        void GetWindow(out IntPtr hwnd);void ContextSensitiveHelp(bool enter);void InsertMenusSB(IntPtr shared,IntPtr widths);void SetMenuSB(IntPtr menu,IntPtr hole,IntPtr active);void RemoveMenusSB(IntPtr shared);void SetStatusTextSB([MarshalAs(UnmanagedType.LPWStr)]string text);void EnableModelessSB(bool enabled);void TranslateAcceleratorSB(IntPtr msg,ushort id);void BrowseObject(IntPtr pidl,uint flags);void GetViewStateStream(uint mode,out IntPtr stream);void GetControlWindow(uint id,out IntPtr hwnd);void SendControlMsg(uint id,uint msg,IntPtr w,IntPtr l,out IntPtr result);void QueryActiveShellView([MarshalAs(UnmanagedType.IUnknown)]out object view);void OnViewWindowActive(IntPtr view);void SetToolbarItems(IntPtr buttons,uint count,uint flags);
    }
    [ComImport,Guid("CDE725B0-CCC9-4519-917E-325D72FAB4CE"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface FolderView {
        void GetCurrentViewMode(out uint mode);void SetCurrentViewMode(uint mode);void GetFolder(ref Guid iid,[MarshalAs(UnmanagedType.IUnknown)]out object folder);void Item(int index,out IntPtr pidl);void ItemCount(uint flags,out int count);void Items(uint flags,ref Guid iid,out IntPtr items);void GetSelectionMarkedItem(out int index);void GetFocusedItem(out int index);void GetItemPosition(IntPtr pidl,out Point position);void GetSpacing(out Point spacing);
    }
    static object ShellItems(){object shell=null,windows=null,desktop=null,viewObject=null;IntPtr browserPointer=IntPtr.Zero;try{
        shell=Activator.CreateInstance(System.Type.GetTypeFromProgID("Shell.Application"));windows=shell.GetType().InvokeMember("Windows",System.Reflection.BindingFlags.InvokeMethod,null,shell,null);
        object[] parameters={0,0,8,0,1};desktop=windows.GetType().InvokeMember("FindWindowSW",System.Reflection.BindingFlags.InvokeMethod,null,windows,parameters);
        var provider=(ServiceProvider)desktop;var service=new Guid("4C96BE40-915C-11CF-99D3-00AA004AE837");var iid=new Guid("000214E2-0000-0000-C000-000000000046");int hr=provider.QueryService(ref service,ref iid,out browserPointer);Marshal.ThrowExceptionForHR(hr);
        var browser=(ShellBrowser)Marshal.GetObjectForIUnknown(browserPointer);browser.QueryActiveShellView(out viewObject);var view=(FolderView)viewObject;int count;Point spacing;view.ItemCount(2,out count);view.GetSpacing(out spacing);var rows=new List<object>();
        for(int index=0;index<count;index++){IntPtr pidl;view.Item(index,out pidl);try{var path=new StringBuilder(32768);if(!SHGetPathFromIDListW(pidl,path))continue;Point position;view.GetItemPosition(pidl,out position);if(!File.Exists(path.ToString())&&!Directory.Exists(path.ToString()))continue;rows.Add(new{name=Path.GetFileName(path.ToString()),path=path.ToString(),bbox=new[]{position.x,position.y,position.x+spacing.x,position.y+spacing.y},source="shell:desktop-folder-view"});}finally{Marshal.FreeCoTaskMem(pidl);}}
        return new{items=rows,usedBackend="shell:desktop-folder-view"};
    }finally{if(browserPointer!=IntPtr.Zero)Marshal.Release(browserPointer);foreach(var item in new[]{viewObject,desktop,windows,shell})if(item!=null&&Marshal.IsComObject(item))Marshal.ReleaseComObject(item);}}

    // Named keys. Single characters go through the active keyboard layout (VkKeyScanW), never through their code point:
    // '.' is not VK_DELETE and '[' is not the Windows key.
    static readonly Dictionary<string,ushort> Keys = new Dictionary<string,ushort>(StringComparer.OrdinalIgnoreCase) {
        {"ctrl",17},{"control",17},{"alt",18},{"menu",18},{"shift",16},{"enter",13},{"return",13},{"tab",9},{"esc",27},{"escape",27},
        {"backspace",8},{"delete",46},{"del",46},{"space",32},{"left",37},{"up",38},{"right",39},{"down",40},
        {"home",36},{"end",35},{"pageup",33},{"pagedown",34},{"insert",45},{"capslock",20},{"numlock",144},{"scrolllock",145},
        {"pause",19},{"printscreen",44},{"apps",93},{"contextmenu",93},{"plus",187},{"minus",189},{"comma",188},{"period",190},
        {"volumeup",175},{"volumedown",174},{"volumemute",173},{"medianext",176},{"mediaprev",177},{"mediaplaypause",179}
    };
    static readonly HashSet<ushort> ExtendedKeys = new HashSet<ushort>{33,34,35,36,37,38,39,40,45,46,93,144,44};
    static object Get(IDictionary<string,object> d,string key,object fallback=null) { object value; return d.TryGetValue(key,out value)?value:fallback; }
    static int Num(IDictionary<string,object> d,string key,int fallback=0) { return Convert.ToInt32(Get(d,key,fallback)); }
    static string Str(IDictionary<string,object> d,string key,string fallback="") { return Convert.ToString(Get(d,key,fallback)); }
    static Dictionary<string,object> Obj(object value) { return value as Dictionary<string,object> ?? new Dictionary<string,object>(); }
    static object[] Arr(object value) { var array=value as object[]; if(array!=null)return array; var list=value as ArrayList; return list==null?new object[0]:list.ToArray(); }
    static int[] Bounds(IntPtr hwnd) { Rect r; if(!GetWindowRect(hwnd,out r))throw new Exception("window_unavailable"); return new[]{r.left,r.top,r.right,r.bottom}; }
    static uint Pid(IntPtr hwnd){uint pid;GetWindowThreadProcessId(hwnd,out pid);return pid;}
    static string ClassOf(IntPtr hwnd){var cls=new StringBuilder(256);GetClassName(hwnd,cls,cls.Capacity);return cls.ToString();}
    static Dictionary<string,object> Window(IntPtr hwnd) {
        uint pid=Pid(hwnd); var title=new StringBuilder(8192); GetWindowText(hwnd,title,title.Capacity);
        string name="",started="";try { using(var p=Process.GetProcessById((int)pid)){ name=p.ProcessName+".exe";started=p.StartTime.ToUniversalTime().ToString("o");} }catch{}
        return new Dictionary<string,object>{{"hwnd",hwnd.ToInt64()},{"pid",pid},{"processId",pid},{"process_name",name},{"processName",name},{"processStartTime",started},{"title",title.ToString()},{"class_name",ClassOf(hwnd)},{"bbox",Bounds(hwnd)},{"focused",GetForegroundWindow()==hwnd},{"elevated",IsElevated(pid)}};
    }
    static bool Cloaked(IntPtr hwnd){int cloaked;return DwmGetWindowAttribute(hwnd,14,out cloaked,4)==0&&cloaked!=0;}
    static object Windows() {
        var result=new List<object>(); EnumWindows(delegate(IntPtr hwnd,IntPtr unused){ try { if(!IsWindowVisible(hwnd)||Cloaked(hwnd))return true;
            var row=Window(hwnd);var rect=(int[])row["bbox"];if(rect[2]-rect[0]<30||rect[3]-rect[1]<30||String.IsNullOrWhiteSpace((string)row["title"]))return true;
            row["z_order"]=result.Count+1;result.Add(row); }catch{}return true;},IntPtr.Zero);return result;
    }

    // UIPI silently drops input sent from a medium-integrity process to an elevated one; say so instead of reporting success.
    static bool? SelfElevated;
    static bool TokenElevated(IntPtr process,out bool denied){denied=false;IntPtr token;if(!OpenProcessToken(process,8,out token)){denied=Marshal.GetLastWin32Error()==5;return false;}
        try{int value,size;return GetTokenInformation(token,20,out value,4,out size)&&value!=0;}finally{CloseHandle(token);}}
    static bool IsElevated(uint pid){
        if(!SelfElevated.HasValue){bool ignored;SelfElevated=TokenElevated(GetCurrentProcess(),out ignored);}
        if(SelfElevated.Value)return false;
        IntPtr process=OpenProcess(0x1000,false,pid);if(process==IntPtr.Zero)return false;
        try{bool denied;bool elevated=TokenElevated(process,out denied);return elevated||denied;}finally{CloseHandle(process);}
    }

    static string RuntimeKey(int[] id){return String.Join(".",id);}
    // Elements seen in the latest tree walk, keyed by runtime id; actions resolve through here instead of re-walking the whole subtree.
    static readonly Dictionary<string,AutomationElement> ElementCache=new Dictionary<string,AutomationElement>();
    // One cross-process call per parent: children arrive with every property the row needs, instead of ~15 live round trips per element.
    // Each cached pattern flag costs the provider a lookup per element (~0.4ms on WPF), so only patterns the runtime reads are fetched; actions still probe live.
    static readonly Tuple<AutomationProperty,string>[] PatternFlags={
        Tuple.Create(AutomationElement.IsInvokePatternAvailableProperty,"Invoke"),Tuple.Create(AutomationElement.IsValuePatternAvailableProperty,"Value"),
        Tuple.Create(AutomationElement.IsTogglePatternAvailableProperty,"Toggle"),Tuple.Create(AutomationElement.IsSelectionItemPatternAvailableProperty,"SelectionItem"),
        Tuple.Create(AutomationElement.IsExpandCollapsePatternAvailableProperty,"ExpandCollapse"),Tuple.Create(AutomationElement.IsRangeValuePatternAvailableProperty,"RangeValue"),
        Tuple.Create(AutomationElement.IsScrollPatternAvailableProperty,"Scroll"),Tuple.Create(AutomationElement.IsTextPatternAvailableProperty,"Text")};
    static CacheRequest TreeCache(){var request=new CacheRequest();
        foreach(var property in new[]{AutomationElement.RuntimeIdProperty,AutomationElement.NameProperty,AutomationElement.ControlTypeProperty,AutomationElement.AutomationIdProperty,AutomationElement.BoundingRectangleProperty,
            AutomationElement.IsEnabledProperty,AutomationElement.IsPasswordProperty,AutomationElement.IsOffscreenProperty,AutomationElement.HasKeyboardFocusProperty,ValuePattern.ValueProperty})request.Add(property);
        foreach(var flag in PatternFlags)request.Add(flag.Item1);return request;}
    static T Cached<T>(AutomationElement e,AutomationProperty property,T fallback){var value=e.GetCachedPropertyValue(property,true);return value is T?(T)value:fallback;}
    static Dictionary<string,object> Element(AutomationElement e,long hwnd,int index,int parent,int depth,out int[] runtime) {
        var r=Cached(e,AutomationElement.BoundingRectangleProperty,System.Windows.Rect.Empty);runtime=Cached(e,AutomationElement.RuntimeIdProperty,new int[0]);bool password=Cached(e,AutomationElement.IsPasswordProperty,false);
        var patterns=PatternFlags.Where(flag=>Cached(e,flag.Item1,false)).Select(flag=>flag.Item2).ToArray();var role=Cached<ControlType>(e,AutomationElement.ControlTypeProperty,null);
        var row=new Dictionary<string,object>{{"index",index},{"parent_index",parent},{"depth",depth},{"hwnd",hwnd},{"runtime_id",runtime},
            {"role",role==null?"":role.ProgrammaticName.Replace("ControlType.","").ToLowerInvariant()},{"name",Cached(e,AutomationElement.NameProperty,"")},{"automation_id",Cached(e,AutomationElement.AutomationIdProperty,"")},{"rect",r.IsEmpty?new[]{0,0,0,0}:new[]{(int)r.Left,(int)r.Top,(int)r.Right,(int)r.Bottom}},
            {"patterns",patterns},{"enabled",Cached(e,AutomationElement.IsEnabledProperty,false)},{"password",password},{"offscreen",Cached(e,AutomationElement.IsOffscreenProperty,false)},{"focused",Cached(e,AutomationElement.HasKeyboardFocusProperty,false)}};
        if(!password&&patterns.Contains("Value"))row["value"]=Cached(e,ValuePattern.ValueProperty,"");
        object p;if(!password&&patterns.Contains("Text")&&e.TryGetCurrentPattern(TextPattern.Pattern,out p))row["text"]=((TextPattern)p).DocumentRange.GetText(8192);
        return row;
    }
    // Menus, dropdowns and owned popups are separate top-level windows of the same process; they belong to the observed surface.
    static List<IntPtr> SurfaceRoots(IntPtr hwnd){
        var roots=new List<IntPtr>{hwnd};uint pid=Pid(hwnd);
        EnumWindows(delegate(IntPtr other,IntPtr unused){try{if(other==hwnd||!IsWindowVisible(other)||Cloaked(other)||Pid(other)!=pid)return true;
            var owner=GetWindow(other,4);var cls=ClassOf(other);
            if(owner==hwnd||cls=="#32768"||cls.IndexOf("popup",StringComparison.OrdinalIgnoreCase)>=0||cls.IndexOf("dropdown",StringComparison.OrdinalIgnoreCase)>=0)roots.Insert(0,other);}catch{}return true;},IntPtr.Zero);
        return roots;
    }
    const int TreeWalkDeadlineMs=4000;
    // A named text/button already carries its visible content, and images have none; asking each for children is a round trip per node
    // (most of a web page) for nothing. Unnamed ones still descend: inline code spans and icon buttons keep their text in children.
    static bool Leaf(Dictionary<string,object> row){var role=(string)row["role"];return role=="image"||(role=="text"||role=="button")&&!String.IsNullOrWhiteSpace((string)row["name"]);}
    // Runs on its own MTA thread so a target whose UI thread hangs costs one deadline, not the whole host: the rows read so far are still returned.
    sealed class TreeWalk {
        public readonly List<object> Rows=new List<object>();public readonly Dictionary<string,AutomationElement> Found=new Dictionary<string,AutomationElement>();
        public string Truncated;public bool Abandoned;public Exception Failure;readonly long hwnd;readonly int limit;
        public TreeWalk(long hwnd,int limit){this.hwnd=hwnd;this.limit=limit;}
        public void Run(){try{var request=TreeCache();using(request.Activate()){
            foreach(var rootHwnd in SurfaceRoots(new IntPtr(hwnd))){
                AutomationElement root;try{root=AutomationElement.FromHandle(rootHwnd).GetUpdatedCache(request);}catch(ElementNotAvailableException){continue;}
                var queue=new Queue<Tuple<AutomationElement,int,int>>();queue.Enqueue(Tuple.Create(root,0,0));long owner=rootHwnd.ToInt64();
                while(queue.Count>0){var entry=queue.Dequeue();int index;
                    lock(this){if(Abandoned)return;if(Rows.Count>=limit){Truncated="limit";return;}index=Rows.Count+1;}
                    try{int[] runtime;var row=Element(entry.Item1,owner,index,entry.Item2,entry.Item3,out runtime);
                        lock(this){if(Abandoned)return;Rows.Add(row);Found[RuntimeKey(runtime)]=entry.Item1;}
                        if(entry.Item3<40&&!Leaf(row)){var children=entry.Item1.FindAll(TreeScope.Children,Condition.TrueCondition);for(int i=0;i<children.Count;i++)queue.Enqueue(Tuple.Create(children[i],index,entry.Item3+1));}}
                    catch(ElementNotAvailableException){}}
            }}}catch(Exception e){lock(this)Failure=e;}}
    }
    static object Elements(long hwnd,int limit) {
        var walk=new TreeWalk(hwnd,limit);var watch=Stopwatch.StartNew();var thread=new Thread(walk.Run){IsBackground=true};thread.SetApartmentState(ApartmentState.MTA);thread.Start();
        bool finished=false;try{while(!(finished=thread.Join(25))&&watch.ElapsedMilliseconds<TreeWalkDeadlineMs)CheckCancellation();}
        finally{lock(walk){walk.Abandoned=!finished;}}
        lock(walk){if(walk.Failure!=null&&walk.Rows.Count==0)throw walk.Failure;
            ElementCache.Clear();foreach(var pair in walk.Found)ElementCache[pair.Key]=pair.Value;
            return new{elements=walk.Rows.ToArray(),truncated=!finished?"deadline":walk.Failure!=null?"error":walk.Truncated,elapsedMs=watch.ElapsedMilliseconds,usedBackend="uia_cache_request"};}
    }
    // Same isolation for a single-element read: a hung target fails this request, not the host.
    static T OnUiaThread<T>(Func<T> work,int deadlineMs){T result=default(T);Exception failure=null;
        var thread=new Thread(()=>{try{result=work();}catch(Exception e){failure=e;}}){IsBackground=true};thread.SetApartmentState(ApartmentState.MTA);thread.Start();var watch=Stopwatch.StartNew();
        while(!thread.Join(25)){CheckCancellation();if(watch.ElapsedMilliseconds>=deadlineMs)throw new Exception("uia_deadline");}
        if(failure!=null)throw failure;return result;}
    // The observed row as it is now, found by runtime id; lets an action check its one target instead of re-walking the whole tree.
    // L0 of the context stack: who this window really is, read from the OS alone (no UIA, no pixels).
    static object SurfaceFacts(IntPtr hwnd){uint pid;uint thread=GetWindowThreadProcessId(hwnd,out pid);if(thread==0)throw new Exception("window_not_found");
        string exe="",product="",version="",note="";var modules=new List<string>();
        IntPtr process=OpenProcess(0x1000|0x0010,false,pid);
        if(process==IntPtr.Zero){process=OpenProcess(0x1000,false,pid);note="modules_denied";}
        if(process!=IntPtr.Zero)try{
            var path=new StringBuilder(32768);int size=path.Capacity;if(QueryFullProcessImageNameW(process,0,path,ref size))exe=path.ToString();
            if(note==""){var handles=new IntPtr[1024];int needed;if(EnumProcessModulesEx(process,handles,IntPtr.Size*handles.Length,out needed,3)){
                for(int i=0;i<Math.Min(handles.Length,needed/IntPtr.Size);i++){var name=new StringBuilder(260);if(GetModuleBaseNameW(process,handles[i],name,name.Capacity)>0)modules.Add(name.ToString());}}
                else note="modules_unavailable";}
        }finally{CloseHandle(process);}else note="process_denied";
        if(exe!="")try{var info=FileVersionInfo.GetVersionInfo(exe);product=info.ProductName??"";version=info.ProductVersion??info.FileVersion??"";}catch{}
        var gui=new GuiThreadInfo{cbSize=Marshal.SizeOf(typeof(GuiThreadInfo))};object guiRow=null;
        if(GetGUIThreadInfo(thread,ref gui)){object caret=null;
            if(gui.caret!=IntPtr.Zero){var a=new Point(gui.caretRect.left,gui.caretRect.top);var b=new Point(gui.caretRect.right,gui.caretRect.bottom);ClientToScreen(gui.caret,ref a);ClientToScreen(gui.caret,ref b);caret=new[]{a.x,a.y,b.x,b.y};}
            guiRow=new{focusHwnd=gui.focus.ToInt64(),focusClass=gui.focus==IntPtr.Zero?"":ClassOf(gui.focus),activeHwnd=gui.active.ToInt64(),caret=caret,inMenu=(gui.flags&4)!=0,moving=(gui.flags&2)!=0};}
        var classes=new List<string>();EnumChildWindows(hwnd,delegate(IntPtr child,IntPtr unused){var cls=ClassOf(child);if(!classes.Contains(cls))classes.Add(cls);return classes.Count<40;},IntPtr.Zero);
        return new{hwnd=hwnd.ToInt64(),pid=pid,exe=exe,product=product,version=version,className=ClassOf(hwnd),modules=modules,childClasses=classes,gui=guiRow,note=note,usedBackend="win32_process_modules"};}
    static object ReadElement(IDictionary<string,object> row){return OnUiaThread(()=>{var e=FindElement(row).GetUpdatedCache(TreeCache());int[] runtime;
        return Element(e,Convert.ToInt64(Get(row,"hwnd",0)),Num(row,"index"),Num(row,"parent_index"),Num(row,"depth"),out runtime);},3500);}
    static AutomationElement FindElement(IDictionary<string,object> row){long hwnd=Convert.ToInt64(Get(row,"hwnd",0));var expected=Arr(Get(row,"runtime_id")).Select(Convert.ToInt32).ToArray();
        if(expected.Length==0)throw new Exception("missing_runtime_id");
        AutomationElement cached;if(ElementCache.TryGetValue(RuntimeKey(expected),out cached)){try{if(cached.GetRuntimeId().SequenceEqual(expected))return cached;}catch(ElementNotAvailableException){}}
        var root=AutomationElement.FromHandle(new IntPtr(hwnd));var walker=TreeWalker.ControlViewWalker;var queue=new Queue<AutomationElement>();queue.Enqueue(root);var watch=Stopwatch.StartNew();
        while(queue.Count>0&&watch.ElapsedMilliseconds<3000){CheckCancellation();var current=queue.Dequeue();try{if(current.GetRuntimeId().SequenceEqual(expected))return current;
            for(var child=walker.GetFirstChild(current);child!=null;child=walker.GetNextSibling(child))queue.Enqueue(child);}catch(ElementNotAvailableException){}}
        throw new Exception(watch.ElapsedMilliseconds>=3000?"element_lookup_timeout":"stale_element");}
    static object Uia(IDictionary<string,object> args){var e=FindElement(Obj(Get(args,"element")));if(e.Current.IsPassword||!e.Current.IsEnabled)throw new Exception("element_not_editable");string action=Str(args,"action"),value=Str(args,"value");object p;
        if(IsElevated((uint)e.Current.ProcessId))throw new Exception("target_elevated");
        if(action=="read_value") { if(e.TryGetCurrentPattern(ValuePattern.Pattern,out p))return new{ok=true,value=(object)((ValuePattern)p).Current.Value,usedBackend="uia_value"};if(e.TryGetCurrentPattern(RangeValuePattern.Pattern,out p))return new{ok=true,value=(object)((RangeValuePattern)p).Current.Value,usedBackend="uia_range_value"};throw new Exception("value_pattern_unsupported"); }
        if(action=="value"||action=="set_value") {if(e.TryGetCurrentPattern(ValuePattern.Pattern,out p)){var vp=(ValuePattern)p;if(vp.Current.IsReadOnly)throw new Exception("readonly");vp.SetValue(value);}else if(e.TryGetCurrentPattern(RangeValuePattern.Pattern,out p)){((RangeValuePattern)p).SetValue(Double.Parse(value,System.Globalization.CultureInfo.InvariantCulture));}else throw new Exception("value_pattern_unsupported");}
        else if(action=="invoke"){if(!e.TryGetCurrentPattern(InvokePattern.Pattern,out p))throw new Exception("invoke_unsupported");((InvokePattern)p).Invoke();}
        else if(action=="toggle"){if(!e.TryGetCurrentPattern(TogglePattern.Pattern,out p))throw new Exception("toggle_unsupported");((TogglePattern)p).Toggle();}
        else if(action=="expand"||action=="collapse"){if(!e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out p))throw new Exception("expand_unsupported");if(action=="expand")((ExpandCollapsePattern)p).Expand();else((ExpandCollapsePattern)p).Collapse();}
        else if(action=="select"){if(e.TryGetCurrentPattern(SelectionItemPattern.Pattern,out p))((SelectionItemPattern)p).Select();else if(e.TryGetCurrentPattern(TextPattern.Pattern,out p))((TextPattern)p).DocumentRange.Select();else throw new Exception("select_unsupported");}
        else if(action=="scroll_into_view"){if(!e.TryGetCurrentPattern(ScrollItemPattern.Pattern,out p))throw new Exception("scroll_item_unsupported");((ScrollItemPattern)p).ScrollIntoView();}
        else if(action=="focus")WithInputOwnership(()=>{var current=FindElement(Obj(Get(args,"element")));if(current.Current.IsPassword||!current.Current.IsEnabled)throw new Exception("element_not_editable");current.SetFocus();return true;});else throw new Exception("unknown_uia_action");return new{ok=true,usedBackend="uia_"+action};}

    static uint LastAgentInputTick;
    static uint ActionStartInputTick;
    static uint LastInputTick(){var info=new LastInputInfo{cbSize=(uint)Marshal.SizeOf(typeof(LastInputInfo))};if(!GetLastInputInfo(ref info))throw new Exception("last_input_unavailable");return info.dwTime;}
    static uint RawIdleMs(){return unchecked((uint)Environment.TickCount)-LastInputTick();}
    static uint UserIdleMs(){uint last=LastInputTick();return LastAgentInputTick!=0&&last==LastAgentInputTick?UInt32.MaxValue:unchecked((uint)Environment.TickCount)-last;}
    static void WaitForUserIdle(){var watch=Stopwatch.StartNew();while(UserIdleMs()<350){CheckCancellation();if(watch.ElapsedMilliseconds>=2000)throw new Exception("computer_use_busy");Thread.Sleep(40);}CheckCancellation();}
    static T WithInputOwnership<T>(Func<T> action){using(var mutex=new Mutex(false,"Local\\MagicPointer.RealInput")){bool owned=false;try{try{owned=mutex.WaitOne(0);}catch(AbandonedMutexException){owned=true;}if(!owned)throw new Exception("computer_use_busy");WaitForUserIdle();return action();}finally{if(owned)mutex.ReleaseMutex();}}}
    static IntPtr MakeLParam(int x,int y){return new IntPtr((y<<16)|(x&0xFFFF));}
    static IntPtr DeepestChildAt(IntPtr rootHwnd,int sx,int sy){IntPtr cur=rootHwnd;for(int i=0;i<12;i++){var pt=new Point(sx,sy);if(!ScreenToClient(cur,ref pt))break;IntPtr child=ChildWindowFromPointEx(cur,pt,3);if(child==IntPtr.Zero||child==cur)break;cur=child;}return cur;}
    static IntPtr BgEditableChild(IntPtr rootHwnd){IntPtr found=IntPtr.Zero;EnumChildWindows(rootHwnd,delegate(IntPtr child,IntPtr unused){if(!IsWindowVisible(child)||!IsWindowEnabled(child))return true;string cls=ClassOf(child).ToLowerInvariant();if(cls=="edit"||cls.Contains("richedit")||cls.Contains("scintilla")||cls.Contains("renderwidgethost")||cls.Contains("notepad")||cls.Contains("textbox")){found=child;return false;}return true;},IntPtr.Zero);return found==IntPtr.Zero?rootHwnd:found;}
    static object BgInput(IDictionary<string,object> a){string action=Str(a,"action").ToLowerInvariant();if(action=="noop")return new{ok=true,action="noop",method="background_probe",disruptedUser=false};
        var elem=Obj(Get(a,"element"));var winObj=Obj(Get(a,"window"));long hwndVal=Convert.ToInt64(Get(winObj,"hwnd",0));
        if(elem.Count>0&&(action=="click"||action=="type_text")){try{var el=FindElement(elem);if(IsElevated((uint)el.Current.ProcessId))throw new Exception("target_elevated");object pat;
            if(action=="click"){if(el.TryGetCurrentPattern(InvokePattern.Pattern,out pat)){((InvokePattern)pat).Invoke();return new{ok=true,usedBackend="win32_bg_uia",method="uia_invoke",disruptedUser=false};}
                if(el.TryGetCurrentPattern(TogglePattern.Pattern,out pat)){((TogglePattern)pat).Toggle();return new{ok=true,usedBackend="win32_bg_uia",method="uia_toggle",disruptedUser=false};}
                if(el.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pat)){((SelectionItemPattern)pat).Select();return new{ok=true,usedBackend="win32_bg_uia",method="uia_select",disruptedUser=false};}}
            if(action=="type_text"&&Get(a,"submit",false).Equals(false)&&Get(a,"clear",false).Equals(true)&&el.TryGetCurrentPattern(ValuePattern.Pattern,out pat)){var vp=(ValuePattern)pat;if(!vp.Current.IsReadOnly){vp.SetValue(Str(a,"text"));return new{ok=true,usedBackend="win32_bg_uia",method="uia_value",disruptedUser=false};}}
        }catch(Exception ex){if(ex.Message=="target_elevated")throw;}}
        IntPtr hwnd=new IntPtr(hwndVal);if(hwnd==IntPtr.Zero||!IsWindow(hwnd))throw new Exception("window_unavailable");if(IsElevated(Pid(hwnd)))throw new Exception("target_elevated");
        int x=Num(a,"x"),y=Num(a,"y");
        if(action=="click"){IntPtr child=DeepestChildAt(hwnd,x,y);var pt=new Point(x,y);ScreenToClient(child,ref pt);IntPtr lp=MakeLParam(pt.x,pt.y);int cnt=Math.Max(1,Math.Min(2,Num(a,"count",1)));
            if(Str(a,"button","left")=="right"){PostMessageW(child,0x0204,new IntPtr(2),lp);Thread.Sleep(18);PostMessageW(child,0x0205,IntPtr.Zero,lp);}
            else{for(int i=0;i<cnt;i++){PostMessageW(child,i==1?0x0203u:0x0201u,new IntPtr(1),lp);Thread.Sleep(18);PostMessageW(child,0x0202,IntPtr.Zero,lp);if(i+1<cnt)Thread.Sleep(35);}}
            return new{ok=true,usedBackend="win32_bg_postmessage",targetHwnd=child.ToInt64(),disruptedUser=false};}
        if(action=="scroll"){IntPtr child=DeepestChildAt(hwnd,x,y);int dy=Num(a,"dy",-120);PostMessageW(child,0x020A,new IntPtr((dy&0xFFFF)<<16),MakeLParam(x,y));return new{ok=true,usedBackend="win32_bg_postmessage",targetHwnd=child.ToInt64(),disruptedUser=false};}
        if(action=="type_text"){IntPtr target=(Get(a,"x")!=null)?DeepestChildAt(hwnd,x,y):BgEditableChild(hwnd);if(Get(a,"clear",false).Equals(true)){PostMessageW(target,0x00B1,IntPtr.Zero,new IntPtr(-1));Thread.Sleep(10);}
            foreach(char c in Str(a,"text")){if(c=='\r')continue;if(c=='\n'){PostMessageW(target,0x0100,new IntPtr(13),new IntPtr(1));PostMessageW(target,0x0101,new IntPtr(13),new IntPtr(unchecked((int)0xC0000001)));}else PostMessageW(target,0x0102,new IntPtr(c),new IntPtr(1));Thread.Sleep(2);}
            return new{ok=true,usedBackend="win32_bg_postmessage",targetHwnd=target.ToInt64(),disruptedUser=false};}
        if(action=="press_key"){var ks=KeyNames(Str(a,"keys")).SelectMany(KeyCodes).ToArray();if(ks.Any(k=>k==91||k==92))throw new Exception("windows_key_rejected");IntPtr target=BgEditableChild(hwnd);
            if(ks.Length==1){PostMessageW(target,0x0100,new IntPtr(ks[0]),new IntPtr(1));Thread.Sleep(12);PostMessageW(target,0x0101,new IntPtr(ks[0]),new IntPtr(unchecked((int)0xC0000001)));return new{ok=true,usedBackend="win32_bg_postmessage",targetHwnd=target.ToInt64(),disruptedUser=false};}
            return new{ok=false,needsForeground=true,usedBackend="win32_bg_unsupported_chord"};}
        return new{ok=false,needsForeground=true,usedBackend="win32_bg_unsupported"};}
    static object WindowManage(IDictionary<string,object> a){long hwndVal=Convert.ToInt64(Get(a,"hwnd",0));IntPtr hwnd=new IntPtr(hwndVal);if(hwnd==IntPtr.Zero||!IsWindow(hwnd))throw new Exception("window_unavailable");
        if(IsElevated(Pid(hwnd)))throw new Exception("target_elevated");string act=Str(a,"action","restore").ToLowerInvariant();
        if(act=="minimize")ShowWindow(hwnd,6);else if(act=="maximize")ShowWindow(hwnd,3);else if(act=="restore")ShowWindow(hwnd,9);
        else if(act=="close")PostMessageW(hwnd,0x0010,IntPtr.Zero,IntPtr.Zero);
        else if(act=="move_resize"){int[] b=Bounds(hwnd);int nx=Get(a,"x")==null?b[0]:Num(a,"x"),ny=Get(a,"y")==null?b[1]:Num(a,"y"),nw=Get(a,"width")==null?(b[2]-b[0]):Num(a,"width"),nh=Get(a,"height")==null?(b[3]-b[1]):Num(a,"height");SetWindowPos(hwnd,IntPtr.Zero,nx,ny,Math.Max(160,nw),Math.Max(120,nh),0x0004|0x0010);}
        else throw new Exception("unknown_window_action:"+act);return new{ok=true,action=act,hwnd=hwndVal,usedBackend="win32_window_manage"};}
    static void CheckUserInterference(){CheckCancellation();if((GetAsyncKeyState(0x1B)&0x8000)!=0)throw new Exception("computer_use_escape_stop");uint latest=LastInputTick();if(latest!=ActionStartInputTick&&latest!=LastAgentInputTick)throw new Exception("computer_use_interrupted");}
    static string ProcessName(uint pid){try{return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName??"";}catch{return "";}}
    static string BuildCfHtmlPayload(string html){
        string body=html??"";
        const string headerTpl="Version:0.9\r\nStartHTML:{0:D10}\r\nEndHTML:{1:D10}\r\nStartFragment:{2:D10}\r\nEndFragment:{3:D10}\r\n";
        const string prefix="<html><body>\r\n<!--StartFragment-->";
        const string suffix="<!--EndFragment-->\r\n</body></html>";
        int headerLen=System.Text.Encoding.UTF8.GetByteCount(String.Format(headerTpl,0,0,0,0));
        int prefixLen=System.Text.Encoding.UTF8.GetByteCount(prefix);
        int bodyLen=System.Text.Encoding.UTF8.GetByteCount(body);
        int suffixLen=System.Text.Encoding.UTF8.GetByteCount(suffix);
        int startHtml=headerLen;
        int startFrag=headerLen+prefixLen;
        int endFrag=startFrag+bodyLen;
        int endHtml=endFrag+suffixLen;
        return String.Format(headerTpl,startHtml,endHtml,startFrag,endFrag)+prefix+body+suffix;
    }
    static void WriteClipboardBytes(uint fmt,byte[] payload){
        IntPtr hMem=GlobalAlloc(0x0002,new UIntPtr((uint)payload.Length));
        if(hMem==IntPtr.Zero)throw new Exception("clipboard_alloc_failed");
        bool locked=false;
        try{
            IntPtr ptr=GlobalLock(hMem);
            if(ptr==IntPtr.Zero)throw new Exception("clipboard_lock_failed");
            locked=true;
            Marshal.Copy(payload,0,ptr,payload.Length);
        }finally{if(locked)GlobalUnlock(hMem);}
        if(SetClipboardData(fmt,hMem)==IntPtr.Zero){GlobalFree(hMem);throw new Exception("clipboard_set_data_failed");}
    }
    static bool SetClipboardRich(string text,string format){
        string plain=text??"";
        if(format=="html"){
            string stripped=System.Text.RegularExpressions.Regex.Replace(plain,"<[^>]+>","").Replace("&nbsp;"," ").Replace("&lt;","<").Replace("&gt;",">").Replace("&amp;","&");
            if(!String.IsNullOrWhiteSpace(stripped))plain=stripped;
        }
        byte[] unicodeBytes=System.Text.Encoding.Unicode.GetBytes(plain+"\0");
        byte[] htmlBytes=format=="html"?System.Text.Encoding.UTF8.GetBytes(BuildCfHtmlPayload(text??"")+"\0"):null;
        bool opened=false;
        for(int attempt=0;attempt<10;attempt++){if(OpenClipboard(IntPtr.Zero)){opened=true;break;}Thread.Sleep(15);}
        if(!opened)return false;
        try{
            if(!EmptyClipboard())return false;
            WriteClipboardBytes(13u,unicodeBytes);
            if(htmlBytes!=null){uint cfHtml=RegisterClipboardFormatW("HTML Format");if(cfHtml!=0)WriteClipboardBytes(cfHtml,htmlBytes);}
        }finally{CloseClipboard();}
        if(plain.Length==0)return true;
        for(int check=0;check<5;check++){
            if(IsClipboardFormatAvailable(13u))return true;
            Thread.Sleep(10);
        }
        return false;
    }
    static void Send(params Input[] entries){if(SendInput((uint)entries.Length,entries,Marshal.SizeOf(typeof(Input)))!=entries.Length)throw new Exception("send_input_failed");LastAgentInputTick=LastInputTick();}
    static void MoveCursor(int x,int y){if(!SetCursorPos(x,y))throw new Exception("cursor_position_failed");LastAgentInputTick=LastInputTick();}
    static void GlideCursor(int targetX,int targetY,int durationMs){
        Point start;if(!GetCursorPos(out start)||durationMs<=0){MoveCursor(targetX,targetY);return;}
        int dx=targetX-start.x,dy=targetY-start.y;double dist=Math.Sqrt(dx*dx+dy*dy);
        if(dist<4.0){MoveCursor(targetX,targetY);return;}
        int steps=Math.Max(6,Math.Min(20,durationMs/14));int stepDelay=Math.Max(6,durationMs/steps);
        for(int s=1;s<=steps;s++){
            if(s%3==1)CheckUserInterference();
            double t=(double)s/steps,inv=1.0-t,eased=1.0-(inv*inv*inv);
            MoveCursor(start.x+(int)Math.Round(dx*eased),start.y+(int)Math.Round(dy*eased));
            if(s<steps)Thread.Sleep(stepDelay);
        }
    }
    static void MouseInput(uint flags,int value=0){Send(new Input{type=0,data=new InputUnion{mouse=new Mouse{flags=flags,data=unchecked((uint)value)}}});}
    static Input KeyEvent(ushort key,bool up){uint flags=(up?2u:0u)|(ExtendedKeys.Contains(key)?1u:0u);return new Input{type=1,data=new InputUnion{keyboard=new Keyboard{key=key,scan=(ushort)MapVirtualKeyW(key,0),flags=flags}}};}
    static void Key(ushort key,bool up){Send(KeyEvent(key,up));}
    // Returns the virtual key plus any modifiers the layout needs to produce the character (e.g. '+' needs shift on US layouts).
    static ushort[] KeyCodes(string name){ushort code;if(Keys.TryGetValue(name,out code))return new[]{code};
        int number;if(name.Length>1&&name.StartsWith("f",StringComparison.OrdinalIgnoreCase)&&Int32.TryParse(name.Substring(1),out number)&&number>=1&&number<=24)return new[]{(ushort)(111+number)};
        if(name.Length==1){short scan=VkKeyScanW(name[0]);if(scan==-1)throw new Exception("unsupported_key:"+name);var keys=new List<ushort>();int shift=(scan>>8)&0xff;
            if(Char.IsLetter(name[0]))shift&=~1;if((shift&1)!=0)keys.Add(16);if((shift&2)!=0)keys.Add(17);if((shift&4)!=0)keys.Add(18);keys.Add((ushort)(scan&0xff));return keys.ToArray();}
        throw new Exception("unsupported_key:"+name);}
    // "ctrl++" and "+" name the plus key itself; every other '+' or space separates keys.
    static IEnumerable<string> KeyNames(string names){var current=new StringBuilder();for(int i=0;i<names.Length;i++){char c=names[i];
        if((c=='+'||c==' ')&&current.Length>0){yield return current.ToString();current.Clear();}else if(c==' '){}else if(c=='+'&&(i+1==names.Length||names[i+1]=='+'))yield return "+";else if(c!='+')current.Append(c);}
        if(current.Length>0)yield return current.ToString();}
    static void Chord(string names){var keys=KeyNames(names).SelectMany(KeyCodes).Distinct().ToArray();
        if(keys.Any(key=>key==91||key==92))throw new Exception("windows_key_rejected");
        var pressed=new List<ushort>();try{foreach(var key in keys){Key(key,false);pressed.Add(key);}}finally{pressed.Reverse();foreach(var key in pressed)Key(key,true);}}
    static void UnicodeChar(char c){Send(new Input{type=1,data=new InputUnion{keyboard=new Keyboard{scan=c,flags=4}}},new Input{type=1,data=new InputUnion{keyboard=new Keyboard{scan=c,flags=6}}});}
    // Line breaks and tabs are keys, not characters: most editors ignore a Unicode U+000A.
    static void Type(string text){int index=0;for(int i=0;i<text.Length;i++){char c=text[i];if(index++%8==0)CheckUserInterference();
        if(c=='\r'){if(i+1<text.Length&&text[i+1]=='\n')continue;Chord("enter");}else if(c=='\n')Chord("enter");else if(c=='\t')Chord("tab");else UnicodeChar(c);}}
    static readonly HashSet<string> ShellOverlayClasses = new HashSet<string>(StringComparer.OrdinalIgnoreCase){
        "Shell_TrayWnd","NotifyIconOverflowWindow","TopLevelWindowForOverflowXamlIsland","#32768","Xaml_WindowedPopupClass"
    };
    static IntPtr RootAt(int x,int y){return GetAncestor(WindowFromPoint(new Point(x,y)),2);}
    static void CheckTarget(IDictionary<string,object> a, bool foreground, int? x=null,int? y=null){var expected=Obj(Get(a,"window"));if(expected.Count==0)throw new Exception("missing_action_lease");long hwnd=Convert.ToInt64(Get(expected,"hwnd",0));var live=Window(new IntPtr(hwnd));
        if(Convert.ToInt64(live["pid"])!=Convert.ToInt64(Get(expected,"pid",Get(expected,"processId",0))))throw new Exception("stale_window_process");
        string start=Str(expected,"processStartTime");if(start!=""&&start!=Str(live,"processStartTime"))throw new Exception("stale_window_process");var bounds=Arr(Get(expected,"bbox")).Select(Convert.ToInt32).ToArray();if(bounds.Length==4&&!bounds.SequenceEqual((int[])live["bbox"]))throw new Exception("stale_window_geometry");
        if((bool)live["elevated"])throw new Exception("target_elevated");
        uint pid=(uint)Convert.ToInt64(live["pid"]);
        if(foreground){var front=GetForegroundWindow();if(front.ToInt64()!=hwnd&&Pid(front)!=pid)throw new Exception("focus_lost");}
        if(x.HasValue){var root=RootAt(x.Value,y.Value);if(root.ToInt64()==hwnd)return;
            if(ShellOverlayClasses.Contains(ClassOf(root))){if(root!=IntPtr.Zero&&IsElevated(Pid(root)))throw new Exception("target_elevated");return;}
            // A menu, dropdown or dialog of the same process is part of the target surface; anything else in the way is an obstruction.
            if(Pid(root)!=pid)throw new Exception("target_obscured:"+ProcessName(Pid(root))+"["+ClassOf(root)+"]");}}
    static bool Activate(IntPtr hwnd){if(IsIconic(hwnd))ShowWindow(hwnd,9);if(SetForegroundWindow(hwnd)&&GetForegroundWindow()==hwnd)return true;
        uint ignored;uint foregroundThread=GetWindowThreadProcessId(GetForegroundWindow(),out ignored),self=GetCurrentThreadId();bool attached=foregroundThread!=0&&foregroundThread!=self&&AttachThreadInput(self,foregroundThread,true);
        try{BringWindowToTop(hwnd);SetForegroundWindow(hwnd);}finally{if(attached)AttachThreadInput(self,foregroundThread,false);}
        if(GetForegroundWindow()!=hwnd){Key(18,false);Key(18,true);SetForegroundWindow(hwnd);}
        return GetForegroundWindow()==hwnd;}
    static object Act(IDictionary<string,object> a){string action=Str(a,"action");long hwnd=Convert.ToInt64(Get(Obj(Get(a,"window")),"hwnd",0));
        bool pointer=new[]{"click","scroll","drag","move"}.Contains(action)||(action=="paste"&&Get(a,"x")!=null&&Get(a,"y")!=null);int x=Num(a,"x"),y=Num(a,"y");
        bool screenDirect=Get(a,"screen_direct",false).Equals(true);
        using(var mutex=new Mutex(false,"Local\\MagicPointer.RealInput")){bool owned=false;Point savedCursor=new Point(0,0);bool restoreCursor=false;try{try{owned=mutex.WaitOne(0);}catch(AbandonedMutexException){owned=true;}if(!owned)throw new Exception("computer_use_busy");
            WaitForUserIdle();ActionStartInputTick=LastInputTick();
            if(action=="activate_window"){CheckTarget(a,false);return new{ok=Activate(new IntPtr(hwnd)),usedBackend="win32_activate"};}
            if(pointer&&screenDirect){if(x<-32768||y<-32768)throw new Exception("invalid_coordinates");var hitRoot=RootAt(x,y);if(hitRoot!=IntPtr.Zero&&IsElevated(Pid(hitRoot)))throw new Exception("target_elevated");}
            else if(!pointer&&screenDirect){var front=GetForegroundWindow();if(front!=IntPtr.Zero&&IsElevated(Pid(front)))throw new Exception("target_elevated");}
            else{CheckTarget(a,!pointer,pointer?(int?)x:null,pointer?(int?)y:null);}
            if(pointer&&action!="move"&&Get(a,"restore_cursor",false).Equals(true)&&GetCursorPos(out savedCursor)){restoreCursor=true;}
            object dropWindow=null;
            if(pointer){int glide=Get(a,"duration_ms")!=null?Math.Max(0,Math.Min(10000,Num(a,"duration_ms",0))):(action=="move"?220:160);GlideCursor(x,y,glide);}
            if(action=="click"){uint down=Str(a,"button","left")=="right"?8u:Str(a,"button","left")=="middle"?32u:2u;for(int i=0;i<Math.Min(3,Math.Max(1,Num(a,"count",1)));i++){CheckUserInterference();try{MouseInput(down);Thread.Sleep(35);}finally{MouseInput(down*2);}if(i+1<Num(a,"count",1))Thread.Sleep(60);}}
            else if(action=="scroll"){if(Num(a,"dy")!=0){CheckUserInterference();MouseInput(0x800,Num(a,"dy"));}if(Num(a,"dx")!=0){CheckUserInterference();MouseInput(0x1000,Num(a,"dx"));}}
            else if(action=="drag"){int tx=Num(a,"to_x"),ty=Num(a,"to_y");
                // The drop may land in another application (file into a chat window); it only has to be a real, non-elevated window.
                var drop=RootAt(tx,ty);if(drop==IntPtr.Zero&&!screenDirect)throw new Exception("drop_target_missing");if(drop!=IntPtr.Zero){if(IsElevated(Pid(drop)))throw new Exception("target_elevated");dropWindow=new{hwnd=drop.ToInt64(),pid=Pid(drop),class_name=ClassOf(drop)};}
                int duration=Math.Max(0,Math.Min(3000,Num(a,"duration_ms",200)));var points=Arr(Get(a,"path")).Select(Obj).ToArray();try{MouseInput(2);if(points.Length>1){foreach(var point in points){CheckUserInterference();MoveCursor(Num(point,"x"),Num(point,"y"));Thread.Sleep(duration/points.Length);}}else for(int i=1;i<=20;i++){CheckUserInterference();MoveCursor(x+(tx-x)*i/20,y+(ty-y)*i/20);Thread.Sleep(duration/20);}}finally{MouseInput(4);}}
            else if(action=="type_text"){if(Get(a,"clear",false).Equals(true)){Chord("ctrl+a");Chord("backspace");}Type(Str(a,"text"));}
            else if(action=="paste"){
                if(Get(a,"x")!=null&&Get(a,"y")!=null){CheckUserInterference();try{MouseInput(2);Thread.Sleep(35);}finally{MouseInput(4);}Thread.Sleep(45);}
                string pasteText=Str(a,"text");string pasteFmt=Str(a,"format","text").ToLowerInvariant();
                if(pasteFmt!="html")pasteFmt="text";
                if(!SetClipboardRich(pasteText,pasteFmt))throw new Exception("clipboard_set_failed");
                if(Get(a,"clear",false).Equals(true)){CheckUserInterference();Chord("ctrl+a");Chord("backspace");Thread.Sleep(20);}
                CheckUserInterference();Chord("ctrl+v");
                if(Get(a,"submit",false).Equals(true)){Thread.Sleep(25);CheckUserInterference();Chord("enter");}
            }
            else if(action=="press_key")Chord(Str(a,"keys"));
            else if(action=="key_down"||action=="key_up"){foreach(var code in KeyNames(Str(a,"keys")).SelectMany(KeyCodes)){if(code==91||code==92)throw new Exception("windows_key_rejected");Key(code,action=="key_up");if(action=="key_down")HeldKeys.Add(code);else HeldKeys.Remove(code);}}
            else if(action!="move")throw new Exception("unknown_input_action");
            return new{ok=true,usedBackend="win32_send_input",cursorRestored=restoreCursor,dropWindow=dropWindow,verification=new{matched=false,status="unavailable"}};
        }catch(Exception ex){if(ex.Message=="computer_use_escape_stop"||ex.Message=="computer_use_interrupted"){try{ReleaseInput();}catch{}}throw;}finally{if(restoreCursor){try{MoveCursor(savedCursor.x,savedCursor.y);}catch{}}if(owned)mutex.ReleaseMutex();}}}
    // Recovery after a crash or timeout of an earlier host: nothing the agent pressed may stay down.
    static object ReleaseInput(){foreach(var key in HeldKeys.ToArray())Key(key,true);HeldKeys.Clear();var released=new List<int>();
        foreach(ushort key in new ushort[]{16,17,18,160,161,162,163,164,165}){if((GetAsyncKeyState(key)&0x8000)!=0){Key(key,true);released.Add(key);}}
        foreach(var button in new[]{new[]{1,4},new[]{2,16},new[]{4,64}}){if((GetAsyncKeyState(button[0])&0x8000)!=0){MouseInput((uint)button[1]);released.Add(button[0]);}}
        return new{ok=true,released=released};}
    static Bitmap CopyScreen(int[] b){var bitmap=new Bitmap(b[2]-b[0],b[3]-b[1],PixelFormat.Format32bppArgb);using(var graphics=Graphics.FromImage(bitmap))graphics.CopyFromScreen(b[0],b[1],0,0,bitmap.Size,CopyPixelOperation.SourceCopy);return bitmap;}
    static bool Occluded(IntPtr hwnd,int[] b){var roots=new HashSet<long>{hwnd.ToInt64()};uint pid=Pid(hwnd);
        foreach(var fx in new[]{0.2,0.5,0.8})foreach(var fy in new[]{0.2,0.5,0.8}){var root=RootAt(b[0]+(int)((b[2]-b[0])*fx),b[1]+(int)((b[3]-b[1])*fy));if(!roots.Contains(root.ToInt64())&&Pid(root)!=pid)return true;}return false;}
    static bool Blank(Bitmap bitmap){for(int y=0;y<bitmap.Height;y+=Math.Max(1,bitmap.Height/16))for(int x=0;x<bitmap.Width;x+=Math.Max(1,bitmap.Width/16)){var c=bitmap.GetPixel(x,y);if(c.R!=0||c.G!=0||c.B!=0)return false;}return true;}
    static object Capture(IDictionary<string,object> a){var bounds=Arr(Get(a,"bounds")).Select(Convert.ToInt32).ToArray();if(bounds.Length!=4||bounds[2]<=bounds[0]||bounds[3]<=bounds[1])throw new Exception("invalid_capture_bounds");
        long hwnd=Convert.ToInt64(Get(a,"hwnd",0));Bitmap bitmap=null;string source="gdi-fallback";
        try{
            // A covered window is rendered from its own content, not from whatever happens to be on top of it.
            Rect live;if(hwnd!=0&&!IsIconic(new IntPtr(hwnd))&&GetWindowRect(new IntPtr(hwnd),out live)&&new[]{live.left,live.top,live.right,live.bottom}.SequenceEqual(bounds)&&Occluded(new IntPtr(hwnd),bounds)){
                var printed=new Bitmap(bounds[2]-bounds[0],bounds[3]-bounds[1],PixelFormat.Format32bppArgb);bool ok;using(var graphics=Graphics.FromImage(printed)){var hdc=graphics.GetHdc();try{ok=PrintWindow(new IntPtr(hwnd),hdc,2);}finally{graphics.ReleaseHdc(hdc);}}
                if(ok&&!Blank(printed)){bitmap=printed;source="print-window";}else printed.Dispose();}
            if(bitmap==null)bitmap=CopyScreen(bounds);
            using(var stream=new MemoryStream()){bitmap.Save(stream,ImageFormat.Png);return new{png=Convert.ToBase64String(stream.ToArray()),width=bitmap.Width,height=bitmap.Height,source=source,capturedAtUtc=DateTime.UtcNow.ToString("o")};}
        }finally{if(bitmap!=null)bitmap.Dispose();}}
    static object ImageOperation(IDictionary<string,object> a){using(var image=Image.FromFile(Str(a,"path"))){var region=Arr(Get(a,"rect")).Select(Convert.ToInt32).ToArray();var r=region.Length==4?new Rectangle(region[0],region[1],region[2],region[3]):new Rectangle(0,0,image.Width,image.Height);r.Intersect(new Rectangle(0,0,image.Width,image.Height));if(r.Width<1||r.Height<1)throw new Exception("empty_image_region");
        using(var output=new Bitmap(r.Width,r.Height)){using(var graphics=Graphics.FromImage(output)){graphics.DrawImage(image,new Rectangle(0,0,r.Width,r.Height),r,GraphicsUnit.Pixel);foreach(var raw in Arr(Get(a,"strokes"))){var points=Arr(raw).Select(v=>Obj(v)).Select(v=>new PointF(Num(v,"x")-r.X,Num(v,"y")-r.Y)).ToArray();if(points.Length>1)using(var pen=new Pen(Color.FromArgb(230,60,140,255),3))graphics.DrawLines(pen,points);}}
            string target=Str(a,"output");if(target!=""){Directory.CreateDirectory(Path.GetDirectoryName(target));output.Save(target,ImageFormat.Png);}using(var stream=new MemoryStream()){output.Save(stream,ImageFormat.Png);return new{path=target,png=Convert.ToBase64String(stream.ToArray()),width=output.Width,height=output.Height,usedBackend="native_image"};}}}}
    sealed class TrayWalk {
        public readonly object Sync=new object();
        public Dictionary<string,object> Chevron;
        public readonly List<object> Icons=new List<object>();
        public readonly List<object> MenuItems=new List<object>();
        public readonly HashSet<string> Seen=new HashSet<string>();
        public readonly Stopwatch Watch=Stopwatch.StartNew();
        readonly int[] tbBox;
        public TrayWalk(int[] tbBox){this.tbBox=tbBox;}
        static string SafeStr(Func<string> getter){try{return getter()??"";}catch{return "";}}
        static bool SafeOffscreen(AutomationElement el){try{return el.Current.IsOffscreen;}catch{return false;}}
        static ControlType SafeCt(AutomationElement el){try{return el.Current.ControlType;}catch{return null;}}
        static System.Windows.Rect SafeRect(AutomationElement el){try{return el.Current.BoundingRectangle;}catch{return System.Windows.Rect.Empty;}}
        void WalkContainer(IntPtr hwnd,string container,bool onlyMenu,int maxNodes,int maxDepth,int budgetMs){
            if(hwnd==IntPtr.Zero||!IsWindowVisible(hwnd))return;
            AutomationElement root;try{root=AutomationElement.FromHandle(hwnd);}catch{return;}
            if(root==null)return;
            var queue=new Queue<Tuple<AutomationElement,int>>();
            queue.Enqueue(Tuple.Create(root,0));
            int visited=0;
            int minTrayX=tbBox!=null&&tbBox.Length==4?(tbBox[0]+(int)((tbBox[2]-tbBox[0])*0.45)):0;
            while(queue.Count>0&&visited<maxNodes&&Watch.ElapsedMilliseconds<budgetMs){
                var pair=queue.Dequeue();visited++;
                var el=pair.Item1;int depth=pair.Item2;
                if(depth>0){
                    var rect=SafeRect(el);
                    if(!rect.IsEmpty&&rect.Width>=6&&rect.Height>=6&&rect.Width<=420&&rect.Height<=140&&!SafeOffscreen(el)){
                        var ct=SafeCt(el);
                        string nm=SafeStr(()=>el.Current.Name).Trim();
                        string aid=SafeStr(()=>el.Current.AutomationId).Trim();
                        int cx=(int)Math.Round(rect.Left+rect.Width/2.0);
                        int cy=(int)Math.Round(rect.Top+rect.Height/2.0);
                        int[] box=new[]{(int)Math.Round(rect.Left),(int)Math.Round(rect.Top),(int)Math.Round(rect.Right),(int)Math.Round(rect.Bottom)};
                        if(onlyMenu){
                            if((ct==ControlType.MenuItem||ct==ControlType.Button)&&nm!=""){
                                lock(Sync){if(Seen.Add("m:"+nm+":"+cx+":"+cy))MenuItems.Add(new{name=nm,automationId=aid,x=cx,y=cy,bbox=box,container=container});}
                            }
                        }else if(container=="taskbar"){
                            bool isChevron=ct==ControlType.Button&&(
                                nm.IndexOf("显示隐藏的图标",StringComparison.OrdinalIgnoreCase)>=0||
                                nm.IndexOf("Show hidden icons",StringComparison.OrdinalIgnoreCase)>=0||
                                nm.IndexOf("Notification Chevron",StringComparison.OrdinalIgnoreCase)>=0||
                                aid.IndexOf("OverflowButton",StringComparison.OrdinalIgnoreCase)>=0||
                                aid.IndexOf("SystemTrayChevron",StringComparison.OrdinalIgnoreCase)>=0);
                            if(isChevron){
                                lock(Sync){Chevron=new Dictionary<string,object>{{"name",nm},{"automationId",aid},{"x",cx},{"y",cy},{"bbox",box}};}
                            }else if((ct==ControlType.Button||ct==ControlType.MenuItem)&&nm!=""&&(cx>=minTrayX||aid.StartsWith("NotifyItemIcon")||aid.StartsWith("SystemTrayIcon"))){
                                lock(Sync){if(Seen.Add("t:"+nm+":"+cx+":"+cy))Icons.Add(new{name=nm,automationId=aid,x=cx,y=cy,bbox=box,container="taskbar"});}
                            }
                        }else{
                            if((ct==ControlType.Button||ct==ControlType.ListItem||ct==ControlType.MenuItem)&&nm!=""){
                                lock(Sync){if(Seen.Add(container+":"+nm+":"+cx+":"+cy))Icons.Add(new{name=nm,automationId=aid,x=cx,y=cy,bbox=box,container=container});}
                            }
                        }
                    }
                }
                if(depth<maxDepth){
                    try{
                        var children=el.FindAll(TreeScope.Children,Condition.TrueCondition);
                        for(int i=0;i<children.Count;i++)queue.Enqueue(Tuple.Create(children[i],depth+1));
                    }catch{}
                }
            }
        }
        public void Run(){
            IntPtr tb=FindWindowW("Shell_TrayWnd",null);
            WalkContainer(tb,"taskbar",false,220,10,450);
            var overflow=new List<IntPtr>();
            var menus=new List<IntPtr>();
            EnumWindows(delegate(IntPtr h,IntPtr unused){
                try{
                    if(!IsWindowVisible(h)||Cloaked(h))return true;
                    string cls=ClassOf(h);
                    if(cls=="TopLevelWindowForOverflowXamlIsland"||cls=="NotifyIconOverflowWindow")overflow.Add(h);
                    else if(cls=="#32768")menus.Add(h);
                    else if(cls=="Xaml_WindowedPopupClass"){int[] b=Bounds(h);if(b[2]-b[0]>=40&&b[3]-b[1]>=30)menus.Add(h);}
                }catch{}
                return true;
            },IntPtr.Zero);
            foreach(var h in overflow)WalkContainer(h,"overflow",false,120,8,700);
            foreach(var h in menus)WalkContainer(h,"menu",true,120,8,850);
        }
    }
    static object InspectTray(){
        IntPtr tb=FindWindowW("Shell_TrayWnd",null);
        int[] tbBox=tb!=IntPtr.Zero?Bounds(tb):new[]{0,0,0,0};
        int screenW=GetSystemMetrics(0),screenH=GetSystemMetrics(1);
        bool autoHide=tb==IntPtr.Zero||tbBox[1]>=screenH-6||(tbBox[3]-tbBox[1]<=8);
        var walk=new TrayWalk(tbBox);
        var thread=new Thread(walk.Run){IsBackground=true};
        thread.SetApartmentState(ApartmentState.MTA);
        thread.Start();
        thread.Join(900);
        Dictionary<string,object> chevronSnap;object[] iconsSnap,menusSnap;
        lock(walk.Sync){chevronSnap=walk.Chevron;iconsSnap=walk.Icons.ToArray();menusSnap=walk.MenuItems.ToArray();}
        return new{
            ok=true,
            taskbar=new{hwnd=tb.ToInt64(),bbox=tbBox,autoHide=autoHide,screen=new{width=screenW,height=screenH},revealPoint=new{x=screenW/2,y=Math.Max(0,screenH-1)}},
            chevron=chevronSnap,
            icons=iconsSnap,
            menuItems=menusSnap,
            elapsedMs=walk.Watch.ElapsedMilliseconds,
            usedBackend="win32_tray_uia"
        };
    }
    static Dictionary<string,object> DescribeUiaNode(AutomationElement el){
        if(el==null)return null;
        try{
            var r=el.Current.BoundingRectangle;
            if(r.IsEmpty||r.Width<2||r.Height<2)return null;
            if(el.Current.IsOffscreen)return null;
            var ct=el.Current.ControlType;
            string role=ct==null?"":ct.ProgrammaticName.Replace("ControlType.","").ToLowerInvariant();
            string name=el.Current.Name??"";
            string aid=el.Current.AutomationId??"";
            string val="";
            try{object pat;if(!el.Current.IsPassword&&el.TryGetCurrentPattern(ValuePattern.Pattern,out pat))val=((ValuePattern)pat).Current.Value??"";}catch{}
            int cx=(int)Math.Round(r.Left+r.Width/2.0),cy=(int)Math.Round(r.Top+r.Height/2.0);
            int[] box=new[]{(int)Math.Round(r.Left),(int)Math.Round(r.Top),(int)Math.Round(r.Right),(int)Math.Round(r.Bottom)};
            return new Dictionary<string,object>{
                {"name",name},{"role",role},{"automationId",aid},{"value",val},
                {"enabled",el.Current.IsEnabled},{"x",cx},{"y",cy},{"bbox",box}
            };
        }catch{return null;}
    }
    static object[] Monitors(out int[] virtualBox){
        var list=new List<object>();int idx=0;
        int vx=GetSystemMetrics(76),vy=GetSystemMetrics(77),vw=GetSystemMetrics(78),vh=GetSystemMetrics(79);
        if(vw<=0||vh<=0){vx=0;vy=0;vw=Math.Max(1,GetSystemMetrics(0));vh=Math.Max(1,GetSystemMetrics(1));}
        virtualBox=new[]{vx,vy,vx+vw,vy+vh};
        EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,delegate(IntPtr hMon,IntPtr hdc,ref Rect r,IntPtr data){
            var info=new MonitorInfo{cbSize=Marshal.SizeOf(typeof(MonitorInfo))};
            if(GetMonitorInfoW(hMon,ref info)){
                int[] box=new[]{info.monitor.left,info.monitor.top,info.monitor.right,info.monitor.bottom};
                int[] work=new[]{info.work.left,info.work.top,info.work.right,info.work.bottom};
                list.Add(new{index=idx++,primary=(info.flags&1)!=0,bbox=box,workArea=work,width=box[2]-box[0],height=box[3]-box[1]});
            }
            return true;
        },IntPtr.Zero);
        if(list.Count==0)list.Add(new{index=0,primary=true,bbox=virtualBox,workArea=virtualBox,width=vw,height=vh});
        return list.ToArray();
    }
    static object ReadClipboardSummary(){
        bool hasText=IsClipboardFormatAvailable(13),hasFiles=IsClipboardFormatAvailable(15),hasImage=IsClipboardFormatAvailable(2);
        string preview="";int textLength=0;
        if(hasText&&OpenClipboard(IntPtr.Zero)){
            try{
                IntPtr h=GetClipboardData(13);
                if(h!=IntPtr.Zero){
                    IntPtr ptr=GlobalLock(h);
                    if(ptr!=IntPtr.Zero){
                        try{string raw=Marshal.PtrToStringUni(ptr)??"";textLength=raw.Length;preview=raw.Length>400?raw.Substring(0,400):raw;}
                        finally{GlobalUnlock(h);}
                    }
                }
            }catch{}finally{CloseClipboard();}
        }
        return new{hasText=hasText,hasFiles=hasFiles,hasImage=hasImage,textLength=textLength,textPreview=preview};
    }
    static List<Dictionary<string,object>> CollectOverlayItems(IntPtr hwnd,int limit,int budgetMs){
        var outItems=new List<Dictionary<string,object>>();
        if(hwnd==IntPtr.Zero||!IsWindowVisible(hwnd))return outItems;
        object sync=new object();
        var watch=Stopwatch.StartNew();
        var thread=new Thread(()=>{
            try{
                var root=AutomationElement.FromHandle(hwnd);if(root==null)return;
                var q=new Queue<Tuple<AutomationElement,int>>();q.Enqueue(Tuple.Create(root,0));
                int visited=0;
                while(q.Count>0&&visited<140&&watch.ElapsedMilliseconds<budgetMs){
                    var pair=q.Dequeue();visited++;
                    if(pair.Item2>0){
                        var row=DescribeUiaNode(pair.Item1);
                        if(row!=null&&!String.IsNullOrWhiteSpace((string)row["name"])){
                            lock(sync){if(outItems.Count<limit)outItems.Add(row);}
                        }
                    }
                    if(pair.Item2<8){
                        try{
                            var children=pair.Item1.FindAll(TreeScope.Children,Condition.TrueCondition);
                            for(int i=0;i<children.Count;i++)q.Enqueue(Tuple.Create(children[i],pair.Item2+1));
                        }catch{}
                    }
                }
            }catch{}
        }){IsBackground=true};
        thread.SetApartmentState(ApartmentState.MTA);thread.Start();thread.Join(budgetMs);
        lock(sync)return new List<Dictionary<string,object>>(outItems);
    }
    static object DesktopOverview(IDictionary<string,object> a){
        int[] vBox;var monitors=Monitors(out vBox);
        Point cp;GetCursorPos(out cp);
        Dictionary<string,object> underCursor=null,fgObj=null;
        IntPtr underH=RootAt(cp.x,cp.y);if(underH!=IntPtr.Zero){try{underCursor=Window(underH);}catch{}}
        IntPtr fgH=GetForegroundWindow();if(fgH!=IntPtr.Zero){try{fgObj=Window(fgH);}catch{}}
        var winList=new List<object>();
        var overlayList=new List<object>();
        EnumWindows(delegate(IntPtr h,IntPtr unused){
            try{
                if(!IsWindowVisible(h)||Cloaked(h))return true;
                string cls=ClassOf(h);
                int[] box=Bounds(h);int w=box[2]-box[0],ht=box[3]-box[1];
                bool isOverlay=ShellOverlayClasses.Contains(cls)||cls=="Windows.UI.Core.CoreWindow";
                if(isOverlay&&w>=24&&ht>=20){
                    bool isPopup=cls=="#32768"||cls=="TopLevelWindowForOverflowXamlIsland"||cls=="NotifyIconOverflowWindow"||cls=="Xaml_WindowedPopupClass";
                    var items=isPopup?CollectOverlayItems(h,32,350):new List<Dictionary<string,object>>();
                    overlayList.Add(new{hwnd=h.ToInt64(),className=cls,bbox=box,items=items.ToArray()});
                    return true;
                }
                if(w<30||ht<30||winList.Count>=40)return true;
                var row=Window(h);if(String.IsNullOrWhiteSpace((string)row["title"]))return true;
                row["minimized"]=IsIconic(h);row["z_order"]=winList.Count+1;
                winList.Add(row);
            }catch{}
            return true;
        },IntPtr.Zero);
        var res=new Dictionary<string,object>{
            {"ok",true},{"monitors",monitors},{"virtualScreen",vBox},
            {"cursor",new{x=cp.x,y=cp.y}},{"underCursor",underCursor},{"foreground",fgObj},
            {"windows",winList.ToArray()},{"activeOverlays",overlayList.ToArray()},
            {"usedBackend","win32_desktop_overview"}
        };
        if(Get(a,"includeClipboard",false).Equals(true))res["clipboard"]=ReadClipboardSummary();
        return res;
    }
    static object ElementAt(IDictionary<string,object> a){
        int x=Num(a,"x"),y=Num(a,"y");
        object probeSync=new object();
        Dictionary<string,object> elementObj=null,parentObj=null,winObj=null;
        var siblingsList=new List<object>();
        IntPtr root=RootAt(x,y);if(root!=IntPtr.Zero){try{winObj=Window(root);}catch{}}
        var thread=new Thread(()=>{
            try{
                var el=AutomationElement.FromPoint(new System.Windows.Point(x,y));
                if(el==null)return;
                var selfRow=DescribeUiaNode(el);
                lock(probeSync){elementObj=selfRow;}
                try{
                    var parent=TreeWalker.ControlViewWalker.GetParent(el);
                    if(parent!=null){
                        var pRow=DescribeUiaNode(parent);
                        lock(probeSync){parentObj=pRow;}
                        var children=parent.FindAll(TreeScope.Children,Condition.TrueCondition);
                        for(int i=0;i<children.Count;i++){
                            var row=DescribeUiaNode(children[i]);
                            if(row!=null){lock(probeSync){if(siblingsList.Count>=24)break;siblingsList.Add(row);}}
                        }
                    }
                }catch{}
            }catch{}
        }){IsBackground=true};
        thread.SetApartmentState(ApartmentState.MTA);thread.Start();thread.Join(600);
        Dictionary<string,object> elSnap,pSnap;object[] sibSnap;
        lock(probeSync){elSnap=elementObj;pSnap=parentObj;sibSnap=siblingsList.ToArray();}
        return new{ok=true,x=x,y=y,element=elSnap,parent=pSnap,siblings=sibSnap,window=winObj,usedBackend="win32_element_at"};
    }
    static object Dispatch(string method,Dictionary<string,object> a){if(method=="release_input")return ReleaseInput();if(method=="ping")return new{ok=true};if(method=="resolve_keys")return KeyNames(Str(a,"keys")).SelectMany(KeyCodes).Distinct().Select(k=>(int)k).ToArray();if(method=="input_idle")return new{idleMs=(long)RawIdleMs(),userIdleMs=(long)UserIdleMs(),usedBackend="win32_last_input"};if(method=="windows")return Windows();if(method=="tray_icons")return InspectTray();if(method=="desktop_overview")return DesktopOverview(a);if(method=="element_at")return ElementAt(a);if(method=="window")return Window(new IntPtr(Convert.ToInt64(Get(a,"hwnd",0))));if(method=="window_manage")return WindowManage(a);if(method=="bg_input")return BgInput(a);if(method=="elements")return Elements(Convert.ToInt64(Get(a,"hwnd",0)),Num(a,"limit",3000));if(method=="element")return ReadElement(Obj(Get(a,"element")));if(method=="surface_facts")return SurfaceFacts(new IntPtr(Convert.ToInt64(Get(a,"hwnd",0))));if(method=="uia")return Uia(a);if(method=="input")return Act(a);if(method=="capture")return Capture(a);if(method=="image")return ImageOperation(a);if(method=="cursor"){Point p;GetCursorPos(out p);return new{x=p.x,y=p.y,hwnd=RootAt(p.x,p.y).ToInt64(),foreground=GetForegroundWindow().ToInt64()};}if(method=="launch")return WithInputOwnership(()=>{var child=Process.Start(new ProcessStartInfo(Str(a,"app")){UseShellExecute=true});return new{ok=child!=null,pid=child==null?0:child.Id,usedBackend="shell_execute"};});throw new Exception("unknown_method:"+method);}
    [STAThread] public static int Main(){try{SetProcessDpiAwarenessContext(new IntPtr(-4));}catch{SetProcessDPIAware();}Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);string line;
        while((line=Console.ReadLine())!=null){object id=null;try{var request=Json.Deserialize<Dictionary<string,object>>(line);id=Get(request,"id");var args=Obj(Get(request,"params"));CancelPath=Str(args,"cancelPath");CheckCancellation();var result=Str(request,"method")=="desktop_items"?ShellItems():Dispatch(Str(request,"method"),args);Console.WriteLine(Json.Serialize(new{id=id,result=result}));}catch(Exception e){Console.WriteLine(Json.Serialize(new{id=id,error=new{code=e.Message,message=e.ToString()}}));}finally{CancelPath="";}}
        foreach(var key in HeldKeys.ToArray())Key(key,true);HeldKeys.Clear();return 0;}
}
