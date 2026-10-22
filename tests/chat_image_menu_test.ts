import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import type {BrowserWindow, Menu, MenuItemConstructorOptions} from 'electron';
import {attachChatImageMenu} from '../electron/chat_image_menu';

test('chat image menu copies displayed pixels through Electron instead of fetching across origins', () => {
  const contents = new EventEmitter();
  const copied: number[][] = [];
  Object.assign(contents, {
    copyImageAt: (x: number, y: number) => copied.push([x, y]),
  });
  const window = {webContents: contents} as unknown as BrowserWindow;
  let items: MenuItemConstructorOptions[] = [];
  const menu = {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      items = template;
      return {popup: () => {}};
    },
  } as unknown as Pick<typeof Menu, 'buildFromTemplate'>;
  attachChatImageMenu(window, menu);
  contents.emit(
    'context-menu',
    {},
    {mediaType: 'image', hasImageContents: true, x: 31, y: 42},
  );
  assert.equal(items[0]?.label, '复制图片');
  (items[0]?.click as () => void)();
  assert.deepEqual(copied, [[31, 42]]);
  items = [];
  contents.emit(
    'context-menu',
    {},
    {mediaType: 'none', hasImageContents: false},
  );
  assert.equal(items.length, 0, 'ordinary text must not receive an image menu');
});
