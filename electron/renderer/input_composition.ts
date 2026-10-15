window.addEventListener(
  'keydown',
  event => {
    if (event.isComposing || event.keyCode === 229) {
      // Keep native candidate selection, but do not send, stop or navigate.
      event.stopImmediatePropagation();
    }
  },
  {capture: true},
);
