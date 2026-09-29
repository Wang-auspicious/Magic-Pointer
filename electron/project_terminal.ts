'use strict';

import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';

type TerminalEvent =
  | {type: 'output'; stream: 'stdout' | 'stderr'; text: string}
  | {type: 'exit'; code: number | null};

class ProjectTerminal {
  private child: ChildProcessWithoutNullStreams | null = null;

  get running(): boolean {
    return this.child !== null;
  }

  start(
    workingDirectory: string,
    onEvent: (event: TerminalEvent) => void,
  ): void {
    this.stop();
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-Command', '-'],
      {
        cwd: workingDirectory,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdin.write(
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding\n',
    );
    child.stdout.on('data', (text: string) =>
      onEvent({type: 'output', stream: 'stdout', text}),
    );
    child.stderr.on('data', (text: string) =>
      onEvent({type: 'output', stream: 'stderr', text}),
    );
    child.on('error', (error: Error) =>
      onEvent({type: 'output', stream: 'stderr', text: `${error.message}\n`}),
    );
    child.on('close', (code: number | null) => {
      if (this.child === child) {
        this.child = null;
      }
      onEvent({type: 'exit', code});
    });
  }

  write(input: string): boolean {
    if (!this.child || !this.child.stdin.writable) {
      return false;
    }
    this.child.stdin.write(`${input.replace(/[\r\n]+$/, '')}\n`);
    return true;
  }

  stop(): void {
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = null;
    child.stdin.end();
    if (child.pid && process.platform === 'win32') {
      const killer = spawn(
        'taskkill.exe',
        ['/PID', String(child.pid), '/T', '/F'],
        {windowsHide: true, stdio: 'ignore'},
      );
      killer.unref();
    } else {
      child.kill();
    }
  }
}

export {ProjectTerminal};
export type {TerminalEvent};
