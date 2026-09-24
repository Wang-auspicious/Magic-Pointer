import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeDesktop } from '../electron/runtime/desktop';
import { classifyFramework, surfaceFacts } from '../electron/runtime/context_stack';

const windows = process.platform !== 'win32';

async function openWindow(kind: 'wpf' | 'winforms'): Promise<{ hwnd: number; child: ChildProcess }> {
  const script = kind === 'wpf'
    ? `Add-Type -AssemblyName PresentationFramework
$w=New-Object Windows.Window;$w.Title='mp-context-wpf';$w.Width=400;$w.Height=300;$t=New-Object Windows.Controls.TextBox;$t.Text='hello';$w.Content=$t
$w.Add_ContentRendered({$t.Focus();[Console]::WriteLine('hwnd='+(New-Object Windows.Interop.WindowInteropHelper $w).Handle.ToInt64())});[void]$w.ShowDialog()`
    : `Add-Type -AssemblyName System.Windows.Forms
$f=New-Object Windows.Forms.Form;$f.Text='mp-context-winforms';$b=New-Object Windows.Forms.TextBox;$b.Text='hello';$f.Controls.Add($b)
$f.Add_Shown({$f.Activate();$b.Focus();[Console]::WriteLine('hwnd='+$f.Handle.ToInt64())});[Windows.Forms.Application]::Run($f)`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const hwnd = await new Promise<number>((resolve, reject) => {
    let output = '';
    child.stdout!.on('data', chunk => { output += String(chunk); const match = /hwnd=(\d+)/.exec(output); if (match) resolve(Number(match[1])); });
    child.once('exit', code => reject(new Error(`window exited early: ${code} ${output}`)));
  });
  return { hwnd, child };
}

test('framework fingerprint names the UI stack from loaded modules and window classes', () => {
  const cases: [Parameters<typeof classifyFramework>[0], string][] = [
    [{ exe: 'Weixin.exe', modules: ['Qt5Core.dll', 'Qt5Gui.dll', 'Qt5Widgets.dll'], className: 'Qt51514QWindowIcon' }, 'qt'],
    [{ exe: 'app.exe', modules: ['Qt6Core.dll', 'Qt6Quick.dll'], className: 'Qt6QWindowIcon' }, 'qt'],
    [{ exe: 'SunloginClient.exe', modules: ['flutter_windows.dll'], className: 'FLUTTER_RUNNER_WIN32_WINDOW' }, 'flutter'],
    [{ exe: 'Obsidian.exe', modules: ['ffmpeg.dll', 'libEGL.dll', 'd3dcompiler_47.dll'], className: 'Chrome_WidgetWin_1' }, 'electron'],
    [{ exe: 'chrome.exe', modules: ['chrome.dll', 'chrome_elf.dll'], className: 'Chrome_WidgetWin_1' }, 'chromium'],
    [{ exe: 'msedge.exe', modules: ['msedge.dll'], className: 'Chrome_WidgetWin_1' }, 'chromium'],
    [{ exe: 'Spotify.exe', modules: ['libcef.dll'], className: 'Chrome_WidgetWin_0' }, 'chromium'],
    [{ exe: 'clash-verge.exe', modules: ['WebView2Loader.dll'], className: 'Tauri Window' }, 'webview2'],
    [{ exe: 'Notepad.exe', modules: ['Microsoft.UI.Xaml.dll'], className: 'Notepad' }, 'winui'],
    [{ exe: 'app.exe', modules: ['PresentationFramework.ni.dll', 'wpfgfx_cor3.dll'], className: 'HwndWrapper[app;;]' }, 'wpf'],
    [{ exe: 'app.exe', modules: ['System.Windows.Forms.ni.dll'], className: 'WindowsForms10.Window.8.app.0.1' }, 'winforms'],
    [{ exe: 'idea64.exe', modules: ['jvm.dll', 'awt.dll'], className: 'SunAwtFrame' }, 'java'],
    [{ exe: 'game.exe', modules: ['UnityPlayer.dll'], className: 'UnityWndClass' }, 'unity'],
    [{ exe: 'notepad.exe', modules: ['comctl32.dll'], className: 'Notepad' }, 'win32'],
    [{ exe: 'explorer.exe', modules: ['Microsoft.UI.Xaml.dll', 'Windows.UI.Xaml.dll', 'comctl32.dll'], className: 'Progman', childClasses: ['SHELLDLL_DefView', 'SysListView32'] }, 'win32'],
    [{ exe: 'App.exe', modules: ['Microsoft.UI.Xaml.dll'], className: 'WinUIDesktopWin32WindowClass' }, 'winui'],
  ];
  for (const [input, expected] of cases) assert.equal(classifyFramework(input).framework, expected, JSON.stringify(input));
  const embedded = classifyFramework({ exe: 'app.exe', modules: ['PresentationFramework.dll', 'EmbeddedBrowserWebView.dll'], className: 'HwndWrapper[app;;]', childClasses: ['Chrome_WidgetWin_0', 'Chrome_RenderWidgetHostHWND'] });
  assert.equal(embedded.framework, 'webview2');
  assert.ok(embedded.frameworks.includes('wpf'), 'a host framework under an embedded web view is kept');
  assert.ok(embedded.evidence.some(item => /EmbeddedBrowserWebView/.test(item)));
});

test('surface facts read identity, framework, focus and caret from the OS without touching UIA', { skip: windows, timeout: 60000 }, async () => {
  for (const kind of ['wpf', 'winforms'] as const) {
    const { hwnd, child } = await openWindow(kind);
    try {
      const started = Date.now();
      const facts = await surfaceFacts(hwnd);
      const elapsed = Date.now() - started;
      assert.equal(facts.framework, kind, JSON.stringify(facts.frameworkEvidence));
      assert.match(facts.exe, /powershell\.exe$/i);
      assert.ok(facts.pid > 0 && facts.version, 'process version read from the executable');
      assert.ok(facts.modules.length > 10);
      if (kind === 'winforms') assert.ok(facts.childClasses.some(name => /EDIT/i.test(name)), JSON.stringify(facts.childClasses));
      assert.ok(elapsed < 3000, `facts took ${elapsed}ms`);
    } finally { child.kill(); closeDesktop(); }
  }
});
