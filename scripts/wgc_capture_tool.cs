// ABI declarations are from Microsoft's win32metadata Windows SDK headers:
// windows.graphics.capture.h, windows.graphics.capture.interop.h,
// windows.graphics.directx.direct3d11.interop.h and d3d11.h.
// This helper needs only the .NET Framework compiler shipped with Windows.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal sealed class WgcCaptureTool : IDisposable
{
    [StructLayout(LayoutKind.Sequential)] struct Size { public int Width, Height; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
    [StructLayout(LayoutKind.Sequential)] struct TextureDescription {
        public uint Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CpuAccessFlags, MiscFlags;
    }
    [StructLayout(LayoutKind.Sequential)] struct MappedResource { public IntPtr Data; public uint RowPitch, DepthPitch; }
    [DllImport("combase.dll")] static extern int RoInitialize(uint type);
    [DllImport("combase.dll")] static extern void RoUninitialize();
    [DllImport("combase.dll", CharSet = CharSet.Unicode)] static extern int WindowsCreateString(string value, uint length, out IntPtr handle);
    [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr handle);
    [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr name, ref Guid iid, out IntPtr factory);
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, uint driver, IntPtr software, uint flags, IntPtr levels, uint count, uint sdk, out IntPtr device, out uint level, out IntPtr context);
    [DllImport("d3d11.dll")] static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgi, out IntPtr device);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(Point point, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int NoArgs(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetPointer(IntPtr self, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetSize(IntPtr self, out Size value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetTime(IntPtr self, out long value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetBoolean(IntPtr self, out byte value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int PutBoolean(IntPtr self, byte value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateItem(IntPtr self, IntPtr handle, ref Guid iid, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreatePool(IntPtr self, IntPtr device, int format, int buffers, Size size, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int RecreatePool(IntPtr self, IntPtr device, int format, int buffers, Size size);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateSession(IntPtr self, IntPtr item, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetInterface(IntPtr self, ref Guid iid, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void GetDescription(IntPtr self, out TextureDescription value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateTexture(IntPtr self, ref TextureDescription description, IntPtr data, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void CopyResource(IntPtr self, IntPtr destination, IntPtr source);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int MapResource(IntPtr self, IntPtr resource, uint subresource, uint kind, uint flags, out MappedResource mapped);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void UnmapResource(IntPtr self, IntPtr resource, uint subresource);

    static T Method<T>(IntPtr value, int slot) where T : class {
        return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(value), slot * IntPtr.Size), typeof(T));
    }
    static void Check(int result) { if (result < 0) Marshal.ThrowExceptionForHR(result); }
    static IntPtr Query(IntPtr value, string id) {
        var iid = new Guid(id); IntPtr result; Check(Marshal.QueryInterface(value, ref iid, out result)); return result;
    }
    static IntPtr Factory(string name, string id) {
        IntPtr text, value; Check(WindowsCreateString(name, (uint)name.Length, out text));
        try { var iid = new Guid(id); Check(RoGetActivationFactory(text, ref iid, out value)); return value; }
        finally { WindowsDeleteString(text); }
    }
    static void Release(ref IntPtr value) { if (value != IntPtr.Zero) { Marshal.Release(value); value = IntPtr.Zero; } }
    static void Close(ref IntPtr value) {
        if (value == IntPtr.Zero) return;
        IntPtr closable = IntPtr.Zero;
        try { closable = Query(value, "30d5a829-7fa4-4026-83bb-d75bae4ea99e"); Check(Method<NoArgs>(closable, 6)(closable)); }
        finally { Release(ref closable); Release(ref value); }
    }
    static bool Supported() {
        IntPtr factory = Factory("Windows.Graphics.Capture.GraphicsCaptureSession", "2224a540-5974-49aa-b232-0882536f4cb5");
        try { byte result; Check(Method<GetBoolean>(factory, 6)(factory, out result)); return result != 0; }
        finally { Release(ref factory); }
    }

    readonly object gate = new object();
    IntPtr device, context, winrtDevice, item, pool, session, latestFrame;
    Thread pump;
    volatile bool stopping;
    string epoch, failure, source;
    Size poolSize, latestSize;
    long latestTimestamp;
    int frameCount, resizeCount;

    public object Arm(Dictionary<string, object> args) {
        Dispose();
        if (!Supported()) throw new Exception("wgc_not_supported");
        epoch = Text(args, "epochId");
        if (epoch == "") throw new Exception("invalid_epoch");
        try {
            uint feature;
            Check(D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out device, out feature, out context));
            IntPtr dxgi = Query(device, "54ec77fa-1377-44e6-8c32-88fd5f44c84c");
            IntPtr inspectable = IntPtr.Zero;
            try {
                Check(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out inspectable));
                winrtDevice = Query(inspectable, "a37624ab-8d5f-4650-9d3e-9eae3d9bc670");
            } finally { Release(ref inspectable); Release(ref dxgi); }
            IntPtr interop = Factory("Windows.Graphics.Capture.GraphicsCaptureItem", "3628e81b-3cac-4c60-b7f4-23ce0e0c3356");
            var iid = new Guid("79c3f95b-31f7-4ec2-a464-632ef5d30760");
            try {
                if (Text(args, "target") == "window") {
                    var hwnd = new IntPtr(Convert.ToInt64(args["hwnd"]));
                    if (!IsWindow(hwnd)) throw new Exception("target_window_closed");
                    Check(Method<CreateItem>(interop, 3)(interop, hwnd, ref iid, out item));
                    source = "wgc-window";
                } else {
                    var values = (System.Collections.IEnumerable)args["surfaceBoundsPx"];
                    var numbers = new List<int>(); foreach (object number in values) numbers.Add(Convert.ToInt32(number));
                    var bounds = numbers.ToArray();
                    if (bounds.Length != 4 || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) throw new Exception("invalid_capture_bounds");
                    var monitor = MonitorFromPoint(new Point {X = bounds[0] + (bounds[2] - bounds[0]) / 2, Y = bounds[1] + (bounds[3] - bounds[1]) / 2}, 0);
                    var info = new MonitorInfo {Size = Marshal.SizeOf(typeof(MonitorInfo))};
                    if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info)) throw new Exception("capture_monitor_missing");
                    if (info.Monitor.Left != bounds[0] || info.Monitor.Top != bounds[1] || info.Monitor.Right != bounds[2] || info.Monitor.Bottom != bounds[3]) throw new Exception("capture_monitor_bounds_mismatch");
                    Check(Method<CreateItem>(interop, 4)(interop, monitor, ref iid, out item));
                    source = "wgc-display";
                }
            } finally { Release(ref interop); }
            Check(Method<GetSize>(item, 7)(item, out poolSize));
            IntPtr factory = Factory("Windows.Graphics.Capture.Direct3D11CaptureFramePool", "589b103f-6bbc-5df5-a991-02e28b3b66d5");
            try { Check(Method<CreatePool>(factory, 6)(factory, winrtDevice, 87, 2, poolSize, out pool)); }
            finally { Release(ref factory); }
            Check(Method<CreateSession>(pool, 10)(pool, item, out session));
            IntPtr cursor = IntPtr.Zero;
            try { cursor = Query(session, "2c39ae40-7d2e-5044-804e-8b6799d4cf9e"); Check(Method<PutBoolean>(cursor, 7)(cursor, 0)); }
            catch (COMException) { /* Cursor control was introduced after WGC. */ }
            finally { Release(ref cursor); }
            Check(Method<NoArgs>(session, 6)(session));
            stopping = false; failure = null; frameCount = 0; resizeCount = 0;
            pump = new Thread(Pump) {IsBackground = true, Name = "MagicPointer.WGC"};
            pump.Start();
            var readyUntil = Stopwatch.StartNew();
            while (readyUntil.ElapsedMilliseconds < 2500) {
                lock (gate) {
                    if (failure != null) throw new Exception("wgc_capture_failed:" + failure);
                    if (latestFrame != IntPtr.Zero) return new {armed = true, usedBackend = source, width = poolSize.Width, height = poolSize.Height};
                }
                Thread.Sleep(5);
            }
            throw new Exception("wgc_first_frame_timeout");
        } catch { Dispose(); throw; }
    }

    void Pump() {
        int initialized = RoInitialize(1);
        try {
            while (!stopping) {
                lock (gate) {
                    if (stopping) break;
                    IntPtr frame = IntPtr.Zero;
                    try {
                        Check(Method<GetPointer>(pool, 7)(pool, out frame));
                        if (frame != IntPtr.Zero) {
                            Size size; long timestamp;
                            Check(Method<GetSize>(frame, 8)(frame, out size));
                            Check(Method<GetTime>(frame, 7)(frame, out timestamp));
                            if (size.Width != poolSize.Width || size.Height != poolSize.Height) {
                                Close(ref frame); Close(ref latestFrame);
                                if (size.Width < 1 || size.Height < 1) throw new Exception("capture_target_unavailable");
                                Check(Method<RecreatePool>(pool, 6)(pool, winrtDevice, 87, 2, size));
                                poolSize = size; resizeCount++;
                            } else {
                                TextureDescription description; IntPtr texture = Texture(frame, out description);
                                Release(ref texture);
                                // WGC can deliver a new ContentSize backed by an old buffer during resize.
                                if (description.Width >= size.Width && description.Height >= size.Height) {
                                    Close(ref latestFrame); latestFrame = frame; frame = IntPtr.Zero; latestSize = size;
                                    latestTimestamp = timestamp; frameCount++;
                                }
                            }
                        }
                    } finally { Close(ref frame); }
                }
                Thread.Sleep(8);
            }
        } catch (Exception error) { lock (gate) { failure = error.Message; } }
        finally { if (initialized >= 0) RoUninitialize(); }
    }

    public object Status() { lock (gate) { return new {armed = epoch != null, usedBackend = source, frameCount, resizeCount, failure,
        pumpRunning = pump != null && pump.IsAlive,
        resourcesReleased = device == IntPtr.Zero && context == IntPtr.Zero && winrtDevice == IntPtr.Zero && item == IntPtr.Zero && pool == IntPtr.Zero && session == IntPtr.Zero && latestFrame == IntPtr.Zero,
        width = poolSize.Width, height = poolSize.Height}; } }
    public object Commit(Dictionary<string, object> args) {
        long requestedAt = Stopwatch.GetTimestamp();
        if (epoch == null) throw new Exception("epoch_not_armed");
        if (Text(args, "epochId") != epoch) throw new Exception("epoch_mismatch");
        long frozenAt; DateTime frozenAtUtc;
        lock (gate) { stopping = true; frozenAt = Stopwatch.GetTimestamp(); frozenAtUtc = DateTime.UtcNow; }
        if (pump != null) { pump.Join(); pump = null; }
        try {
            if (failure != null) throw new Exception("wgc_capture_failed:" + failure);
            if (latestFrame == IntPtr.Zero) throw new Exception("no_frame_buffered");
            double now100ns = (double)frozenAt * 10000000 / Stopwatch.Frequency;
            double ageMs = Math.Max(0, (now100ns - latestTimestamp) / 10000);
            var capturedAt = frozenAtUtc.AddMilliseconds(-ageMs).ToString("o");
            var png = Encode(latestFrame, latestSize);
            return new {png = Convert.ToBase64String(png), width = latestSize.Width, height = latestSize.Height,
                source, capturedAtUtc = capturedAt, captureLatencyMs = ageMs, frameCount, resizeCount,
                nativeFreezeMs = (double)(frozenAt - requestedAt) * 1000 / Stopwatch.Frequency,
                freezeQpc = frozenAt.ToString(), capturedQpc100ns = latestTimestamp.ToString(), usedBackend = source};
        } finally { Dispose(); }
    }

    static IntPtr Texture(IntPtr frame, out TextureDescription description) {
        IntPtr surface = IntPtr.Zero, access = IntPtr.Zero, texture = IntPtr.Zero;
        try {
            Check(Method<GetPointer>(frame, 6)(frame, out surface));
            access = Query(surface, "a9b3d012-3df2-4ee3-b8d1-8695f457d3c1");
            var iid = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
            Check(Method<GetInterface>(access, 3)(access, ref iid, out texture));
            Method<GetDescription>(texture, 10)(texture, out description);
            return texture;
        } catch { Release(ref texture); throw; }
        finally { Release(ref access); Release(ref surface); }
    }

    byte[] Encode(IntPtr frame, Size size) {
        IntPtr texture = IntPtr.Zero, staging = IntPtr.Zero;
        try {
            TextureDescription desc; texture = Texture(frame, out desc);
            if (desc.Width < size.Width || desc.Height < size.Height) throw new Exception("wgc_frame_size_mismatch:" + size.Width + "x" + size.Height + ":" + desc.Width + "x" + desc.Height);
            desc.Usage = 3; desc.BindFlags = 0; desc.CpuAccessFlags = 0x20000; desc.MiscFlags = 0;
            Check(Method<CreateTexture>(device, 5)(device, ref desc, IntPtr.Zero, out staging));
            Method<CopyResource>(context, 47)(context, staging, texture);
            MappedResource mapped; Check(Method<MapResource>(context, 14)(context, staging, 0, 1, 0, out mapped));
            try {
                using (var bitmap = new Bitmap(size.Width, size.Height, PixelFormat.Format32bppArgb)) {
                    var data = bitmap.LockBits(new Rectangle(0, 0, size.Width, size.Height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                    try {
                        var row = new byte[size.Width * 4];
                        for (int y = 0; y < size.Height; y++) {
                            Marshal.Copy(IntPtr.Add(mapped.Data, checked(y * (int)mapped.RowPitch)), row, 0, row.Length);
                            Marshal.Copy(row, 0, IntPtr.Add(data.Scan0, y * data.Stride), row.Length);
                        }
                    } finally { bitmap.UnlockBits(data); }
                    using (var stream = new MemoryStream()) { bitmap.Save(stream, ImageFormat.Png); return stream.ToArray(); }
                }
            } finally { Method<UnmapResource>(context, 15)(context, staging, 0); }
        } finally { Release(ref staging); Release(ref texture); }
    }

    public void Dispose() {
        stopping = true;
        if (pump != null) { pump.Join(); pump = null; }
        lock (gate) {
            Close(ref latestFrame); Close(ref session); Close(ref pool); Release(ref item);
            Release(ref winrtDevice); Release(ref context); Release(ref device);
            epoch = null; failure = null;
        }
    }
    static string Text(Dictionary<string, object> value, string key) { object result; return value.TryGetValue(key, out result) ? Convert.ToString(result) : ""; }
    [MTAThread] static int Main() {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        int initialized = RoInitialize(1);
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        var json = new JavaScriptSerializer {MaxJsonLength = 128 * 1024 * 1024};
        using (var capture = new WgcCaptureTool()) {
            try {
                string line;
                while ((line = Console.ReadLine()) != null) {
                    object id = null; bool quit = false;
                    try {
                        var request = json.Deserialize<Dictionary<string, object>>(line); id = request["id"];
                        var args = request.ContainsKey("params") ? (Dictionary<string, object>)request["params"] : new Dictionary<string, object>();
                        object result;
                        switch (Text(request, "method")) {
                            case "ping": result = new {supported = Supported(), usedBackend = "windows.graphics.capture"}; break;
                            case "arm": result = capture.Arm(args); break;
                            case "status": result = capture.Status(); break;
                            case "commit": result = capture.Commit(args); break;
                            case "cancel": if (Text(args, "epochId") == "" || Text(args, "epochId") == capture.epoch) capture.Dispose(); result = new {cancelled = true}; break;
                            case "shutdown": capture.Dispose(); result = new {shutdown = true}; quit = true; break;
                            default: throw new Exception("unknown_method");
                        }
                        Console.WriteLine(json.Serialize(new {id, result}));
                    } catch (Exception error) { Console.WriteLine(json.Serialize(new {id, error = new {code = error.Message, hresult = error.HResult}})); }
                    if (quit) break;
                }
            } finally { if (initialized >= 0) RoUninitialize(); }
        }
        return 0;
    }
}
