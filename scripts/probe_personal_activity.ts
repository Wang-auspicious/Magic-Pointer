import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import type {BrowserWindow as ElectronWindow} from 'electron';

const root = process.cwd();
const outputIndex = process.argv.indexOf('--output');
const output = resolve(
  outputIndex < 0
    ? 'data/runtime/personal-activity-ui'
    : process.argv[outputIndex + 1],
);
const builtRoot = resolve(process.env.MP_PROBE_BUILD_ROOT || 'build/electron');

async function runElectron(): Promise<void> {
  const {app, BrowserWindow} = require('electron') as typeof import('electron');
  const profile =
    process.env.MP_PERSONAL_PROBE_PROFILE ||
    mkdtempSync(join(tmpdir(), 'mp-personal-ui-'));
  mkdirSync(profile, {recursive: true});
  app.setPath('userData', profile);
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.disableHardwareAcceleration();
  const failures: string[] = [];
  const checks: string[] = [];
  const errors: string[] = [];
  const screenshots: Array<Record<string, unknown>> = [];
  mkdirSync(output, {recursive: true});
  let window: ElectronWindow | undefined;
  const deadline = setTimeout(() => {
    process.stderr.write('Personal activity UI probe timed out\n');
    app.exit(1);
  }, 60000);
  try {
    await app.whenReady();
    window = new BrowserWindow({
      width: 1280,
      height: 900,
      useContentSize: true,
      frame: false,
      show: false,
      webPreferences: {
        offscreen: true,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        preload: join(root, 'scripts', 'probe_personal_activity_preload.js'),
        additionalArguments: [
          '--mp-probe-state=landing',
          '--mp-probe-theme=light',
        ],
      },
    });
    const content = window.webContents;
    content.on('console-message', event => {
      if (event.level === 'error') {
        errors.push(event.message);
      }
    });
    content.on('preload-error', (_event, preload, error) => {
      errors.push(`${preload}: ${error.message}`);
    });
    content.on('render-process-gone', (_event, details) => {
      errors.push(`renderer: ${details.reason} (${details.exitCode})`);
    });
    content.on('did-fail-load', (_event, code, message, url) => {
      errors.push(`load: ${code} ${message} ${url}`);
    });
    const evaluate = <T>(code: string): Promise<T> =>
      content.executeJavaScript(code);
    const waitFor = async (
      expression: string,
      timeout = 5000,
    ): Promise<void> => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (await evaluate<boolean>(expression)) {
          return;
        }
        await new Promise(accept => setTimeout(accept, 30));
      }
      throw new Error(`Timed out: ${expression}`);
    };
    const click = async (selector: string): Promise<void> => {
      const point = await evaluate<{x: number; y: number}>(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
        node.scrollIntoView({ block: 'center' });
        const box = node.getBoundingClientRect();
        return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
      })()`);
      content.sendInputEvent({
        type: 'mouseDown',
        button: 'left',
        clickCount: 1,
        ...point,
      });
      content.sendInputEvent({
        type: 'mouseUp',
        button: 'left',
        clickCount: 1,
        ...point,
      });
      await new Promise(accept => setTimeout(accept, 70));
    };
    const check = async (
      name: string,
      action: () => Promise<void>,
    ): Promise<void> => {
      try {
        await action();
        checks.push(name);
      } catch (error) {
        failures.push(
          `${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
        writeFileSync(
          join(
            output,
            `failure-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 72)}.png`,
          ),
          (await content.capturePage()).toPNG(),
        );
      }
    };
    const expect = async (
      expression: string,
      message: string,
    ): Promise<void> => {
      if (!(await evaluate<boolean>(expression))) {
        throw new Error(message);
      }
    };
    const capture = async (name: string, target?: string): Promise<void> => {
      await evaluate(
        `document.activeElement?.blur(); ${target ? `document.querySelector(${JSON.stringify(target)}).scrollIntoView({ block: 'start' });` : "document.querySelector('#view-personal').scrollTop = 0;"}`,
      );
      await new Promise(accept => setTimeout(accept, 120));
      const geometry = await evaluate<Record<string, unknown>>(`(() => {
        const page = document.querySelector('.personal-page'), view = document.querySelector('#view-personal');
        const box = page.getBoundingClientRect();
        return { width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme,
          bodyOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
          viewOverflow: Math.max(0, view.scrollWidth - view.clientWidth), pageOverflow: Math.max(0, page.scrollWidth - page.clientWidth),
          pageRect: { x: box.x, y: box.y, width: box.width, height: box.height },
          foreground: getComputedStyle(page).color, background: getComputedStyle(document.body).backgroundColor };
      })()`);
      if (
        [
          geometry.bodyOverflow,
          geometry.viewOverflow,
          geometry.pageOverflow,
        ].some(value => Number(value) > 1)
      ) {
        failures.push(
          `${name}: horizontal overflow ${JSON.stringify(geometry)}`,
        );
      }
      const file = join(output, `${name}.png`);
      writeFileSync(file, (await content.capturePage()).toPNG());
      screenshots.push({file, ...geometry});
    };
    const html = join(builtRoot, 'renderer', 'studio.html');
    if (!existsSync(html)) {
      throw new Error('Build the application before running this probe');
    }
    const pageUrl = pathToFileURL(html);
    pageUrl.searchParams.set('view', 'chat');
    await window.loadURL(pageUrl.href);
    await waitFor(
      `typeof window.__personalProbe === 'object' && !!document.querySelector('#nav-personal') && typeof show === 'function'`,
    );
    await evaluate('document.fonts.ready');
    await click('#nav-personal');
    await waitFor(
      `!document.querySelector('#view-personal').hidden && !!document.querySelector('.personal-page')`,
    );
    const dates = await evaluate<{today: string; yesterday: string}>(
      'window.__personalProbe.inspect()',
    );

    await check('enable and pause through actual controls', async () => {
      await click('[data-personal-action="enable"]');
      await waitFor(
        `window.__personalProbe.inspect().status.enabled && document.querySelector('[data-personal-action="pause"]')`,
      );
      await click('[data-personal-action="pause"]');
      await waitFor(
        `window.__personalProbe.inspect().status.paused && document.querySelector('.personal-status').textContent.includes('已暂停')`,
      );
      await click('[data-personal-action="pause"]');
      await waitFor(
        `!window.__personalProbe.inspect().status.paused && document.querySelector('.personal-status').textContent.includes('正在本机记录')`,
      );
    });
    await check('screen setting saves and rerenders', async () => {
      await click('.personal-settings summary');
      await click('[data-personal-setting="screenEnabled"]');
      await waitFor(
        `window.__personalProbe.inspect().status.screenEnabled && document.querySelector('[data-personal-setting="screenEnabled"]').checked`,
      );
    });
    await check('date picker changes the actual day query', async () => {
      await evaluate(
        `(() => { const picker = document.querySelector('[data-personal-date]'); picker.value = ${JSON.stringify(dates.yesterday)}; picker.dispatchEvent(new Event('change', { bubbles: true })); })()`,
      );
      await waitFor(
        `document.querySelector('.personal-file-list').textContent.includes('昨日的工作总结')`,
      );
      await expect(
        `document.querySelector('[data-personal-date]').value === ${JSON.stringify(dates.yesterday)}`,
        'selected date did not survive rendering',
      );
      await evaluate(
        `(() => { const picker = document.querySelector('[data-personal-date]'); picker.value = ${JSON.stringify(dates.today)}; picker.dispatchEvent(new Event('change', { bubbles: true })); })()`,
      );
      await waitFor(
        `document.querySelector('.personal-file-list').textContent.includes('<报价>')`,
      );
    });
    await check(
      'typing a query preserves character order and literal markup',
      async () => {
        await click('[data-personal-search]');
        for (const character of '<报价>') {
          await content.insertText(character);
          await new Promise(accept => setTimeout(accept, 25));
        }
        await expect(
          `document.querySelector('[data-personal-search]').value === '<报价>'`,
          'rerender moved the caret and reordered typed characters',
        );
        await expect(
          `document.querySelectorAll('[data-personal-file]').length === 1 && document.querySelector('.personal-file-list').textContent.includes('<报价>')`,
          'literal markup filename is missing or unfiltered',
        );
        await expect(
          `document.querySelectorAll('.personal-file-row 报价').length === 0`,
          'filename was interpreted as markup',
        );
        await capture('search-light');
        await click('[data-personal-file]');
        await expect(
          `window.__personalProbe.inspect().calls.some(call => call.action === 'openSource' && call.payload.kind === 'file' && call.payload.index === 0)`,
          'search changed the source index passed to IPC',
        );
      },
    );
    await evaluate(
      `(() => { const search = document.querySelector('[data-personal-search]'); search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
    await check('daily report generation replaces the report', async () => {
      await click('[data-personal-action="report"]');
      await waitFor(
        `document.querySelector('.personal-report').textContent.includes('最新小结已生成')`,
      );
    });
    await check('save errors are visible and retryable', async () => {
      await evaluate(`window.__personalProbe.failNext('configure')`);
      await click('[data-personal-action="pause"]');
      await waitFor(
        `document.querySelector('.personal-feedback').textContent.includes('暂时无法保存设置')`,
      );
      await expect(
        `!document.querySelector('[data-personal-action="pause"]').disabled && !window.__personalProbe.inspect().status.paused`,
        'failed save changed saved state or left the action locked',
      );
      await expect(
        `(() => { const box = document.querySelector('.personal-feedback').getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; })()`,
        'pause save error is below the viewport and cannot be seen near the action',
      );
      await capture('save-error-light');
      await click('[data-personal-action="pause"]');
      await waitFor(`window.__personalProbe.inspect().status.paused`);
      await click('[data-personal-action="pause"]');
    });
    await check(
      'screen setting failure does not display an unsaved state',
      async () => {
        await evaluate(`window.__personalProbe.failNext('configure')`);
        await click('[data-personal-setting="screenEnabled"]');
        await waitFor(
          `document.querySelector('.personal-feedback').textContent.includes('暂时无法保存设置')`,
        );
        await expect(
          `document.querySelector('[data-personal-setting="screenEnabled"]').checked === window.__personalProbe.inspect().status.screenEnabled`,
          'screen checkbox shows the opposite of the persisted setting after failure',
        );
      },
    );
    await click('[data-personal-action="refresh"]');
    await evaluate(
      `document.querySelector('.personal-settings').open = false;`,
    );
    await capture('day-light');
    await evaluate(
      `document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'dark'; document.body.setAttribute('data-ds-dark-theme', '');`,
    );
    await capture('day-dark');
    window.setContentSize(720, 720);
    await capture('day-dark-720');
    await click('.personal-settings summary');
    await capture('settings-dark-720', '.personal-settings');
    await click('.personal-settings summary');
    await evaluate(
      `document.documentElement.dataset.theme = 'light'; document.documentElement.style.colorScheme = 'light'; document.body.removeAttribute('data-ds-dark-theme');`,
    );
    await capture('day-light-720');
    await check('disable through actual control', async () => {
      await click('.personal-settings summary');
      await capture('settings-light-720', '.personal-settings');
      await click('[data-personal-action="disable"]');
      await waitFor(
        `!window.__personalProbe.inspect().status.enabled && document.querySelector('[data-personal-action="enable"]')`,
      );
    });
    if (errors.length) {
      failures.push(`consoleErrors: ${errors.join('; ')}`);
    }
    writeFileSync(
      join(output, 'result.json'),
      JSON.stringify(
        {
          usedBackend: 'electron.chromium',
          dataBackend:
            'isolated fixture; no native collection or real personal data',
          electron: process.versions.electron,
          chromium: process.versions.chrome,
          checks,
          failures,
          consoleErrors: errors,
          screenshots,
          fixtureCalls: await evaluate(
            'window.__personalProbe.inspect().calls',
          ),
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify(
        {passed: checks.length, failures, consoleErrors: errors, output},
        null,
        2,
      ),
    );
    process.exitCode = failures.length ? 1 : 0;
  } catch (error) {
    process.exitCode = 1;
    console.error(error);
    console.error(JSON.stringify(errors));
    writeFileSync(
      join(output, 'result.json'),
      JSON.stringify(
        {
          failures: [...failures, String(error)],
          consoleErrors: errors,
          screenshots,
          checks,
        },
        null,
        2,
      ),
    );
    if (window && !window.isDestroyed()) {
      try {
        writeFileSync(
          join(output, 'failed.png'),
          (await window.webContents.capturePage()).toPNG(),
        );
      } catch (captureError) {
        console.error(`No rendered frame: ${String(captureError)}`);
      }
    }
  } finally {
    clearTimeout(deadline);
    window?.destroy();
    const code = process.exitCode ?? 0;
    app.exit(Number(code));
  }
}

if (process.versions.electron) {
  void runElectron();
} else {
  const entry = join(root, 'build', 'scripts', 'probe_personal_activity.js');
  if (!existsSync(entry)) {
    throw new Error(
      'Compile the probe with: node node_modules/typescript/bin/tsc -p tsconfig.scripts-build.json',
    );
  }
  mkdirSync(output, {recursive: true});
  const temporary = mkdtempSync(join(output, '.probe-profile-'));
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MP_PERSONAL_PROBE_PROFILE: temporary,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(
      require('electron') as string,
      [entry, ...process.argv.slice(2)],
      {cwd: root, env, stdio: 'inherit'},
    );
    process.exitCode = result.status ?? 1;
  } finally {
    rmSync(temporary, {recursive: true, force: true});
  }
}
