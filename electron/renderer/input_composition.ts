window.addEventListener(
  'keydown',
  event => {
    if (event.isComposing || event.keyCode === 229) {
      // Keep native candidate selection, but do not send, stop or navigate.
      event.stopImmediatePropagation();
      return;
    }
    if (
      event.key === 'F5' ||
      event.key === 'BrowserRefresh' ||
      ((event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === 'r')
    ) {
      event.preventDefault();
    }
  },
  {capture: true},
);

window.addEventListener(
  'dragstart',
  event => {
    const target = event.target as HTMLElement | null;
    if (target && target.closest('[draggable="true"]')) {
      return;
    }
    event.preventDefault();
  },
  {capture: true},
);
