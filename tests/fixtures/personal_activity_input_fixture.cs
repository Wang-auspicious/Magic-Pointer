using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class PersonalActivityInputFixture {
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int x,y; public uint data, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public KEYBDINPUT key; [FieldOffset(0)] public MOUSEINPUT mouse; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd,int command);
    [DllImport("dwmapi.dll")] static extern int DwmFlush();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a,uint b,bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] inputs,int size);
    delegate bool EnumWindow(IntPtr hwnd,IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback,IntPtr data);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd,int message,IntPtr wParam,IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint size,time; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO value);
    static uint IdleAge() { LASTINPUTINFO value=new LASTINPUTINFO {size=8}; return GetLastInputInfo(ref value)?unchecked((uint)Environment.TickCount-value.time):0; }
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static void Emit(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    static INPUT Key(ushort vk,bool up) { return new INPUT { type=1, data=new UNION { key=new KEYBDINPUT { vk=vk, flags=up?2u:0u } } }; }

    [STAThread] public static void Main() {
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        SetProcessDPIAware();
        IntPtr previous = GetForegroundWindow();
        Form form = new Form { Text="Magic Pointer personal activity acceptance", Size=new Size(720,360), StartPosition=FormStartPosition.CenterScreen };
        TextBox input = new TextBox { Multiline=true, Dock=DockStyle.Fill, Font=new Font("Consolas",14), AcceptsReturn=true };
        form.Controls.Add(input);
        form.Controls.Add(new Label { Dock=DockStyle.Top,Height=110,Padding=new Padding(12),Font=new Font("Arial",14,FontStyle.Bold),BackColor=Color.White,Text="ACTIVITY SCREEN WITNESS 7392" });
        int enterDowns=0, aDowns=0;
        input.KeyDown += delegate(object sender,KeyEventArgs e) { if(e.KeyCode==Keys.Enter)enterDowns++; if(e.KeyCode==Keys.A)aDowns++; };
        form.Shown += delegate {
            ShowWindow(form.Handle,5);
            form.Refresh(); input.Refresh(); DwmFlush();
            Emit(new {type="ready",hwnd=form.Handle.ToInt64(),pid=System.Diagnostics.Process.GetCurrentProcess().Id,left=form.Left,top=form.Top,width=form.Width,height=form.Height,visible=IsWindowVisible(form.Handle),minimized=IsIconic(form.Handle)});
            Thread commands = new Thread(delegate() {
                string line;
                while((line=Console.ReadLine())!=null) {
                    string command=line;
                    form.BeginInvoke((Action)delegate {
                        try {
                            if(command=="stop") { form.Close(); return; }
                            if(command=="release-enter") {
                                INPUT[] release={Key(13,true)}; SendInput(1,release,Marshal.SizeOf(typeof(INPUT)));
                                Emit(new {type="sent",count=1,foreground=GetForegroundWindow().ToInt64()}); return;
                            }
                            if(command=="exercise" || command=="hold-enter") {
                                uint pid; uint foregroundThread=GetWindowThreadProcessId(GetForegroundWindow(),out pid); uint ownThread=GetCurrentThreadId();
                                bool attached=foregroundThread!=0 && foregroundThread!=ownThread && AttachThreadInput(ownThread,foregroundThread,true);
                                try { SetForegroundWindow(form.Handle); form.Activate(); input.Focus(); }
                                finally { if(attached)AttachThreadInput(ownThread,foregroundThread,false); }
                                if(GetForegroundWindow()!=form.Handle)throw new Exception("fixture_not_foreground:no_keys_sent");
                                form.Refresh(); input.Refresh(); DwmFlush();
                                INPUT[] events=command=="hold-enter"?new INPUT[]{Key(13,false)}:
                                    new INPUT[]{Key(13,false),Key(13,false),Key(13,true),Key(13,false),Key(13,true),Key(65,false),Key(65,false),Key(65,true)};
                                uint sent=SendInput((uint)events.Length,events,Marshal.SizeOf(typeof(INPUT)));
                                if(sent!=events.Length)throw new Exception("fixture_sendinput:"+Marshal.GetLastWin32Error());
                                Emit(new {type="sent",count=sent,foreground=form.Handle.ToInt64()});
                            } else if(command.StartsWith("session:")) {
                                string[] parts=command.Split(':'); uint expected=uint.Parse(parts[1]); int kind=int.Parse(parts[2]); IntPtr target=IntPtr.Zero;
                                EnumWindows(delegate(IntPtr hwnd,IntPtr data) { uint pid; GetWindowThreadProcessId(hwnd,out pid); if(pid==expected){target=hwnd;return false;}return true; },IntPtr.Zero);
                                if(target==IntPtr.Zero || !PostMessage(target,0x02B1,(IntPtr)kind,IntPtr.Zero))throw new Exception("fixture_session_notification_failed");
                                Emit(new {type="session-posted",kind=kind});
                            } else if(command=="inspect") Emit(new {type="inspect",enterDowns=enterDowns,aDowns=aDowns,text=input.Text,foreground=GetForegroundWindow().ToInt64(),idleMs=IdleAge()});
                        } catch(Exception error) { Emit(new {type="error",message=error.Message}); }
                    });
                }
                try { form.BeginInvoke((Action)delegate { form.Close(); }); } catch { }
            });
            commands.IsBackground=true; commands.Start();
        };
        form.FormClosed += delegate { if(GetForegroundWindow()==form.Handle && previous!=IntPtr.Zero)SetForegroundWindow(previous); };
        Application.Run(form);
    }
}
