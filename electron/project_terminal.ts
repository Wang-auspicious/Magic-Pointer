'use strict';

import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import path from 'node:path';

type TerminalEvent =
  | {type: 'output'; stream: 'stdout' | 'stderr'; text: string}
  | {type: 'exit'; code: number | null};

const terminalEscapeSequence = new RegExp(
  String.raw`\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])`,
  'g',
);

class ProjectTerminal {
  private child: ChildProcessWithoutNullStreams | null = null;
  private workingDirectory = '';
  private pty = false;
  private terminalReady = false;
  private pendingInput: string[] = [];
  private promptBuffer = '';

  get running(): boolean {
    return this.child !== null;
  }

  get usingPty(): boolean {
    return this.pty;
  }

  start(
    workingDirectory: string,
    onEvent: (event: TerminalEvent) => void,
  ): boolean {
    if (
      this.child &&
      this.workingDirectory &&
      path.resolve(workingDirectory) === this.workingDirectory
    ) {
      return this.pty;
    }
    this.stop();
    const usePty = process.platform === 'win32';
    const child = usePty
      ? spawn(
          'conhost.exe',
          [
            '--headless',
            '--width',
            '160',
            '--height',
            '40',
            'powershell.exe',
            '-NoLogo',
            '-NoProfile',
          ],
          {
            cwd: workingDirectory,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        )
      : spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', '-'], {
          cwd: workingDirectory,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
    this.child = child;
    this.workingDirectory = path.resolve(workingDirectory);
    this.pty = usePty;
    this.terminalReady = !this.pty;
    this.pendingInput = [];
    this.promptBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    this.sendLine(
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding',
    );
    child.stdout.on('data', (text: string) => {
      this.observePrompt(text);
      onEvent({type: 'output', stream: 'stdout', text});
    });
    child.stderr.on('data', (text: string) =>
      onEvent({type: 'output', stream: 'stderr', text}),
    );
    child.on('error', (error: Error) =>
      onEvent({type: 'output', stream: 'stderr', text: `${error.message}\n`}),
    );
    child.on('close', (code: number | null) => {
      if (this.child === child) {
        this.child = null;
        this.workingDirectory = '';
        this.pty = false;
        this.terminalReady = false;
        this.pendingInput = [];
        this.promptBuffer = '';
      }
      onEvent({type: 'exit', code});
    });
    return this.pty;
  }

  write(input: string): boolean {
    if (!this.child || !this.child.stdin.writable) {
      return false;
    }
    return this.sendLine(input);
  }

  stop(): void {
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = null;
    this.workingDirectory = '';
    this.pty = false;
    this.terminalReady = false;
    this.pendingInput = [];
    this.promptBuffer = '';
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

  private sendLine(input: string): boolean {
    if (!this.child || !this.child.stdin.writable) {
      return false;
    }
    const line = input.replace(/[\r\n]+$/, '');
    if (this.pty && !this.terminalReady) {
      this.pendingInput.push(line);
      return true;
    }
    if (this.pty) {
      this.terminalReady = false;
    }
    this.child.stdin.write(`${line}${this.pty ? '\r' : '\n'}`);
    return true;
  }

  private flushPendingInput(): void {
    const next = this.pendingInput.shift();
    if (next !== undefined) {
      this.sendLine(next);
    }
  }

  private observePrompt(text: string): void {
    if (!this.pty) {
      return;
    }
    this.promptBuffer =
      `${this.promptBuffer}${stripTerminalEscapes(text)}`.slice(-4096);
    if (!/PS [^\r\n]*>\s*$/.test(this.promptBuffer)) {
      return;
    }
    this.promptBuffer = '';
    this.terminalReady = true;
    this.flushPendingInput();
  }
}

function stripTerminalEscapes(text: string): string {
  return text.replace(terminalEscapeSequence, '').split('\u0007').join('');
}

export {ProjectTerminal};
export type {TerminalEvent};
