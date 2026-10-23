'use strict';
const {
  app,
  BrowserWindow,
  WebContentsView,
  nativeTheme,
  Menu,
  clipboard,
  ipcMain,
  session,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data/runtime/resource-embedded-acceptance');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 60000);
app.whenReady().then(async () => {
  let win;
  try {
    const built = name => require(path.join(root, 'build/electron', name));
    const {BrowserViewRegistry} = built('browser_view_registry');
    const browser = built('collection_browser');
    if (process.argv.includes('--verify-session')) {
      const retainedSession = session.fromPartition(
        browser.collectionBrowserPartition('xiaohongshu-1'),
      );
      const otherSession = session.fromPartition(
        browser.collectionBrowserPartition('xiaohongshu-2'),
      );
      assert.equal(
        (await retainedSession.cookies.get({name: 'mp-fixture-session'}))
          .length,
        1,
      );
      assert.equal(
        (await otherSession.cookies.get({name: 'mp-fixture-session'})).length,
        0,
      );
      retainedSession.protocol.handle(
        'https',
        () =>
          new Response('<title>Local storage reopen fixture</title>', {
            headers: {'content-type': 'text/html'},
          }),
      );
      win = new BrowserWindow({
        show: false,
        webPreferences: {
          partition: browser.collectionBrowserPartition('xiaohongshu-1'),
          sandbox: true,
        },
      });
      await win.loadURL('https://www.xiaohongshu.com/');
      assert.equal(
        await win.webContents.executeJavaScript(
          'localStorage.getItem("mp-fixture-session")',
        ),
        'retained',
      );
      const resultPath = path.join(output, 'result.json');
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      result.sessionSurvivesProcessRestart = true;
      fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
      console.log(
        JSON.stringify({
          ok: true,
          usedBackend: 'electron persistent partition after process restart',
          accountIsolation: true,
          cookieAndLocalStorageRetained: true,
        }),
      );
      app.exit(0);
      return;
    }
    const policy = built('browser_view_policy');
    const {ResourceCollectionService} = built('resource_collection_service');
    const {resourceThumbnailUrl} = built('resource_preview');
    const {createStashRuntime} = built('stash_runtime');
    const source = ts.createSourceFile(
      'main.ts',
      fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const declarations = [
      'normalizedBrowserBounds',
      'setDashboardBrowserVisibility',
      'browserTabState',
      'emitBrowserViewState',
      'destroyDashboardBrowserView',
      'createDashboardBrowserView',
      'openDashboardBrowser',
      'collectionBrowserState',
      'captureCollectionPost',
      'captureCollectionPostPage',
    ];
    const code = declarations
      .map(name => {
        const node = source.statements.find(
          node => ts.isFunctionDeclaration(node) && node.name?.text === name,
        );
        assert.ok(node, name);
        return ts.transpile(node.getText(source), {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        });
      })
      .join('\n');
    const registry = new BrowserViewRegistry();
    let externalOpens = 0;
    win = new BrowserWindow({
      width: 1380,
      height: 960,
      show: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: false,
        preload: path.join(root, 'scripts/probe_studio_layout_preload.js'),
        additionalArguments: [
          '--mp-probe-theme=light',
          '--mp-probe-state=landing',
        ],
      },
    });
    win.webContents.setBackgroundThrottling(false);
    const context = vm.createContext({
      dashboardWindow: win,
      dashboardBrowserRegistry: registry,
      dashboardBrowserBounds: null,
      collectionCaptureQueues: new Map(),
      WebContentsView,
      nativeTheme,
      Menu,
      clipboard,
      securityHardening: {registerBrowserContents() {}},
      shell: {
        openExternal() {
          externalOpens++;
        },
      },
      performance,
      Date,
      Promise,
      setTimeout,
      URL,
      ...browser,
      ...policy,
    });
    vm.runInContext(code, context);
    const account = 'xiaohongshu-1';
    const firstSession = session.fromPartition(
      browser.collectionBrowserPartition(account),
    );
    const secondSession = session.fromPartition(
      browser.collectionBrowserPartition('xiaohongshu-2'),
    );
    const png = await require('sharp')(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750"><rect width="1200" height="750" fill="#e9e5db"/><rect x="100" y="100" width="240" height="550" rx="16" fill="#d2ccbf"/><rect x="385" y="100" width="715" height="550" rx="16" fill="#f7f6f2"/><circle cx="220" cy="205" r="42" fill="#837864"/><path d="M145 325H295M145 375H275M145 425H285" stroke="#837864" stroke-width="12"/><path d="M440 210H1000M440 270H920M440 330H970" stroke="#b5ad9f" stroke-width="18"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    const note = {
      noteId: 'abc123',
      title: '保存以后，还能回到这个想法',
      desc: '这是一条本地验收夹具，不是已登录账号的真实帖子。\n\n保留原始正文、作者和图片顺序；明天回来，还能通过正文找到它。',
      user: {nickname: '本地验收作者', userId: 'fixture'},
      imageList: [
        {
          urlDefault: 'https://www.xiaohongshu.com/fixture.png',
          width: 1200,
          height: 750,
        },
      ],
    };
    firstSession.protocol.handle('https', request => {
      if (request.url.endsWith('/fixture.png')) {
        return new Response(png, {headers: {'content-type': 'image/png'}});
      }
      return new Response(
        `<!doctype html><title>本地验收夹具</title><style>body{font:18px system-ui;background:#f7f6f2;color:#282828;padding:48px}h1{font-weight:500}</style><h1>MP 内嵌浏览器 · 本地验收</h1><p>${note.desc}</p><a id="popup" href="https://www.xiaohongshu.com/explore/abc123?popup=1" target="_blank">在当前 MP 会话中打开新链接</a><script>window.__INITIAL_STATE__=${JSON.stringify({note: {noteDetailMap: {abc123: {note}}}})};localStorage.setItem('mp-fixture-session','retained')</script>`,
        {headers: {'content-type': 'text/html; charset=utf-8'}},
      );
    });
    const stash = createStashRuntime({
      baseDir: fs.mkdtempSync(path.join(output, 'stash-')),
      clipboard: {
        availableFormats: () => [],
        readText: () => '',
        readImage: () => ({isEmpty: () => true}),
      },
    });
    const service = new ResourceCollectionService({
      stash: () => stash,
      projects: () => [],
      attach() {},
      analyze: async () => {
        throw new Error('This native fixture must not call a model.');
      },
      capturePost: context.captureCollectionPost,
      fetchMedia: (url, init, slot) =>
        session
          .fromPartition(browser.collectionBrowserPartition(slot))
          .fetch(url, init),
    });
    ipcMain.handle('resource-probe', async (_event, {action, input = {}}) => {
      try {
        if (action.startsWith('browser-')) {
          console.log(
            JSON.stringify({
              action,
              command: input.command,
              url: input.url,
              account: input.sourceAccount,
            }),
          );
        }
        if (action === 'list' || action === 'search') {
          return {
            ok: true,
            items: (action === 'search'
              ? service.search(input.text)
              : service.list()
            ).map(item => ({
              ...item,
              previewUrl: resourceThumbnailUrl(stash.baseDir, item),
            })),
            projects: [],
            source: {status: 'disconnected'},
          };
        }
        if (action === 'edit') {
          return {
            ok: true,
            entry: service.update(input.id, input.patch, input.revision),
          };
        }
        if (action === 'browser-open') {
          return context.openDashboardBrowser(input.url, {
            resourceKey: 'collection:' + input.sourceAccount,
            partition: browser.collectionBrowserPartition(input.sourceAccount),
            bounds: input.bounds,
            restore: input.restore,
          });
        }
        if (action === 'browser-command') {
          if (input.command === 'hide') {
            registry.snapshot().forEach(entry => entry.view.setVisible(false));
          }
          if (input.command === 'resize') {
            context.dashboardBrowserBounds = context.normalizedBrowserBounds(
              input.bounds,
            );
            context.setDashboardBrowserVisibility(
              'collection:' + input.sourceAccount,
            );
          }
          return {ok: true};
        }
        if (action === 'read-post') {
          const post = service.post(input.id);
          return {
            ok: true,
            post: {
              ...post,
              media: post.media.map(media => ({
                ...media,
                localUrl: media.localPath
                  ? pathToFileURL(path.join(stash.baseDir, media.localPath))
                      .href
                  : undefined,
              })),
            },
          };
        }
        if (action === 'capture') {
          const state = context.collectionBrowserState(input.sourceAccount);
          return {
            ok: true,
            entry: await service.add({
              url: state.url,
              sourceAccount: input.sourceAccount,
            }),
          };
        }
        throw new Error('Not exercised: ' + action);
      } catch (error) {
        return {ok: false, error: error.message};
      }
    });
    const url = 'https://www.xiaohongshu.com/explore/abc123?xsec_token=fixture';
    await context.openDashboardBrowser(url, {
      resourceKey: 'collection:' + account,
      partition: browser.collectionBrowserPartition(account),
      bounds: {x: 260, y: 200, width: 1000, height: 620},
    });
    const view = registry.active.view;
    await firstSession.cookies.set({
      url: 'https://www.xiaohongshu.com/',
      name: 'mp-fixture-session',
      value: 'retained',
      expirationDate: Date.now() / 1000 + 3600,
    });
    assert.equal(
      (await secondSession.cookies.get({name: 'mp-fixture-session'})).length,
      0,
    );
    const entry = await service.add({url, sourceAccount: account});
    assert.equal(entry.collection.captureStatus, 'saved');
    assert.equal(service.post(entry.id).text, note.desc);
    assert.ok(
      fs.existsSync(
        path.join(stash.baseDir, service.post(entry.id).media[0].localPath),
      ),
    );
    await view.webContents.executeJavaScript(
      'document.querySelector("#popup").click()',
    );
    for (
      let index = 0;
      index < 50 && !view.webContents.getURL().includes('popup=1');
      index++
    ) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.match(view.webContents.getURL(), /popup=1/);
    assert.equal(externalOpens, 0);
    assert.equal(registry.snapshot().length, 1);
    view.setVisible(false);
    await win.loadFile(path.join(root, 'build/electron/renderer/studio.html'));
    const js = script => win.webContents.executeJavaScript(script);
    await js(
      "document.documentElement.lang='zh-CN';setProductMode('design');show('resources');",
    );
    const wait = async expression => {
      for (let index = 0; index < 100; index++) {
        if (await js(expression)) {
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('UI timeout: ' + expression);
    };
    await wait(`!!document.querySelector('[data-rl-id="${entry.id}"]')`);
    await js(`document.querySelector('[data-rl-id="${entry.id}"]').click()`);
    await wait(
      'document.querySelector("[data-rl-post]")?.getAttribute("aria-busy")==="false"',
    );
    assert.equal(
      await js('document.querySelector(".rl-post-text").textContent'),
      note.desc,
    );
    await wait(
      'document.querySelector(".rl-post-image img")?.naturalWidth===1200',
    );
    await js('document.fonts.ready');
    win.showInactive();
    await new Promise(resolve => setTimeout(resolve, 400));
    fs.writeFileSync(
      path.join(output, 'saved-original.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    await js("document.querySelector('[data-rl-action=source]').click()");
    await wait('!!document.querySelector("[data-rl-browser-host]")');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(view.getVisible(), true);
    await js("show('chat')");
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(view.getVisible(), false);
    await js("show('resources')");
    for (let index = 0; index < 100 && !view.getVisible(); index++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(view.getVisible(), true);
    win.showInactive();
    await new Promise(resolve => setTimeout(resolve, 400));
    fs.writeFileSync(
      path.join(output, 'embedded-browser.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    fs.writeFileSync(
      path.join(output, 'embedded-page.png'),
      (await view.webContents.capturePage()).toPNG(),
    );
    firstSession.flushStorageData();
    await firstSession.cookies.flushStore();
    const result = {
      ok: true,
      usedBackend: 'electron.WebContentsView + local page fixture + disk store',
      accountIsolation: true,
      embeddedPopup: true,
      externalOpens,
      mediaRetained: true,
      originalReadableInLibrary: true,
      navigationHideRestore: true,
      cookiesFlushed: true,
      realSocialAccountAcceptance: false,
    };
    fs.writeFileSync(
      path.join(output, 'result.json'),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error(error.stack);
    if (win && !win.isDestroyed()) {
      console.error(
        JSON.stringify(
          await win.webContents.executeJavaScript(
            '({view:document.querySelector(".mp-shell")?.dataset.view,browser:!!document.querySelector("[data-rl-browser-host]"),status:document.querySelector("[data-resource-status]")?.textContent,tabs:[...document.querySelectorAll("[data-rl-tab]")].map(item=>({id:item.dataset.rlTab,on:item.getAttribute("aria-pressed")}))})',
          ),
        ),
      );
    }
    if (win && !win.isDestroyed()) {
      fs.writeFileSync(
        path.join(output, 'failure.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
    }
    app.exit(1);
  } finally {
    clearTimeout(deadline);
  }
});
