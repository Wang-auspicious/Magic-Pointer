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
const {execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const acceptanceStarted = performance.now();
const output = path.join(root, 'data/runtime/resource-embedded-acceptance');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 60000);
app.whenReady().then(async () => {
  let win;
  let embeddedScreenshotError = '';
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
    const {ResourceBrowserHistory} = built('resource_browser_history');
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
      'collectionWorkerView',
      'loadCollectionUrl',
      'releaseCollectionWorkerView',
      'readCollectionHistoryPage',
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
      collectionWorkerViews: new Map(),
      collectionHistoryReaders: new Map(),
      CollectionHistoryNetwork: built('collection_history_network')
        .CollectionHistoryNetwork,
      WebContentsView,
      BrowserWindow,
      nativeTheme,
      Menu,
      clipboard,
      bookmarkSync: () => ({observe: async () => {}}),
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
      clearTimeout,
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
      video: {
        media: {
          stream: {
            h264: [
              {
                masterUrl: 'https://www.xiaohongshu.com/fixture.mp4',
                width: 320,
                height: 180,
              },
            ],
          },
        },
      },
      imageList: [
        {
          urlDefault: 'https://www.xiaohongshu.com/fixture.png',
          width: 1200,
          height: 750,
        },
      ],
    };
    const videoPath = path.join(output, 'fixture.mp4');
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=0x837864:s=320x180:d=1',
        '-c:v',
        'libx264',
        '-threads',
        '1',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        videoPath,
      ],
      {windowsHide: true},
    );
    const videoBytes = fs.readFileSync(videoPath);
    firstSession.protocol.handle('https', request => {
      if (request.url.includes('/note/collect/page?')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              has_more: false,
              notes: [
                {
                  note_id: 'abc123',
                  xsec_token: 'fixture',
                  title: 'Native list response',
                },
              ],
            },
          }),
          {headers: {'content-type': 'application/json'}},
        );
      }
      if (request.url.endsWith('/fixture.mp4')) {
        return new Response(videoBytes, {
          headers: {'content-type': 'video/mp4'},
        });
      }
      if (request.url.endsWith('/fixture.png')) {
        return new Response(png, {headers: {'content-type': 'image/png'}});
      }
      const current = new URL(request.url);
      if (current.searchParams.has('slow')) {
        return new Promise(resolve =>
          setTimeout(
            () =>
              resolve(
                new Response(
                  '<title>Delayed first-account page</title><p>First account fixture</p>',
                  {headers: {'content-type': 'text/html'}},
                ),
              ),
            800,
          ),
        );
      }
      if (current.pathname === '/') {
        return new Response(
          '<title>Local account fixture</title><script>window.__INITIAL_STATE__={user:{userInfo:{_value:{userId:"self"}}}}</script>',
          {headers: {'content-type': 'text/html'}},
        );
      }
      if (current.pathname === '/user/profile/self') {
        return new Response(
          '<title>Local collection fixture</title><style>#notes{height:300px;overflow:auto}section{height:600px}</style><h1>本地账号列表夹具</h1><div id="notes"><section class="note-item"><a class="cover mask" href="/explore/abc123?xsec_token=history"><span class="title">第一条原帖</span></a></section></div><script>const notes=document.querySelector("#notes");notes.addEventListener("scroll",()=>{if(!notes.dataset.loaded){notes.dataset.loaded="true";notes.insertAdjacentHTML("beforeend",`<section class="note-item"><a class="cover mask" href="/explore/def456?xsec_token=history"><span class="title">第二条原帖</span></a></section><p>没有更多了</p>`);}})</script>',
          {headers: {'content-type': 'text/html; charset=utf-8'}},
        );
      }
      const noteId =
        /\/explore\/([a-f0-9]+)/.exec(current.pathname)?.[1] || note.noteId;
      return new Response(
        `<!doctype html><title>本地验收夹具</title><style>body{font:18px system-ui;background:#f7f6f2;color:#282828;padding:48px}h1{font-weight:500}</style><h1>MP 内嵌浏览器 · 本地验收</h1><p>${note.desc}</p><a id="popup" href="https://www.xiaohongshu.com/explore/abc123?popup=1" target="_blank">在当前 MP 会话中打开新链接</a><script>window.__INITIAL_STATE__=${JSON.stringify({note: {noteDetailMap: {[noteId]: {note: {...note, noteId}}}}})};localStorage.setItem('mp-fixture-session','retained')</script>`,
        {headers: {'content-type': 'text/html; charset=utf-8'}},
      );
    });
    secondSession.protocol.handle(
      'https',
      () =>
        new Response(
          '<title>Second account fixture</title><p>Separate second-account browser page.</p>',
          {headers: {'content-type': 'text/html'}},
        ),
    );
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
    const history = new ResourceBrowserHistory({
      folder: fs.mkdtempSync(path.join(output, 'history-')),
      readPage: context.readCollectionHistoryPage,
      importLink: async (account, link) =>
        (await service.addBatch({text: link.url, sourceAccount: account}))[0]
          .id,
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
            histories: history.snapshot(),
          };
        }
        if (action === 'edit') {
          return {
            ok: true,
            entry: service.update(input.id, input.patch, input.revision),
          };
        }
        if (action === 'related') {
          return {ok: true, related: service.related(input.url)};
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
    await view.webContents.loadURL(url + '&reading=1');
    const entry = await service.add({url, sourceAccount: account});
    assert.match(
      view.webContents.getURL(),
      /reading=1/,
      'background imports must preserve the page the user is reading',
    );
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
    for (let index = 0; index < 12; index++) {
      await service.add({
        text: `本地瀑布流验收 ${index}\n${'这是一条明确标记的布局测试资料。'.repeat(index + 1)}`,
      });
    }
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
    await wait(
      'document.querySelector(".rl-masonry")?.dataset.columns === "5"',
    );
    const masonry = await js(`(() => {
      const cards = [...document.querySelectorAll('[data-rl-id]')].map(card => {const r=card.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};});
      return {columns:new Set(cards.map(card=>Math.round(card.x))).size,heights:new Set(cards.map(card=>Math.round(card.h))).size,overlap:cards.some((a,i)=>cards.slice(i+1).some(b=>a.x < b.x+b.w-1 && a.x+a.w > b.x+1 && a.y < b.y+b.h-1 && a.y+a.h > b.y+1))};
    })()`);
    assert.equal(masonry.columns, 5);
    assert.ok(masonry.heights > 1);
    assert.equal(masonry.overlap, false);
    win.showInactive();
    await js(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.writeFileSync(
      path.join(output, 'waterfall.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
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
    await wait('document.querySelector(".rl-post video")?.readyState>=1');
    await js(
      'window.readerVideo=document.querySelector(".rl-post video");readerVideo.muted=true;readerVideo.play()',
    );
    await wait('readerVideo.currentTime>0.1');
    await js("show('chat')");
    assert.equal(
      await js('readerVideo.paused'),
      true,
      'leaving the library must pause the original post video',
    );
    await js("show('resources')");
    await js('document.fonts.ready');
    win.showInactive();
    await new Promise(resolve => setTimeout(resolve, 400));
    fs.writeFileSync(
      path.join(output, 'saved-original.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    await js("document.querySelector('[data-rl-action=source]').click()");
    await wait('!!document.querySelector("[data-rl-browser-host]")');
    await wait('!!document.querySelector("[data-rl-revisit]")');
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
    try {
      fs.writeFileSync(
        path.join(output, 'embedded-page.png'),
        (await view.webContents.capturePage()).toPNG(),
      );
    } catch (error) {
      embeddedScreenshotError = String(error);
      console.error(
        `Optional child-view screenshot failed: ${embeddedScreenshotError}`,
      );
    }
    const foregroundUrl = view.webContents.getURL();
    const networkWorker = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: browser.collectionBrowserPartition(account),
        offscreen: true,
      },
    });
    const networkReader = new (built(
      'collection_history_network',
    ).CollectionHistoryNetwork)(networkWorker.webContents, 'saved', 'fixture');
    await networkWorker.loadURL('https://www.xiaohongshu.com/fixture-network');
    await networkReader.start();
    await networkWorker.webContents.executeJavaScript(
      "fetch('/api/sns/web/v2/note/collect/page?user_id=fixture').then(response=>response.json())",
    );
    for (let index = 0; index < 50 && !networkReader.snapshot(); index++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(
      networkReader.snapshot()?.atEnd,
      true,
      'native list responses prove the end without a visible footer',
    );
    networkReader.stop();
    networkWorker.destroy();
    await history.run(account, 'saved');
    context.releaseCollectionWorkerView(account, 'history');
    assert.equal(history.snapshot()[0].status, 'complete');
    assert.equal(history.snapshot()[0].retained, 2);
    assert.equal(view.webContents.getURL(), foregroundUrl);
    await service.drainCaptures();
    assert.equal(
      service.list().filter(item => item.collection.sourceAccount === account)
        .length,
      2,
      'a changed access token must not duplicate the first note',
    );
    assert.ok(
      service
        .list()
        .filter(item => item.collection.sourceAccount === account)
        .every(item => item.collection.captureStatus === 'saved'),
    );
    await js("document.querySelector('[data-rl-tab=sources]').click()");
    await wait(
      'document.querySelector("[data-rl-history-account]")?.textContent.includes("2 条链接已留存")',
    );
    await context.captureCollectionPost(url + '&background=1', account);
    assert.equal(
      view.getVisible(),
      false,
      'closing a background worker cannot reveal the hidden browser over the library',
    );
    assert.equal(
      context.collectionWorkerViews.size,
      0,
      'finished imports must release their offscreen renderers',
    );
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.writeFileSync(
      path.join(output, 'history-source.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    await js(
      "document.querySelector('[data-rl-connect-account=xiaohongshu-1]').click()",
    );
    await wait('!!document.querySelector("[data-rl-browser-host]")');
    await js(
      "document.querySelector('[data-rl-browser] input').value='https://www.xiaohongshu.com/?slow=1';document.querySelector('[data-rl-browser]').requestSubmit()",
    );
    await new Promise(resolve => setTimeout(resolve, 80));
    await js(
      "document.querySelector('[data-rl-account=xiaohongshu-2]').click()",
    );
    await new Promise(resolve => setTimeout(resolve, 1200));
    const secondView = registry
      .snapshot()
      .find(entry => entry.key === 'collection:xiaohongshu-2').view;
    assert.equal(
      secondView.getVisible(),
      true,
      'a late response from the first account cannot hide the newly selected account',
    );
    firstSession.flushStorageData();
    await firstSession.cookies.flushStore();
    const result = {
      ok: true,
      waterfall: masonry,
      embeddedScreenshotError,
      usedBackend: 'electron.WebContentsView + local page fixture + disk store',
      accountIsolation: true,
      embeddedPopup: true,
      externalOpens,
      mediaRetained: true,
      videoRetainedPlayableAndPausedOnLeave: true,
      originalReadableInLibrary: true,
      navigationHideRestore: true,
      urlRecallVisible: true,
      backgroundImportPreservesForeground: true,
      nativeHistoryList: {
        retained: 2,
        explicitEndObserved: true,
        mediaCaptured: true,
      },
      timingMs: Math.round(performance.now() - acceptanceStarted),
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
    if (win && !win.isDestroyed() && win.webContents.getURL()) {
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
