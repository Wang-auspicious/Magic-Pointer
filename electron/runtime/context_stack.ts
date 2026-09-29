import {nativeRequest, type DesktopRecord, type Rect} from './desktop';

/** Context stack (docs/design/2026-09-24-context-stack.md): OS, latent semantics, backing source, interaction and pixel layers fused per window. */

export type Framework =
  | 'flutter'
  | 'qt'
  | 'chromium'
  | 'electron'
  | 'webview2'
  | 'winui'
  | 'uwp'
  | 'wpf'
  | 'winforms'
  | 'java'
  | 'unity'
  | 'win32'
  | 'unknown';
export interface SurfaceFacts {
  hwnd: number;
  pid: number;
  exe: string;
  product: string;
  version: string;
  className: string;
  modules: string[];
  childClasses: string[];
  gui: {
    focusHwnd: number;
    focusClass: string;
    activeHwnd: number;
    caret: Rect | null;
    inMenu: boolean;
    moving: boolean;
  } | null;
  framework: Framework;
  frameworks: Framework[];
  frameworkEvidence: string[];
  note: string;
}

interface FrameworkRule {
  framework: Framework;
  module?: RegExp;
  windowClass?: RegExp;
  childClass?: RegExp;
  childNeedsModule?: boolean;
}
// Ordered by which layer draws the content the user sees: an embedded web view or engine wins over the host shell it sits in.
const RULES: FrameworkRule[] = [
  {
    framework: 'flutter',
    module: /^flutter_windows\.dll$/i,
    windowClass: /^FLUTTER_/,
    childClass: /^FLUTTERVIEW$/,
  },
  {
    framework: 'qt',
    module: /^Qt[56]Core[d]?\.dll$/i,
    windowClass: /^Qt[56]\d*QWindow/,
  },
  {framework: 'chromium', module: /^(chrome|msedge|libcef)\.dll$/i},
  {
    framework: 'webview2',
    module: /^(EmbeddedBrowserWebView|WebView2Loader)\.dll$/i,
    childClass: /^(Chrome_RenderWidgetHostHWND|WRY_WEBVIEW)$/,
    childNeedsModule: true,
  },
  {
    framework: 'winui',
    module: /^Microsoft\.UI\.Xaml\.dll$/i,
    windowClass: /^WinUIDesktopWin32WindowClass$/,
  },
  {
    framework: 'uwp',
    module: /^Windows\.UI\.Xaml\.dll$/i,
    windowClass: /^(Windows\.UI\.Core\.CoreWindow|ApplicationFrameWindow)$/,
  },
  {
    framework: 'wpf',
    module: /^(PresentationFramework(\.ni)?\.dll|wpfgfx_\w+\.dll)$/i,
    windowClass: /^HwndWrapper\[/,
  },
  {
    framework: 'winforms',
    module: /^System\.Windows\.Forms(\.ni)?\.dll$/i,
    windowClass: /^WindowsForms\d+\./,
  },
  {framework: 'java', module: /^(jvm|awt)\.dll$/i, windowClass: /^SunAwt/},
  {
    framework: 'unity',
    module: /^UnityPlayer\.dll$/i,
    windowClass: /^UnityWndClass$/,
  },
  {
    framework: 'win32',
    windowClass: /^#32770$/,
    childClass:
      /^(SysListView32|SysTreeView32|Edit|RichEdit\w*|SHELLDLL_DefView|DirectUIHWND)$/,
  },
];

/**
 * Modules are per process, but one process can host several stacks (Explorer loads WinUI for the taskbar and draws the desktop with a
 * Win32 list view), so evidence from this window's own class or children outranks a module that is merely loaded.
 */
export function classifyFramework(input: {
  exe: string;
  modules: string[];
  className: string;
  childClasses?: string[];
}): {framework: Framework; frameworks: Framework[]; evidence: string[]} {
  const byWindow: Array<[Framework, string]> = [];
  const byModule: Array<[Framework, string]> = [];
  const children = input.childClasses || [];
  // Electron ships Chromium statically inside its own exe: a Chromium window class with no browser DLL is an Electron app.
  if (
    /^Chrome_WidgetWin_\d$/.test(input.className) &&
    !input.modules.some(name => /^(chrome|msedge|libcef)\.dll$/i.test(name))
  ) {
    byWindow.push(['electron', `class ${input.className} without chrome.dll`]);
  }
  for (const rule of RULES) {
    const module =
      rule.module && input.modules.find(name => rule.module!.test(name));
    const child =
      rule.childClass && (!rule.childNeedsModule || module)
        ? children.find(name => rule.childClass!.test(name))
        : undefined;
    if (rule.windowClass?.test(input.className)) {
      byWindow.push([rule.framework, `class ${input.className}`]);
    } else if (child) {
      byWindow.push([
        rule.framework,
        `child ${child}${module ? ` + ${module}` : ''}`,
      ]);
    } else if (module) {
      byModule.push([rule.framework, module]);
    }
  }
  const ranked = [...byWindow, ...byModule];
  if (!ranked.length) {
    ranked.push([
      input.exe ? 'win32' : 'unknown',
      input.exe ? 'no UI framework module' : 'process unreadable',
    ]);
  }
  return {
    framework: ranked[0][0],
    frameworks: ranked.map(row => row[0]),
    evidence: ranked.map(row => row[1]),
  };
}

/** L0: identity, framework, focus and caret of a window, from the OS alone (no UIA, no pixels; tens of milliseconds). */
export async function surfaceFacts(
  hwnd: number,
  signal?: AbortSignal,
): Promise<SurfaceFacts> {
  const raw = await nativeRequest<DesktopRecord>(
    'surface_facts',
    {hwnd},
    signal,
    5000,
  );
  const modules: string[] = raw.modules || [];
  const childClasses: string[] = raw.childClasses || [];
  const className = String(raw.className || '');
  const exe = String(raw.exe || '');
  const classified = classifyFramework({exe, modules, className, childClasses});
  return {
    hwnd: Number(raw.hwnd),
    pid: Number(raw.pid),
    exe,
    product: String(raw.product || ''),
    version: String(raw.version || ''),
    className,
    modules,
    childClasses,
    gui: raw.gui || null,
    framework: classified.framework,
    frameworks: classified.frameworks,
    frameworkEvidence: classified.evidence,
    note: String(raw.note || ''),
  };
}
