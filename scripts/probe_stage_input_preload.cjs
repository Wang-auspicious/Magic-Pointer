'use strict';
const listeners = {};
const calls = [];
const pending = [];
window.magicPointerStage = {
  ready() {}, reportState() {}, hidden() {}, dismiss() {}, setMouseCapture() {},
  onShow: callback => { listeners.show = callback; },
  onUpdate: callback => { listeners.update = callback; },
  onHide: callback => { listeners.hide = callback; },
  onConversationProgress: callback => { listeners.progress = callback; },
  onCardPatch() {}, onPointerInput() {}, onModelHealth() {},
  submitSelectionCommand: payload => { calls.push({ unexpectedPrompt: payload }); },
  respondInput: payload => {
    calls.push(payload);
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  },
  openArtifact: async payload => { calls.push({ openArtifact: payload }); return { ok: true }; },
};
window.__stageProbe = {
  show: payload => listeners.show(payload), progress: payload => listeners.progress(payload),
  calls, resolve: (index, value) => pending[index].resolve(value),
  reject: (index, message) => pending[index].reject(new Error(message)),
};
