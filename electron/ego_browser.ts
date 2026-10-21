import {spawn} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const resultPrefix = 'MP_EGO_RESULT=';
export interface EgoBrowserResult {
  ok: boolean;
  usedBackend: 'ego-lite';
  spaceId?: number;
  page?: string;
  url?: string;
  title?: string;
  snapshot?: string;
  selectedText?: string;
  verification?: {matched: boolean};
  [key: string]: unknown;
}

export function egoBrowserExecutable(): string {
  if (process.env.MAGIC_POINTER_EGO_BROWSER) {
    return process.env.MAGIC_POINTER_EGO_BROWSER;
  }
  const roots = [
    process.env.LOCALAPPDATA,
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
  ].filter(Boolean) as string[];
  const candidates = [
    path.join(
      process.env.USERPROFILE || process.env.HOME || '',
      '.local',
      'bin',
      process.platform === 'win32' ? 'ego-browser.exe' : 'ego-browser',
    ),
    ...roots.flatMap(root => [
      path.join(root, 'ego lite', 'Application', 'ego-browser.exe'),
      path.join(root, 'ego', 'Application', 'ego-browser.exe'),
    ]),
  ];
  for (const root of roots) {
    const application = path.join(root, 'Citro Labs', 'ego', 'Application');
    if (existsSync(application)) {
      candidates.push(
        ...readdirSync(application)
          .filter(name => /^\d+\./.test(name))
          .sort((a, b) => b.localeCompare(a, undefined, {numeric: true}))
          .map(version => path.join(application, version, 'ego-browser.exe')),
      );
    }
  }
  const installed = candidates.find(file => file && existsSync(file));
  return (
    installed ||
    (process.platform === 'win32' ? 'ego-browser.exe' : 'ego-browser')
  );
}

export function buildEgoScript(
  space: string,
  request: Record<string, unknown>,
): string {
  if (request.operation === 'open' || request.operation === 'browse') {
    const url = new URL(String(request.url));
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Ego browser navigation requires an http(s) URL.');
    }
  }
  return `
const input = ${JSON.stringify(request)};
let actionStarted = false;
try {
  const spaceName = ${JSON.stringify(space)};
  let task;
  if (input.operation === 'browse' || input.operation === 'resume' || input.operation === 'capture-selection') {
    const spaces = await listTaskSpaces();
    const existing = spaces.find(item => item.name === spaceName);
    if (input.operation === 'capture-selection' && !existing) throw new Error('Open the collection browser before collecting its selection.');
    if (input.operation === 'resume' && (!existing || existing.id !== input.spaceId)) throw new Error('This space does not belong to the current MP task.');
    task = existing ? (existing.ownership === 'user' ? await claimTaskSpace(existing.id) : await takeOverTaskSpace(existing.id)) : await taskSpace(spaceName);
  } else {
    task = await taskSpace(spaceName);
  }
  const result = {ok: true, usedBackend: 'ego-lite', spaceId: task.spaceId};
  if (input.operation === 'capture-selection') {
    try {
      let page = task.userPage();
      if (page && !page.label) page = await task.adopt(page);
      if (!page) {
        const active = (await task.tabs()).filter(item => item.active);
        if (active.length !== 1) throw new Error('No unique active page exists in the collection browser.');
        page = active[0].label ? task.page(active[0].label) : await task.adopt(active[0].page);
      }
      result.page = page.label;
      result.url = await page.url();
      result.title = await page.title();
      result.selectedText = await page.evaluate(() => window.getSelection()?.toString() || '');
    } finally {
      await task.handOff();
    }
  } else if (input.operation === 'pages') {
    result.pages = (await task.tabs()).map(({label, title, url, active, openedBy}) => ({label, title, url, active, openedBy}));
  } else if (input.operation === 'handoff') {
    await task.handOff();
    result.handedOff = true;
    const current = (await listTaskSpaces()).find(item => item.id === task.spaceId);
    result.verification = {matched: current?.ownership === 'agentDelegatedToUser', method: 'ego_taskspace_control', scope: 'browser_lifecycle'};
  } else if (input.operation === 'finish') {
    result.receipt = await task.finish({keep: input.keep || []});
    result.finished = true;
    result.verification = {matched: result.receipt.spaceId === task.spaceId, method: 'ego_taskspace_receipt', scope: 'browser_lifecycle'};
  } else {
    let page = task.page(input.page || 'p1');
    if (input.operation === 'browse' || input.operation === 'resume') {
      const pages = await task.pages();
      const current = task.userPage();
      page = input.page ? task.page(input.page) : current ? (current.label ? current : await task.adopt(current)) : pages[0] || await task.newPage();
    }
    if (input.operation === 'new-page') page = await task.newPage();
    if (input.operation === 'open' || input.operation === 'browse') await page.goto(input.url, {timeout: 30000});
    if (input.operation === 'act') {
      const matches = expected => {
        const nodes = document.querySelectorAll(expected.selector);
        if (nodes.length !== 1) return false;
        const node = nodes[0];
        return expected.value !== undefined ? node.value === expected.value : node.textContent.trim() === expected.text;
      };
      const alreadyMatched = input.expected ? await page.evaluate(matches, input.expected) : false;
      for (const item of alreadyMatched ? [] : input.actions) {
        actionStarted = true;
        if (item.action === 'click') await page.click(item.selector, {label: item.description || 'Magic Pointer action'});
        else if (item.action === 'fill') await page.fill(item.selector, item.value);
        else if (item.action === 'press') await page.press(item.selector, item.key);
        else if (item.action === 'select') await page.selectOption(item.selector, item.value);
        else throw new Error('Unsupported browser action: ' + item.action);
      }
      if (input.waitForSelector) await page.waitForSelector(input.waitForSelector, {timeout: 10000});
      if (input.waitForUrl) await page.waitForURL(input.waitForUrl, {timeout: 10000});
      if (input.expected) {
        await page.waitForFunction(matches, input.expected, {timeout: 10000});
        result.verification = {matched: await page.evaluate(matches, input.expected), method: 'ego_dom_readback', scope: 'application_effect', expected: input.expected};
        result.notExecuted = alreadyMatched;
      }
    }
    result.page = page.label;
    result.url = await page.url();
    result.title = await page.title();
    if (input.operation === 'screenshot') {
      const imagePath = await page.screenshot();
      const fs = await import('node:fs/promises');
      result.image = (await fs.readFile(imagePath)).toString('base64');
      result.mimeType = 'image/png';
      result.imageLabel = result.title;
    } else if (input.operation !== 'browse') {
      result.snapshot = await page.snapshot({scope: input.fullPage ? 'full_page' : 'only_within_viewport'});
    }
    if (input.operation === 'open') result.verification = {matched: result.url === new URL(input.url).href, method: 'ego_navigation_url', scope: 'page_url'};
    if (input.operation === 'new-page' || input.operation === 'resume') result.verification = {matched: !!result.page && !!result.url, method: 'ego_page_state', scope: 'browser_lifecycle'};
    if (input.operation === 'browse') await task.handOff();
  }
  console.log(${JSON.stringify(resultPrefix)} + JSON.stringify(result));
} catch (error) {
  console.log(${JSON.stringify(resultPrefix)} + JSON.stringify({ok: false, error: String(error?.message || error), mayHaveLateEffects: actionStarted || error?.mayHaveLateEffects === true, usedBackend: 'ego-lite'}));
}

`;
}

export function openCollectionBrowser(url: string): Promise<EgoBrowserResult> {
  return runEgoBrowser('Magic Pointer collection', {operation: 'browse', url});
}

export function captureCollectionBrowserSelection(): Promise<EgoBrowserResult> {
  return runEgoBrowser('Magic Pointer collection', {
    operation: 'capture-selection',
  });
}

export function parseEgoOutput(output: string): EgoBrowserResult {
  const line = output
    .split(/\r?\n/)
    .reverse()
    .find(row => row.startsWith(resultPrefix));
  if (!line) {
    throw new Error(`ego_browser_no_result: ${output.trim().slice(-2000)}`);
  }
  const result = JSON.parse(
    line.slice(resultPrefix.length),
  ) as EgoBrowserResult;
  if (result.ok !== true) {
    const error = new Error(String(result.error || 'ego_browser_failed'));
    if (result.mayHaveLateEffects === true) {
      error.name = 'AbortError';
    }
    throw error;
  }
  return result;
}

export async function runEgoBrowser(
  space: string,
  request: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<EgoBrowserResult> {
  const script = buildEgoScript(space, request);
  const executable = egoBrowserExecutable();
  const started = performance.now();
  const directory = await mkdtemp(path.join(tmpdir(), 'mp-ego-'));
  const file = path.join(directory, 'round.mjs');
  try {
    await writeFile(file, script, 'utf8');
    return await new Promise<EgoBrowserResult>((resolve, reject) => {
      const child = spawn(
        executable,
        [
          'nodejs',
          '-e',
          `await import(${JSON.stringify(pathToFileURL(file).href)})`,
        ],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          signal: AbortSignal.any([
            ...(signal ? [signal] : []),
            AbortSignal.timeout(60000),
          ]),
        },
      );
      let output = '';
      let errorOutput = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        errorOutput += chunk;
      });
      child.on('error', error => {
        const failure = new Error(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'ego_browser_not_installed: Install and open ego lite, then complete its setup.'
            : `ego_browser_process_failed: ${error.message}. Observe the page before retrying; an in-flight action may have completed.`,
        );
        failure.name = error.name;
        reject(failure);
      });
      child.on('close', code => {
        try {
          if (code !== 0) {
            throw new Error(
              `ego_browser_exit_${code}: ${(errorOutput || output).trim().slice(-2000)}`,
            );
          }
          resolve({
            ...parseEgoOutput(`${output}\n${errorOutput}`),
            latencyMs: Math.round(performance.now() - started),
          });
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}
