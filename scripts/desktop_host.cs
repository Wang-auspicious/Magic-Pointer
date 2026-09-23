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
    [StructLayout(LayoutKind.Sequential)] struct Mouse { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct Keyboard { public ushort key,scan; public uint flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public Mouse mouse; [FieldOffset(0)] public Keyboard keyboard; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public InputUnion data; }
    delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point p);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] input, int size);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h,int a,out int v,int n);
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
    static readonly Dictionary<string,ushort> Keys = new Dictionary<string,ushort>(StringComparer.OrdinalIgnoreCase) {
        {"ctrl",17},{"control",17},{"alt",18},{"shift",16},{"enter",13},{"return",13},{"tab",9},{"esc",27},{"escape",27},
        {"backspace",8},{"delete",46},{"del",46},{"space",32},{"left",37},{"up",38},{"right",39},{"down",40},
        {"home",36},{"end",35},{"pageup",33},{"pagedown",34},{"insert",45}
    };
    static object Get(IDictionary<string,object> d,string key,object fallback=null) { object value; return d.TryGetValue(key,out value)?value:fallback; }
    static int Num(IDictionary<string,object> d,string key,int fallback=0) { return Convert.ToInt32(Get(d,key,fallback)); }
    static string Str(IDictionary<string,object> d,string key,string fallback="") { return Convert.ToString(Get(d,key,fallback)); }
    static Dictionary<string,object> Obj(object value) { return value as Dictionary<string,object> ?? new Dictionary<string,object>(); }
    static object[] Arr(object value) { var array=value as object[]; if(array!=null)return array; var list=value as ArrayList; return list==null?new object[0]:list.ToArray(); }
    static int[] Bounds(IntPtr hwnd) { Rect r; if(!GetWindowRect(hwnd,out r))throw new Exception("window_unavailable"); return new[]{r.left,r.top,r.right,r.bottom}; }
    static Dictionary<string,object> Window(IntPtr hwnd) {
        uint pid; GetWindowThreadProcessId(hwnd,out pid); var title=new StringBuilder(8192); var cls=new StringBuilder(256); GetWindowText(hwnd,title,title.Capacity);GetClassName(hwnd,cls,cls.Capacity);
        string name="",started="";try { using(var p=Process.GetProcessById((int)pid)){ name=p.ProcessName+".exe";started=p.StartTime.ToUniversalTime().ToString("o");} }catch{}
        return new Dictionary<string,object>{{"hwnd",hwnd.ToInt64()},{"pid",pid},{"processId",pid},{"process_name",name},{"processName",name},{"processStartTime",started},{"title",title.ToString()},{"class_name",cls.ToString()},{"bbox",Bounds(hwnd)},{"focused",GetForegroundWindow()==hwnd}};
    }
    static object Windows() {
        var result=new List<object>(); EnumWindows(delegate(IntPtr hwnd,IntPtr unused){ try { int cloaked; if(!IsWindowVisible(hwnd)||(DwmGetWindowAttribute(hwnd,14,out cloaked,4)==0&&cloaked!=0))return true;
            var row=Window(hwnd);var rect=(int[])row["bbox"];if(rect[2]-rect[0]<30||rect[3]-rect[1]<30||String.IsNullOrWhiteSpace((string)row["title"]))return true;
            row["z_order"]=result.Count+1;result.Add(row); }catch{}return true;},IntPtr.Zero);return result;
    }
    static string PatternName(AutomationPattern p) { return p.ProgrammaticName.Replace("PatternIdentifiers.Pattern","").Replace("Identifiers.Pattern",""); }
    static Dictionary<string,object> Element(AutomationElement e,long hwnd,int index,int parent,int depth) {
        var c=e.Current; var r=c.BoundingRectangle; var row=new Dictionary<string,object>{{"index",index},{"parent_index",parent},{"depth",depth},{"hwnd",hwnd},{"runtime_id",e.GetRuntimeId()},
            {"role",c.ControlType.ProgrammaticName.Replace("ControlType.","").ToLowerInvariant()},{"name",c.Name},{"automation_id",c.AutomationId},{"rect",new[]{(int)r.Left,(int)r.Top,(int)r.Right,(int)r.Bottom}},
            {"patterns",e.GetSupportedPatterns().Select(PatternName).ToArray()},{"enabled",c.IsEnabled},{"password",c.IsPassword},{"offscreen",c.IsOffscreen},{"focused",c.HasKeyboardFocus}};
        object p;if(!c.IsPassword&&e.TryGetCurrentPattern(ValuePattern.Pattern,out p))row["value"]=((ValuePattern)p).Current.Value;
        if(!c.IsPassword&&e.TryGetCurrentPattern(TextPattern.Pattern,out p))row["text"]=((TextPattern)p).DocumentRange.GetText(65536);
        return row;
    }
    static object Elements(long hwnd,int limit) {
        var root=AutomationElement.FromHandle(new IntPtr(hwnd));var queue=new Queue<Tuple<AutomationElement,int,int>>();queue.Enqueue(Tuple.Create(root,0,0));var rows=new List<object>();var watch=Stopwatch.StartNew();
        while(queue.Count>0&&rows.Count<limit&&watch.ElapsedMilliseconds<4000){var entry=queue.Dequeue();try{int index=rows.Count+1;rows.Add(Element(entry.Item1,hwnd,index,entry.Item2,entry.Item3));
            if(entry.Item3<40){var children=entry.Item1.FindAll(TreeScope.Children,Condition.TrueCondition);for(int i=0;i<children.Count&&queue.Count<limit*2;i++)queue.Enqueue(Tuple.Create(children[i],index,entry.Item3+1));}}catch(ElementNotAvailableException){}catch(NullReferenceException){}}
        return rows;
    }
    static AutomationElement FindElement(IDictionary<string,object> row){long hwnd=Convert.ToInt64(Get(row,"hwnd",0));var root=AutomationElement.FromHandle(new IntPtr(hwnd));var expected=Arr(Get(row,"runtime_id")).Select(Convert.ToInt32).ToArray();
        if(expected.Length==0)throw new Exception("missing_runtime_id");var all=root.FindAll(TreeScope.Subtree,Condition.TrueCondition);foreach(AutomationElement candidate in all)if(candidate.GetRuntimeId().SequenceEqual(expected))return candidate;throw new Exception("stale_element");}
    static object Uia(IDictionary<string,object> args){var e=FindElement(Obj(Get(args,"element")));if(e.Current.IsPassword||!e.Current.IsEnabled)throw new Exception("element_not_editable");string action=Str(args,"action"),value=Str(args,"value");object p;
        if(action=="read_value") { if(e.TryGetCurrentPattern(ValuePattern.Pattern,out p))return new{ok=true,value=(object)((ValuePattern)p).Current.Value,usedBackend="uia_value"};if(e.TryGetCurrentPattern(RangeValuePattern.Pattern,out p))return new{ok=true,value=(object)((RangeValuePattern)p).Current.Value,usedBackend="uia_range_value"};throw new Exception("value_pattern_unsupported"); }
        if(action=="value"||action=="set_value") {if(e.TryGetCurrentPattern(ValuePattern.Pattern,out p)){var vp=(ValuePattern)p;if(vp.Current.IsReadOnly)throw new Exception("readonly");vp.SetValue(value);}else if(e.TryGetCurrentPattern(RangeValuePattern.Pattern,out p)){((RangeValuePattern)p).SetValue(Double.Parse(value,System.Globalization.CultureInfo.InvariantCulture));}else throw new Exception("value_pattern_unsupported");}
        else if(action=="invoke"){if(!e.TryGetCurrentPattern(InvokePattern.Pattern,out p))throw new Exception("invoke_unsupported");((InvokePattern)p).Invoke();}
        else if(action=="toggle"){if(!e.TryGetCurrentPattern(TogglePattern.Pattern,out p))throw new Exception("toggle_unsupported");((TogglePattern)p).Toggle();}
        else if(action=="expand"||action=="collapse"){if(!e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out p))throw new Exception("expand_unsupported");if(action=="expand")((ExpandCollapsePattern)p).Expand();else((ExpandCollapsePattern)p).Collapse();}
        else if(action=="select"){if(e.TryGetCurrentPattern(SelectionItemPattern.Pattern,out p))((SelectionItemPattern)p).Select();else if(e.TryGetCurrentPattern(TextPattern.Pattern,out p))((TextPattern)p).DocumentRange.Select();else throw new Exception("select_unsupported");}
        else if(action=="focus")e.SetFocus();else throw new Exception("unknown_uia_action");return new{ok=true,usedBackend="uia_"+action};}
    static void Send(params Input[] entries){if(SendInput((uint)entries.Length,entries,Marshal.SizeOf(typeof(Input)))!=entries.Length)throw new Exception("send_input_failed");}
    static void MouseInput(uint flags,int value=0){Send(new Input{type=0,data=new InputUnion{mouse=new Mouse{flags=flags,data=unchecked((uint)value)}}});}
    static void Key(ushort key,bool up){Send(new Input{type=1,data=new InputUnion{keyboard=new Keyboard{key=key,flags=up?2u:0u}}});}
    static ushort KeyCode(string name){ushort code;if(Keys.TryGetValue(name,out code))return code;if(name.Length==1)return (ushort)Char.ToUpperInvariant(name[0]);int number;if(name.StartsWith("f",StringComparison.OrdinalIgnoreCase)&&Int32.TryParse(name.Substring(1),out number)&&number>=1&&number<=24)return (ushort)(111+number);throw new Exception("unsupported_key:"+name);}
    static void Chord(string names){var keys=names.Split(new[]{'+',' '},StringSplitOptions.RemoveEmptyEntries).Select(KeyCode).ToArray();try{foreach(var key in keys)Key(key,false);}finally{foreach(var key in keys.Reverse())Key(key,true);}}
    static void Type(string text){int index=0;foreach(char c in text){if(index++%32==0)CheckCancellation();Send(new Input{type=1,data=new InputUnion{keyboard=new Keyboard{scan=c,flags=4}}},new Input{type=1,data=new InputUnion{keyboard=new Keyboard{scan=c,flags=6}}});}}
    static void CheckTarget(IDictionary<string,object> a, bool foreground, int? x=null,int? y=null){var expected=Obj(Get(a,"window"));if(expected.Count==0)throw new Exception("missing_action_lease");long hwnd=Convert.ToInt64(Get(expected,"hwnd",0));var live=Window(new IntPtr(hwnd));
        if(Convert.ToInt64(live["pid"])!=Convert.ToInt64(Get(expected,"pid",Get(expected,"processId",0))))throw new Exception("stale_window_process");
        string start=Str(expected,"processStartTime");if(start!=""&&start!=Str(live,"processStartTime"))throw new Exception("stale_window_process");var bounds=Arr(Get(expected,"bbox")).Select(Convert.ToInt32).ToArray();if(bounds.Length==4&&!bounds.SequenceEqual((int[])live["bbox"]))throw new Exception("stale_window_geometry");
        if(foreground&&GetForegroundWindow().ToInt64()!=hwnd)throw new Exception("focus_lost");if(x.HasValue){var b=(int[])live["bbox"];if(x<b[0]||x>=b[2]||y<b[1]||y>=b[3])throw new Exception("point_outside_surface");if(GetAncestor(WindowFromPoint(new Point(x.Value,y.Value)),2).ToInt64()!=hwnd)throw new Exception("target_obscured");}}
    static object Act(IDictionary<string,object> a){string action=Str(a,"action");long hwnd=Convert.ToInt64(Get(Obj(Get(a,"window")),"hwnd",0));
        if(action=="activate_window"){CheckTarget(a,false);ShowWindow(new IntPtr(hwnd),9);SetForegroundWindow(new IntPtr(hwnd));return new{ok=GetForegroundWindow().ToInt64()==hwnd,usedBackend="win32_activate"};}
        bool pointer=new[]{"click","scroll","drag","move"}.Contains(action);int x=Num(a,"x"),y=Num(a,"y");CheckTarget(a,!pointer,pointer?(int?)x:null,pointer?(int?)y:null);
        using(var mutex=new Mutex(false,"Local\\MagicPointer.RealInput")){bool owned=false;try{try{owned=mutex.WaitOne(0);}catch(AbandonedMutexException){owned=true;}if(!owned)throw new Exception("computer_use_busy");
            if(pointer){int glide=Math.Max(0,Math.Min(10000,Num(a,"duration_ms",0)));if(action=="move"&&glide>0){Point start;GetCursorPos(out start);int steps=Math.Max(1,Math.Min(120,glide/16));for(int step=1;step<=steps;step++){CheckCancellation();double t=(double)step/steps,eased=t*t*(3-2*t);if(!SetCursorPos(start.x+(int)Math.Round((x-start.x)*eased),start.y+(int)Math.Round((y-start.y)*eased)))throw new Exception("cursor_position_failed");Thread.Sleep(glide/steps);}}else if(!SetCursorPos(x,y))throw new Exception("cursor_position_failed");}
            if(action=="click"){uint down=Str(a,"button","left")=="right"?8u:Str(a,"button","left")=="middle"?32u:2u;for(int i=0;i<Math.Min(3,Math.Max(1,Num(a,"count",1)));i++){try{MouseInput(down);Thread.Sleep(35);}finally{MouseInput(down*2);}if(i+1<Num(a,"count",1))Thread.Sleep(60);}}
            else if(action=="scroll"){if(Num(a,"dy")!=0)MouseInput(0x800,Num(a,"dy"));if(Num(a,"dx")!=0)MouseInput(0x1000,Num(a,"dx"));}
            else if(action=="drag"){int tx=Num(a,"to_x"),ty=Num(a,"to_y");CheckTarget(a,false,tx,ty);int duration=Math.Max(0,Math.Min(3000,Num(a,"duration_ms",200)));var points=Arr(Get(a,"path")).Select(Obj).ToArray();foreach(var point in points)CheckTarget(a,false,Num(point,"x"),Num(point,"y"));try{MouseInput(2);if(points.Length>1){foreach(var point in points){CheckCancellation();SetCursorPos(Num(point,"x"),Num(point,"y"));Thread.Sleep(duration/points.Length);}}else for(int i=1;i<=20;i++){CheckCancellation();SetCursorPos(x+(tx-x)*i/20,y+(ty-y)*i/20);Thread.Sleep(duration/20);}}finally{MouseInput(4);}}
            else if(action=="type_text"){if(Get(a,"clear",false).Equals(true)){Chord("ctrl+a");Chord("backspace");}Type(Str(a,"text"));}
            else if(action=="press_key")Chord(Str(a,"keys"));
            else if(action=="key_down"||action=="key_up"){foreach(var name in Str(a,"keys").Split(new[]{'+',' '},StringSplitOptions.RemoveEmptyEntries)){var code=KeyCode(name);Key(code,action=="key_up");if(action=="key_down")HeldKeys.Add(code);else HeldKeys.Remove(code);}}
            else if(action!="move")throw new Exception("unknown_input_action");
            return new{ok=true,usedBackend="win32_send_input",verification=new{matched=false,status="unavailable"}};
        }finally{if(owned)mutex.ReleaseMutex();}}}
    static object Capture(IDictionary<string,object> a){var bounds=Arr(Get(a,"bounds")).Select(Convert.ToInt32).ToArray();if(bounds.Length!=4||bounds[2]<=bounds[0]||bounds[3]<=bounds[1])throw new Exception("invalid_capture_bounds");
        using(var bitmap=new Bitmap(bounds[2]-bounds[0],bounds[3]-bounds[1],PixelFormat.Format32bppArgb)){using(var graphics=Graphics.FromImage(bitmap))graphics.CopyFromScreen(bounds[0],bounds[1],0,0,bitmap.Size,CopyPixelOperation.SourceCopy);using(var stream=new MemoryStream()){bitmap.Save(stream,ImageFormat.Png);return new{png=Convert.ToBase64String(stream.ToArray()),width=bitmap.Width,height=bitmap.Height,source="gdi-fallback",capturedAtUtc=DateTime.UtcNow.ToString("o")};}}}
    static object ImageOperation(IDictionary<string,object> a){using(var image=Image.FromFile(Str(a,"path"))){var region=Arr(Get(a,"rect")).Select(Convert.ToInt32).ToArray();var r=region.Length==4?new Rectangle(region[0],region[1],region[2],region[3]):new Rectangle(0,0,image.Width,image.Height);r.Intersect(new Rectangle(0,0,image.Width,image.Height));if(r.Width<1||r.Height<1)throw new Exception("empty_image_region");
        using(var output=new Bitmap(r.Width,r.Height)){using(var graphics=Graphics.FromImage(output)){graphics.DrawImage(image,new Rectangle(0,0,r.Width,r.Height),r,GraphicsUnit.Pixel);foreach(var raw in Arr(Get(a,"strokes"))){var points=Arr(raw).Select(v=>Obj(v)).Select(v=>new PointF(Num(v,"x")-r.X,Num(v,"y")-r.Y)).ToArray();if(points.Length>1)using(var pen=new Pen(Color.FromArgb(230,60,140,255),3))graphics.DrawLines(pen,points);}}
            string target=Str(a,"output");if(target!=""){Directory.CreateDirectory(Path.GetDirectoryName(target));output.Save(target,ImageFormat.Png);}using(var stream=new MemoryStream()){output.Save(stream,ImageFormat.Png);return new{path=target,png=Convert.ToBase64String(stream.ToArray()),width=output.Width,height=output.Height,usedBackend="native_image"};}}}}
    static object Dispatch(string method,Dictionary<string,object> a){if(method=="release_input"){foreach(var key in HeldKeys.ToArray())Key(key,true);HeldKeys.Clear();return new{ok=true};}if(method=="ping")return new{ok=true};if(method=="windows")return Windows();if(method=="window")return Window(new IntPtr(Convert.ToInt64(Get(a,"hwnd",0))));if(method=="elements")return Elements(Convert.ToInt64(Get(a,"hwnd",0)),Num(a,"limit",400));if(method=="uia")return Uia(a);if(method=="input")return Act(a);if(method=="capture")return Capture(a);if(method=="image")return ImageOperation(a);if(method=="cursor"){Point p;GetCursorPos(out p);return new{x=p.x,y=p.y,hwnd=GetAncestor(WindowFromPoint(p),2).ToInt64(),foreground=GetForegroundWindow().ToInt64()};}if(method=="launch"){var child=Process.Start(new ProcessStartInfo(Str(a,"app")){UseShellExecute=true});return new{ok=child!=null,pid=child==null?0:child.Id,usedBackend="shell_execute"};}throw new Exception("unknown_method:"+method);}
    [STAThread] public static int Main(){try{SetProcessDpiAwarenessContext(new IntPtr(-4));}catch{SetProcessDPIAware();}Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);string line;
        while((line=Console.ReadLine())!=null){object id=null;try{var request=Json.Deserialize<Dictionary<string,object>>(line);id=Get(request,"id");var args=Obj(Get(request,"params"));CancelPath=Str(args,"cancelPath");CheckCancellation();var result=Str(request,"method")=="desktop_items"?ShellItems():Dispatch(Str(request,"method"),args);Console.WriteLine(Json.Serialize(new{id=id,result=result}));}catch(Exception e){Console.WriteLine(Json.Serialize(new{id=id,error=new{code=e.Message,message=e.ToString()}}));}finally{CancelPath="";}}
        foreach(var key in HeldKeys.ToArray())Key(key,true);HeldKeys.Clear();return 0;}
}
