import type {
  ActivationArguments,
  Notification as ElectronNotification,
} from 'electron';

export const DESKTOP_APP_ID = 'com.magicpointer.desktop';
export const DEVELOPMENT_APP_ID = 'com.magicpointer.desktop.development';
// Windows needs one stable activation identity across application restarts.
export const DESKTOP_TOAST_CLSID = '{36BB7647-5B9A-498F-A642-09323717C9F0}';

export type DesktopNotificationTarget =
  | {view: 'personal'; date?: string}
  | {view: 'chat'; conversationId: string; artifactId?: string}
  | {view: 'scheduled'};

interface Options {
  packaged: boolean;
  platform: NodeJS.Platform;
  notification: typeof ElectronNotification;
  open(target: DesktopNotificationTarget): void;
  onError(error: unknown): void;
}

function xml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    character =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'})[
        character
      ]!,
  );
}

export function parseDesktopNotificationTarget(
  argumentsText: string,
): DesktopNotificationTarget | null {
  try {
    const target = JSON.parse(argumentsText);
    if (
      target?.view === 'personal' &&
      typeof target.date === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(target.date)
    ) {
      return {view: 'personal', date: target.date};
    }
    if (
      target?.view === 'chat' &&
      typeof target.conversationId === 'string' &&
      target.conversationId
    ) {
      return {
        view: 'chat',
        conversationId: target.conversationId,
        ...(typeof target.artifactId === 'string' && target.artifactId
          ? {artifactId: target.artifactId}
          : {}),
      };
    }
    if (target?.view === 'scheduled') {
      return {view: 'scheduled'};
    }
  } catch {
    // Existing notifications may have no application launch arguments.
  }
  return null;
}

export class DesktopNotifications {
  constructor(private readonly options: Options) {}

  registerActivation(): void {
    if (
      !this.options.packaged ||
      this.options.platform !== 'win32' ||
      !this.options.notification.isSupported()
    ) {
      return;
    }
    this.options.notification.handleActivation(
      (details: ActivationArguments) => {
        if (details.type === 'click') {
          this.options.open(
            parseDesktopNotificationTarget(details.arguments) || {
              view: 'personal',
            },
          );
        }
      },
    );
  }

  show(
    title: string,
    body: string,
    target: DesktopNotificationTarget,
  ): boolean {
    if (!this.options.packaged || !this.options.notification.isSupported()) {
      return false;
    }
    try {
      const notification = new this.options.notification({
        title,
        body,
        ...(this.options.platform === 'win32'
          ? {
              toastXml: `<toast launch="${xml(JSON.stringify(target))}"><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual></toast>`,
            }
          : {}),
      });
      if (this.options.platform !== 'win32') {
        notification.on('click', () => this.options.open(target));
      }
      notification.on('failed', (_event, error) => this.options.onError(error));
      notification.show();
      return true;
    } catch (error) {
      this.options.onError(error);
      return false;
    }
  }
}
