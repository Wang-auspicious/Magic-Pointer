import assert from 'node:assert/strict';
import type {
  ActivationArguments,
  Notification as NativeNotification,
} from 'electron';
import {
  DesktopNotifications,
  type DesktopNotificationTarget,
} from '../electron/desktop_notifications';

let activation: (details: ActivationArguments) => void;
const created: FakeNotification[] = [];
class FakeNotification {
  static supported = true;
  static isSupported() {
    return this.supported;
  }
  static handleActivation(callback: typeof activation) {
    activation = callback;
  }
  readonly handlers = new Map<string, (...args: any[]) => void>();
  constructor(readonly options: Electron.NotificationConstructorOptions) {
    created.push(this);
  }
  on(event: string, callback: (...args: any[]) => void) {
    this.handlers.set(event, callback);
  }
  show() {}
}
const opened: DesktopNotificationTarget[] = [];
const errors: unknown[] = [];
const options = {
  packaged: true,
  platform: 'win32' as const,
  notification: FakeNotification as unknown as typeof NativeNotification,
  open: (target: DesktopNotificationTarget) => opened.push(target),
  onError: (error: unknown) => errors.push(error),
};
const target: DesktopNotificationTarget = {
  view: 'chat',
  conversationId: 'chat<&"42',
  artifactId: 'draft-7',
};
const producer = new DesktopNotifications(options);
assert.equal(producer.show('Ready & available', '<Draft>', target), true);
const saved = created[0].options.toastXml!;
assert.match(saved, /<text>Ready &amp; available<\/text>/);
assert.match(saved, /<text>&lt;Draft&gt;<\/text>/);
assert.equal(
  created[0].handlers.has('click'),
  false,
  'A live Windows click must not be dispatched twice',
);
const raw = saved
  .match(/launch="([^"]+)"/)![1]
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');
// A fresh controller has none of the producer's in-memory Notification objects.
new DesktopNotifications(options).registerActivation();
activation!({type: 'click', arguments: raw});
assert.deepEqual(opened, [target]);
activation!({type: 'click', arguments: ''});
assert.deepEqual(
  opened[1],
  {view: 'personal'},
  'Legacy notifications still open the application',
);
created[0].handlers.get('failed')!({}, 'Windows toast failed');
assert.deepEqual(errors, ['Windows toast failed']);
const count = created.length;
assert.equal(
  new DesktopNotifications({...options, packaged: false}).show(
    'Development',
    'Do not publish',
    {view: 'scheduled'},
  ),
  false,
);
FakeNotification.supported = false;
assert.equal(producer.show('Unsupported', '', {view: 'scheduled'}), false);
assert.equal(created.length, count);
console.log(
  'Notification restart routing, escaped XML, failure reporting and development isolation passed',
);
