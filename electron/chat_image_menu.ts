import type {BrowserWindow, Menu} from 'electron';

/** Copy the pixels Chromium already decoded, including cross-origin images. */
export function attachChatImageMenu(
  window: BrowserWindow,
  menu: Pick<typeof Menu, 'buildFromTemplate'>,
): void {
  window.webContents.on('context-menu', (_event, params) => {
    if (params.mediaType !== 'image' || !params.hasImageContents) {
      return;
    }
    menu
      .buildFromTemplate([
        {
          label: '复制图片',
          click: () => window.webContents.copyImageAt(params.x, params.y),
        },
      ])
      .popup({window});
  });
}
