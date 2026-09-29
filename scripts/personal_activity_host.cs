using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class PersonalActivityHost {
    const string Backend = "windows.wh-keyboard-ll+winevent";
    const int WM_WTSSESSION_CHANGE = 0x02B1;
    const int WM_QUIT = 0x0012;
    static readonly object Gate = new object();
    static readonly SortedDictionary<DateTime, Bucket> Buckets = new SortedDictionary<DateTime, Bucket>();
    static readonly ConcurrentQueue<Change> Changes = new ConcurrentQueue<Change>();
    static readonly ConcurrentQueue<Command> Commands = new ConcurrentQueue<Command>();
    static readonly AutoResetEvent Wake = new AutoResetEvent(false);
    static readonly ManualResetEvent HookReady = new ManualResetEvent(false);
    static readonly bool[] Down = new bool[1024];
    static readonly KeyboardProc KeyboardCallback = OnKeyboard;
    static readonly WinEventProc ForegroundCallback = OnForeground;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly string RunId = Guid.NewGuid().ToString("N");
    static IntPtr KeyboardHook, ForegroundHook, DesktopHook;
    static uint HookThreadId;
    static Thread HookThread;
    static Exception HookFailure;
    static DateTime OriginUtc;
    static long OriginTick, LastTick, Sequence;
    static int BatchMs = 5000, IdleMs = 60000;
    static bool Locked, Connected = true;
    static string State = "unavailable";
    static Foreground Current;

    sealed class Bucket {
        public DateTime From, To;
        public readonly long[] Keys = new long[512];
        public readonly long[] Injected = new long[512];
        public readonly Dictionary<string, AppTotal> Apps = new Dictionary<string, AppTotal>();
        public long Active, Idle, Locked, Unavailable;
    }
    sealed class AppTotal { public string appId, label; public long activeMs, activations; }
    sealed class Foreground { public long hwnd; public uint pid; public string appId, label, title; public int[] bounds; }
    sealed class Change { public long Tick; public IntPtr Hwnd; public int SessionEvent; }
    sealed class Command { public string Name, Id; public Exception Error; }
    delegate IntPtr KeyboardProc(int code, IntPtr message, IntPtr data);
    delegate void WinEventProc(IntPtr hook,uint kind,IntPtr hwnd,int objectId,int childId,uint thread,uint at);
    [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint Size, Time; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct WTSINFOEXHEADER { public uint Level, Alignment, SessionId; public int SessionState, SessionFlags; }
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetWindowsHookEx(int hook,KeyboardProc callback,IntPtr module,uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr message,IntPtr data);
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetWinEventHook(uint first,uint last,IntPtr module,WinEventProc callback,uint process,uint thread,uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread,uint message,UIntPtr wParam,IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder title,int count);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO input);
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder information,int length,out int required);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string module);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern ulong GetTickCount64();
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,uint process);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder path,ref uint length);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("wtsapi32.dll",SetLastError=true)] static extern bool WTSRegisterSessionNotification(IntPtr hwnd,uint flags);
    [DllImport("wtsapi32.dll")] static extern bool WTSUnRegisterSessionNotification(IntPtr hwnd);
    [DllImport("wtsapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool WTSQuerySessionInformation(IntPtr server,int session,int kind,out IntPtr data,out int bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);

    sealed class SessionWindow : NativeWindow {
        public SessionWindow() { CreateHandle(new CreateParams { Caption="Magic Pointer activity events", Style=0 }); }
        protected override void WndProc(ref Message message) {
            if(message.Msg==WM_WTSSESSION_CHANGE) {
                int kind=message.WParam.ToInt32();
                if(kind==7 || kind==8 || kind==2 || kind==4)Array.Clear(Down,0,Down.Length);
                Changes.Enqueue(new Change { Tick=Tick(), SessionEvent=message.WParam.ToInt32() });
                Wake.Set();
            }
            base.WndProc(ref message);
        }
    }

    static long Tick() { return (long)GetTickCount64(); }
    static DateTime Wall(long tick) { return OriginUtc.AddMilliseconds(tick-OriginTick); }
    static string Iso(DateTime time) { return time.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ",CultureInfo.InvariantCulture); }
    static void Emit(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    static Exception NativeError(string operation) { return new Exception(operation+":"+Marshal.GetLastWin32Error()); }
    static Bucket GetBucket(DateTime at) {
        DateTime day=at.ToLocalTime().Date;
        Bucket bucket;
        if(!Buckets.TryGetValue(day,out bucket)) { bucket=new Bucket { From=at, To=at }; Buckets.Add(day,bucket); }
        if(at<bucket.From)bucket.From=at;
        if(at>bucket.To)bucket.To=at;
        return bucket;
    }

    // The hook only counts press edges into a daily histogram. No character conversion,
    // ordered key events, application queries, serialization or I/O runs here.
    static IntPtr OnKeyboard(int code,IntPtr message,IntPtr data) {
        if(code>=0) {
            int kind=message.ToInt32();
            if(kind==0x100 || kind==0x104 || kind==0x101 || kind==0x105) {
                int vk=Marshal.ReadInt32(data), flags=Marshal.ReadInt32(data,8);
                if(vk>0 && vk<256) {
                    int key=vk+((flags&1)!=0?256:0), slot=key+((flags&0x10)!=0?512:0);
                    bool pressed=kind==0x100 || kind==0x104;
                    if(pressed && !Down[slot]) {
                        DateTime now=DateTime.UtcNow;
                        lock(Gate) {
                            Bucket bucket=GetBucket(now);
                            if((flags&0x10)!=0)bucket.Injected[key]++; else bucket.Keys[key]++;
                        }
                    }
                    Down[slot]=pressed;
                }
            }
        }
        return CallNextHookEx(KeyboardHook,code,message,data);
    }
    static void OnForeground(IntPtr hook,uint kind,IntPtr hwnd,int objectId,int childId,uint thread,uint at) {
        if(kind==0x20)Array.Clear(Down,0,Down.Length);
        Changes.Enqueue(new Change { Tick=Tick(), Hwnd=hwnd, SessionEvent=kind==0x20?32:0 });
        Wake.Set();
    }
    static void StartHooks() {
        HookThread=new Thread(delegate() {
            SessionWindow window=null;
            try {
                HookThreadId=GetCurrentThreadId();
                window=new SessionWindow();
                KeyboardHook=SetWindowsHookEx(13,KeyboardCallback,GetModuleHandle(null),0);
                if(KeyboardHook==IntPtr.Zero)throw NativeError("keyboard_hook_failed");
                ForegroundHook=SetWinEventHook(3,3,IntPtr.Zero,ForegroundCallback,0,0,0);
                if(ForegroundHook==IntPtr.Zero)throw NativeError("foreground_hook_failed");
                DesktopHook=SetWinEventHook(0x20,0x20,IntPtr.Zero,ForegroundCallback,0,0,0);
                if(DesktopHook==IntPtr.Zero)throw NativeError("desktop_switch_hook_failed");
                if(!WTSRegisterSessionNotification(window.Handle,0))throw NativeError("session_notifications_failed");
                HookReady.Set();
                Application.Run();
            } catch(Exception error) { HookFailure=error; HookReady.Set(); Wake.Set(); }
            finally {
                if(KeyboardHook!=IntPtr.Zero)UnhookWindowsHookEx(KeyboardHook);
                if(ForegroundHook!=IntPtr.Zero)UnhookWinEvent(ForegroundHook);
                if(DesktopHook!=IntPtr.Zero)UnhookWinEvent(DesktopHook);
                if(window!=null) { WTSUnRegisterSessionNotification(window.Handle); window.DestroyHandle(); }
            }
        });
        HookThread.IsBackground=true; HookThread.Name="MagicPointerActivityHooks";
        HookThread.SetApartmentState(ApartmentState.STA); HookThread.Start();
        if(!HookReady.WaitOne(5000))throw new Exception("activity_hook_start_timeout");
        if(HookFailure!=null)throw HookFailure;
    }
    static void StopHooks() {
        if(HookThread==null)return;
        PostThreadMessage(HookThreadId,WM_QUIT,UIntPtr.Zero,IntPtr.Zero);
        HookThread.Join(2000);
        HookThread=null;
    }
    static void ReadSessionState() {
        IntPtr data; int bytes;
        if(!WTSQuerySessionInformation(IntPtr.Zero,Process.GetCurrentProcess().SessionId,25,out data,out bytes))throw NativeError("session_state_unavailable");
        try {
            if(bytes<Marshal.SizeOf(typeof(WTSINFOEXHEADER)))throw new Exception("session_state_incomplete");
            WTSINFOEXHEADER state=(WTSINFOEXHEADER)Marshal.PtrToStructure(data,typeof(WTSINFOEXHEADER));
            if(state.Level!=1 || (state.SessionFlags!=0 && state.SessionFlags!=1))throw new Exception("session_lock_state_unknown");
            Locked=state.SessionFlags==0; Connected=state.SessionState==0;
        } finally { WTSFreeMemory(data); }
    }
    static bool DesktopAvailable() {
        IntPtr desktop=OpenInputDesktop(0,false,1);
        if(desktop==IntPtr.Zero)return false;
        try {
            StringBuilder name=new StringBuilder(128); int needed;
            return GetUserObjectInformation(desktop,2,name,name.Capacity*2,out needed) && name.ToString().Equals("Default",StringComparison.OrdinalIgnoreCase);
        } finally { CloseDesktop(desktop); }
    }
    static Foreground Describe(IntPtr hwnd) {
        if(hwnd==IntPtr.Zero)return null;
        uint pid; GetWindowThreadProcessId(hwnd,out pid);
        if(pid==0)return null;
        string executable="", label="";
        IntPtr process=OpenProcess(0x1000,false,pid);
        if(process!=IntPtr.Zero) {
            try { StringBuilder path=new StringBuilder(32768); uint length=(uint)path.Capacity; if(QueryFullProcessImageName(process,0,path,ref length))executable=path.ToString(); }
            finally { CloseHandle(process); }
        }
        if(executable.Length>0)label=Path.GetFileNameWithoutExtension(executable);
        else try { using(Process value=Process.GetProcessById((int)pid))label=value.ProcessName; } catch { return null; }
        StringBuilder title=new StringBuilder(1024); GetWindowText(hwnd,title,title.Capacity);
        RECT rect; GetWindowRect(hwnd,out rect);
        return new Foreground { hwnd=hwnd.ToInt64(), pid=pid, appId=(executable.Length>0?executable:label+".exe").ToLowerInvariant(), label=label, title=title.ToString(), bounds=new int[]{rect.Left,rect.Top,rect.Right,rect.Bottom} };
    }
    static AppTotal App(Bucket bucket,Foreground foreground) {
        AppTotal app;
        if(!bucket.Apps.TryGetValue(foreground.appId,out app)) {
            app=new AppTotal { appId=foreground.appId,label=foreground.label }; bucket.Apps.Add(app.appId,app);
        }
        return app;
    }
    static void Activate(IntPtr hwnd,long tick) {
        Foreground next=Describe(hwnd);
        if(next!=null && !Locked && Connected && (Current==null || Current.appId!=next.appId)) {
            lock(Gate)App(GetBucket(Wall(tick)),next).activations++;
        }
        Current=next;
    }
    static void AddDuration(long from,long to,string state) {
        while(to>from) {
            DateTime start=Wall(from), local=start.ToLocalTime();
            DateTime midnight=local.Date.AddDays(1).ToUniversalTime();
            long boundary=OriginTick+(long)Math.Ceiling((midnight-OriginUtc).TotalMilliseconds);
            long end=Math.Min(to,Math.Max(from+1,boundary));
            long elapsed=end-from;
            lock(Gate) {
                Bucket bucket=GetBucket(start); DateTime finish=Wall(end); if(finish>bucket.To)bucket.To=finish;
                if(state=="active") { bucket.Active+=elapsed; if(Current!=null)App(bucket,Current).activeMs+=elapsed; }
                else if(state=="idle")bucket.Idle+=elapsed;
                else if(state=="locked")bucket.Locked+=elapsed;
                else bucket.Unavailable+=elapsed;
            }
            from=end;
        }
    }
    static void Advance(long end) {
        end=Math.Max(LastTick,end);
        LASTINPUTINFO input=new LASTINPUTINFO { Size=(uint)Marshal.SizeOf(typeof(LASTINPUTINFO)) };
        if(Locked) { State="locked"; AddDuration(LastTick,end,State); }
        else if(!Connected || !DesktopAvailable() || Current==null || !GetLastInputInfo(ref input)) { State="unavailable"; AddDuration(LastTick,end,State); }
        else {
            long now=Tick();
            long lastInput=now-unchecked((uint)now-input.Time);
            long activeEnd=Math.Max(LastTick,Math.Min(end,lastInput+IdleMs));
            AddDuration(LastTick,activeEnd,"active"); AddDuration(activeEnd,end,"idle");
            State=end-lastInput>=IdleMs?"idle":"active";
        }
        LastTick=end;
    }
    static void DrainChanges() {
        Change change;
        while(Changes.TryDequeue(out change)) {
            long at=Math.Max(LastTick,Math.Min(Tick(),change.Tick));
            Advance(at);
            if(change.SessionEvent==0)Activate(change.Hwnd,at);
            else if(change.SessionEvent==7)Locked=true;
            else if(change.SessionEvent==8) { Locked=false; Connected=true; Activate(GetForegroundWindow(),at); }
            else if(change.SessionEvent==2 || change.SessionEvent==4)Connected=false;
            else if(change.SessionEvent==1 || change.SessionEvent==3) { ReadSessionState(); Activate(GetForegroundWindow(),at); }
        }
    }
    static void ObserveForeground() {
        long at=Tick(); IntPtr hwnd=GetForegroundWindow();
        if((Current==null?0:Current.hwnd)!=hwnd.ToInt64()) {
            // Foreground notifications are not guaranteed for every input-queue
            // attachment. Do not assign an unobserved switch interval to the old app.
            AddDuration(LastTick,at,Locked?"locked":"unavailable"); LastTick=at;
            Activate(hwnd,at);
        }
        Advance(at);
    }
    static string KeyName(int key) {
        int vk=key&255; bool extended=key>=256;
        if(vk>=65 && vk<=90)return "Key"+(char)vk;
        if(vk>=48 && vk<=57)return "Digit"+(char)vk;
        if(vk>=96 && vk<=105)return "Numpad"+(vk-96);
        if(vk>=112 && vk<=135)return "F"+(vk-111);
        switch(vk) {
            case 8:return "Backspace"; case 9:return "Tab"; case 13:return extended?"NumpadEnter":"Enter";
            case 16:return "Shift"; case 17:return "Control"; case 18:return "Alt"; case 19:return "Pause";
            case 20:return "CapsLock"; case 27:return "Escape"; case 32:return "Space"; case 33:return "PageUp";
            case 34:return "PageDown"; case 35:return "End"; case 36:return "Home"; case 37:return "ArrowLeft";
            case 38:return "ArrowUp"; case 39:return "ArrowRight"; case 40:return "ArrowDown"; case 44:return "PrintScreen";
            case 45:return "Insert"; case 46:return "Delete"; case 91:return "MetaLeft"; case 92:return "MetaRight";
            case 93:return "ContextMenu"; case 106:return "NumpadMultiply"; case 107:return "NumpadAdd";
            case 109:return "NumpadSubtract"; case 110:return "NumpadDecimal"; case 111:return "NumpadDivide";
            case 144:return "NumLock"; case 145:return "ScrollLock"; case 160:return "ShiftLeft"; case 161:return "ShiftRight";
            case 162:return "ControlLeft"; case 163:return "ControlRight"; case 164:return "AltLeft"; case 165:return "AltRight";
            case 186:return "Semicolon"; case 187:return "Equal"; case 188:return "Comma"; case 189:return "Minus";
            case 190:return "Period"; case 191:return "Slash"; case 192:return "Backquote"; case 219:return "BracketLeft";
            case 220:return "Backslash"; case 221:return "BracketRight"; case 222:return "Quote";
            default:return "VK_"+vk.ToString("X2");
        }
    }
    static SortedDictionary<string,long> Histogram(long[] counts) {
        SortedDictionary<string,long> result=new SortedDictionary<string,long>();
        for(int i=0;i<counts.Length;i++)if(counts[i]>0) { string key=KeyName(i); long previous; result.TryGetValue(key,out previous); result[key]=previous+counts[i]; }
        return result;
    }
    static void Flush() {
        List<Bucket> pending;
        lock(Gate) { pending=new List<Bucket>(Buckets.Values); Buckets.Clear(); }
        Foreground foreground=(State=="active" || State=="idle")?Describe(GetForegroundWindow()):null;
        foreach(Bucket bucket in pending) {
            DateTime finish=bucket.To>bucket.From?bucket.To:bucket.From.AddMilliseconds(1);
            Emit(new { type="batch", runId=RunId, sequence=++Sequence, at=Iso(bucket.From), from=Iso(bucket.From), to=Iso(finish),
                keyboard=Histogram(bucket.Keys), injectedKeyboard=Histogram(bucket.Injected), applications=new List<AppTotal>(bucket.Apps.Values),
                coverage=new { activeMs=bucket.Active,idleMs=bucket.Idle,lockedMs=bucket.Locked,unavailableMs=bucket.Unavailable },
                foreground=foreground,state=State,usedBackend=Backend });
        }
    }
    static void StartCommands() {
        Thread reader=new Thread(delegate() {
            try {
                JavaScriptSerializer parser=new JavaScriptSerializer(); string line;
                while((line=Console.ReadLine())!=null) {
                    Dictionary<string,object> message=parser.Deserialize<Dictionary<string,object>>(line); object id;
                    Commands.Enqueue(new Command { Name=Convert.ToString(message["command"]),Id=message.TryGetValue("id",out id)?Convert.ToString(id):"" }); Wake.Set();
                }
                Commands.Enqueue(new Command { Name="stop" }); Wake.Set();
            } catch(Exception error) { Commands.Enqueue(new Command { Error=error }); Wake.Set(); }
        });
        reader.IsBackground=true; reader.Name="MagicPointerActivityCommands"; reader.Start();
    }
    [STAThread] public static int Main(string[] args) {
        Console.OutputEncoding=new UTF8Encoding(false);
        try {
            for(int i=0;i<args.Length;i+=2) {
                if(i+1>=args.Length)throw new Exception("activity_argument_value_missing");
                if(args[i]=="--batch-ms")BatchMs=int.Parse(args[i+1],CultureInfo.InvariantCulture);
                else if(args[i]=="--idle-ms")IdleMs=int.Parse(args[i+1],CultureInfo.InvariantCulture);
                else throw new Exception("activity_unknown_argument:"+args[i]);
            }
            if(BatchMs<250 || BatchMs>60000 || IdleMs<250)throw new Exception("activity_invalid_interval");
            SetProcessDPIAware();
            OriginUtc=DateTime.UtcNow; OriginTick=Tick(); LastTick=OriginTick;
            ReadSessionState(); StartHooks(); Activate(GetForegroundWindow(),OriginTick); Advance(Tick());
            StartCommands();
            Emit(new { type="ready", runId=RunId,pid=Process.GetCurrentProcess().Id,usedBackend=Backend,batchMs=BatchMs,idleAfterMs=IdleMs,keyCounting="keydown-edges-excluding-injected",state=State });
            long nextBatch=Tick()+BatchMs;
            while(true) {
                Wake.WaitOne((int)Math.Max(1,Math.Min(1000,nextBatch-Tick())));
                if(HookFailure!=null)throw HookFailure;
                DrainChanges(); ObserveForeground();
                Command command;
                while(Commands.TryDequeue(out command)) {
                    if(command.Error!=null)throw command.Error;
                    if(command.Name=="stop") { StopHooks(); DrainChanges(); ObserveForeground(); Flush(); Emit(new {type="stopped"}); return 0; }
                    if(command.Name=="flush") { Flush(); Emit(new {type="flushed",id=command.Id}); nextBatch=Tick()+BatchMs; }
                    else throw new Exception("activity_unknown_command:"+command.Name);
                }
                if(Tick()>=nextBatch) { Flush(); nextBatch=Tick()+BatchMs; }
            }
        } catch(Exception error) {
            try { Emit(new {type="error",code="personal_activity_native_failed",message=error.Message}); } catch { }
            return 1;
        } finally { StopHooks(); }
    }
}
