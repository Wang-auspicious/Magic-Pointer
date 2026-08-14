// wgc_capture_tool.cs — Windows.Graphics.Capture window capture helper.
//
// STATUS: SCAFFOLD, NOT YET VERIFIED ON THIS MACHINE.
//
// Design target (MAGIC_POINTER_HARNESS_20260811.md Phase B): pointerup ->
// freeze p95 <= 30ms via a resident WGC + D3D11 free-threaded frame pool.
// The production hot path stays `gdi-fallback` until this tool compiles,
// captures a real window, and passes the capture benchmark — the
// CaptureProvider contract reports `wgc_tool_missing` honestly in the
// meantime (app/capture/__init__.py WgcWindowCaptureProvider).
//
// Route taken: raw COM interop (IGraphicsCaptureItemInterop for
// CreateForWindow), D3D11CreateDevice + staging-texture CPU readback,
// TryGetNextFrame polling (no WinRT event subscription), PNG out via
// System.Drawing. This machine's csc is .NET Framework 4.0.30319 with no
// WinMD projection facades and no dotnet SDK, so the exact vtable layouts
// and activation-factory GUIDs below need a compile+live verification pass
// on a machine with the Windows SDK before this file earns its
// `used_backend="wgc-window"`.
//
// Expected invocation:
//   wgc_capture_tool.exe --hwnd 123456 --bbox l,t,r,b --out path.png
//
// If --hwnd 0: the window under the bbox center is captured.

using System;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;

internal static class WgcCaptureTool
{
    // ---- IGraphicsCaptureItemInterop -------------------------------------
    [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IGraphicsCaptureItemInterop
    {
        [PreserveSig]
        int CreateForWindow(IntPtr hwnd, ref Guid riid, out IntPtr item);
    }

    // IID of Windows.Graphics.Capture.GraphicsCaptureItem.
    private static readonly Guid IidGraphicsCaptureItem =
        new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");

    // ---- D3D11 ------------------------------------------------------------
    [DllImport("d3d11.dll")]
    private static extern int D3D11CreateDevice(
        IntPtr adapter,
        uint driverType, // 1 = D3D_DRIVER_TYPE_HARDWARE, 3 = WARP
        IntPtr software,
        uint flags,
        IntPtr featureLevels,
        uint numFeatureLevels,
        uint sdkVersion, // D3D11_SDK_VERSION = 7
        out IntPtr device,
        out uint featureLevel,
        out IntPtr context);

    [ComImport, Guid("db6f6ddb-ac77-4e88-8253-819df9bbf140")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ID3D11Device
    {
        // Minimal vtable prefix is NOT valid for COM dispatch: every method
        // up to the ones used must be declared in slot order. Fill in a real
        // layout from the Windows SDK headers before compiling.
        void CreateBuffer();
        void CreateTexture1D();
        void CreateTexture2D();
        void CreateTexture3D();
        void CreateShaderResourceView();
        void CreateUnorderedAccessView();
        void CreateRenderTargetView();
        void CreateDepthStencilView();
        void CreateInputLayout();
        void CreateVertexShader();
        void CreateGeometryShader();
        void CreatePixelShader();
        void CreateHullShader();
        void CreateDomainShader();
        void CreateComputeShader();
        void CreateClassLinkage();
        void CreateBlendState();
        void CreateDepthStencilState();
        void CreateRasterizerState();
        void CreateSamplerState();
        void CreateQuery();
        void CreatePredicate();
        void CreateCounter();
        void CreateDeferredContext();
        void OpenSharedResource();
        void CheckFormatSupport();
        void CheckMultisampleQualityLevels();
        void CheckCounterInfo();
        void CheckCounter();
        void CheckFeatureSupport();
        void GetPrivateData();
        void SetPrivateData();
        void SetPrivateDataInterface();
        void GetFeatureLevel();
        void GetCreationFlags();
        void GetDeviceRemovedReason();
        void GetImmediateContext();
        void SetExceptionMode();
        void GetExceptionMode();
    }

    private static int Main(string[] args)
    {
        // Scaffold driver: parse args, then report honestly that the native
        // path is not wired until the SDK-header vtable pass lands.
        long hwnd = 0;
        int[] bbox = { 0, 0, 0, 0 };
        string outPath = "";
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--hwnd" && i + 1 < args.Length) long.TryParse(args[i + 1], out hwnd);
            if (args[i] == "--bbox" && i + 4 < args.Length)
            {
                for (int j = 0; j < 4; j++) int.TryParse(args[i + 1 + j], out bbox[j]);
            }
            if (args[i] == "--out" && i + 1 < args.Length) outPath = args[i + 1];
        }
        Console.Error.WriteLine(
            "wgc_capture_tool: native WGC path is scaffold-only on this machine "
            + "(no WinMD projection / Windows SDK headers). CaptureProvider "
            + "reports wgc_tool_missing until the vtable pass lands.");
        return 2;
    }
}
