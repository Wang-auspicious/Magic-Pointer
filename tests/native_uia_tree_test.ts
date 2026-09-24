import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { listElements, readElement, closeDesktop, DesktopActionSession } from '../electron/runtime/desktop';

const windows = process.platform !== 'win32';

// A real WPF window (native UIA provider, like Chromium/Electron/WinUI) with many buttons; `hangAfterMs` blocks its UI thread so UIA calls into it stop returning.
async function openForm(buttons: number, hangAfterMs = 0): Promise<{ hwnd: number; child: ChildProcess }> {
  const script = `Add-Type -AssemblyName PresentationFramework
$w=New-Object Windows.Window;$w.Title='mp-uia-tree-${process.pid}-${buttons}';$w.Width=900;$w.Height=700;$w.WindowStartupLocation='Manual';$w.Left=40;$w.Top=40
$p=New-Object Windows.Controls.WrapPanel;$s=New-Object Windows.Controls.ScrollViewer;$s.Content=$p;$w.Content=$s
for($i=1;$i -le ${buttons};$i++){$b=New-Object Windows.Controls.Button;$b.Content="item-$i";$b.Width=80;$b.Height=24;[void]$p.Children.Add($b)}
$w.Add_ContentRendered({[Console]::WriteLine('hwnd='+(New-Object Windows.Interop.WindowInteropHelper $w).Handle.ToInt64());if(${hangAfterMs} -gt 0){$t=New-Object Windows.Threading.DispatcherTimer;$t.Interval=[TimeSpan]::FromMilliseconds(${Math.max(1, hangAfterMs)});$t.Add_Tick({$t.Stop();Start-Sleep -Seconds 20});$t.Start()}})
[void]$w.ShowDialog()`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const hwnd = await new Promise<number>((resolve, reject) => {
    let output = '';
    child.stdout!.on('data', chunk => { output += String(chunk); const match = /hwnd=(\d+)/.exec(output); if (match) resolve(Number(match[1])); });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`form exited early: ${code} ${output}`)));
  });
  return { hwnd, child };
}

test('native UIA tree reads a whole large window instead of stopping at 400 elements', { skip: windows, timeout: 60000 }, async () => {
  const { hwnd, child } = await openForm(450);
  try {
    await listElements(hwnd);
    const started = Date.now();
    const elements = await listElements(hwnd);
    const elapsed = Date.now() - started;
    const names = new Set(elements.filter(row => row.role === 'button').map(row => row.name));
    for (let i = 1; i <= 450; i++) assert.ok(names.has(`item-${i}`), `item-${i} missing from ${elements.length} rows (${elements.truncated}): ${JSON.stringify(elements.map(row => [row.role, row.name]))}`);
    assert.equal(elements.truncated, undefined);
    assert.ok(elements.length > 400, `${elements.length} rows`);
    assert.ok(elements.every(row => Array.isArray(row.patterns) && Array.isArray(row.runtime_id) && row.runtime_id.length > 0));
    assert.ok(elements.find(row => row.name === 'item-1')!.patterns.includes('Invoke'));
    assert.ok(elapsed < 4000, `walk took ${elapsed}ms`);
  } finally { child.kill(); closeDesktop(); }
});

test('native UIA tree says when it stopped early instead of passing a partial tree off as complete', { skip: windows, timeout: 60000 }, async () => {
  const { hwnd, child } = await openForm(120);
  try {
    const elements = await listElements(hwnd, undefined, 50);
    assert.equal(elements.length, 50);
    assert.equal(elements.truncated, 'limit');
  } finally { child.kill(); closeDesktop(); }
});

test('a window whose UI thread hangs returns what was read before the deadline and keeps the host alive', { skip: windows, timeout: 60000 }, async () => {
  const { hwnd, child } = await openForm(40, 300);
  try {
    await new Promise(resolve => setTimeout(resolve, 800));
    const started = Date.now();
    const elements = await listElements(hwnd);
    assert.ok(Date.now() - started < 8000, `walk blocked for ${Date.now() - started}ms`);
    assert.equal(elements.truncated, 'deadline');
    const again = await listElements(hwnd).catch(error => error as Error);
    assert.ok(!(again instanceof Error) || !/native_desktop_timeout/.test(again.message), 'host must still answer after an abandoned walk');
  } finally { child.kill(); closeDesktop(); }
});

test('acting on an observed ref re-reads that element instead of walking the whole tree again', { skip: windows, timeout: 60000 }, async () => {
  const { hwnd, child } = await openForm(300);
  try {
    const desktop = new DesktopActionSession('uia-tree-ref');
    const snapshot = await desktop.observe({ hwnd, mode: 'ax' });
    const target = snapshot.elements.find(row => row.name === 'item-250')!;
    assert.ok(target, 'item-250 observed');
    let walks = 0;
    const walk = desktop.observation.elements;
    desktop.observation.elements = async (...args: Parameters<typeof walk>) => { walks++; return walk(...args); };
    const started = Date.now();
    await desktop.requireSnapshot(snapshot.snapshot_id, undefined, [target.index]);
    assert.equal(walks, 0);
    assert.ok(Date.now() - started < 1000, `staleness check took ${Date.now() - started}ms`);
    const fresh = await readElement(target);
    assert.deepEqual([fresh.name, fresh.role, fresh.rect, fresh.patterns, fresh.index], [target.name, target.role, target.rect, target.patterns, target.index]);
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    await assert.rejects(desktop.requireSnapshot(snapshot.snapshot_id, undefined, [target.index]), /stale|changed|window/);
  } finally { child.kill(); closeDesktop(); }
});
