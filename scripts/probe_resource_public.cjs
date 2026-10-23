'use strict';
const {app, BrowserWindow, session} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data/runtime/resource-public-acceptance');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', path.join(output, 'profile'));
const started = performance.now();
const deadline = setTimeout(() => {
  console.error('Public acceptance timed out');
  app.exit(1);
}, 120000);
app.whenReady().then(async () => {
  try {
    const installed = path.join(
      process.env.LOCALAPPDATA,
      'Programs/Magic Pointer/resources/app/build/electron',
    );
    const {readCollectionPage, postFromCollectionPage} = require(
      path.join(installed, 'collection_browser'),
    );
    const {ResourceCollectionService} = require(
      path.join(installed, 'resource_collection_service'),
    );
    const {createStashRuntime} = require(path.join(installed, 'stash_runtime'));
    const partition = 'persist:mp-public-acceptance';
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        partition,
        offscreen: true,
        backgroundThrottling: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.webContents.setFrameRate(10);
    win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
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
        throw new Error(
          'No model is needed for this public capture acceptance.',
        );
      },
      capturePost: async url => {
        await win.loadURL(url);
        const page = await win.webContents.executeJavaScript(
          `(${readCollectionPage.toString()})()`,
        );
        return {
          ...postFromCollectionPage(page),
          timingMs: performance.now() - started,
        };
      },
      fetchMedia: (url, init) =>
        session.fromPartition(partition).fetch(url, init),
    });
    const entry = await service.add({url: 'https://www.minttr.com/'});
    const post = service.post(entry.id);
    if (!/minttr/i.test(post.title) || post.text.length < 400) {
      throw new Error(
        'The reference website did not expose the expected public content.',
      );
    }
    const images = post.media.filter(
      media => media.kind === 'image' && media.localPath,
    );
    const htmlFile = path.join(output, 'saved-images.html');
    fs.writeFileSync(
      htmlFile,
      '<!doctype html><title>Saved public media acceptance</title>' +
        images
          .map(
            media =>
              `<img src="${pathToFileURL(path.join(stash.baseDir, media.localPath)).href}">`,
          )
          .join(''),
    );
    await win.loadFile(htmlFile);
    let decoded = [];
    for (let round = 0; round < 100; round++) {
      decoded = await win.webContents.executeJavaScript(
        '[...document.images].map(image=>({complete:image.complete,width:image.naturalWidth}))',
      );
      if (decoded.every(image => image.complete)) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const result = {
      ok:
        entry.collection.captureStatus === 'saved' &&
        decoded.every(image => image.width > 0),
      usedBackend: post.usedBackend,
      timingMs: Math.round(performance.now() - started),
      source: post.url,
      title: post.title,
      textCharacters: post.text.length,
      status: entry.collection.captureStatus,
      media: post.media.map((media, index) => ({
        kind: media.kind,
        stored: Boolean(media.localPath),
        extension: path.extname(media.localPath || ''),
        error: media.error,
        decoded:
          media.kind === 'image' && media.localPath
            ? decoded[images.indexOf(media)]?.width > 0
            : undefined,
      })),
      socialAccountAcceptance: false,
      desktopInteraction: false,
    };
    fs.writeFileSync(
      path.join(output, 'result.json'),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
    app.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(error.stack);
    app.exit(1);
  } finally {
    clearTimeout(deadline);
  }
});
