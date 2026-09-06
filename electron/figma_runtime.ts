'use strict';

import {
  FigmaLoopbackBridge,
  type FigmaConnectionSnapshot,
} from './figma_bridge';

interface RuntimeBridge {
  start(): Promise<{ host: '127.0.0.1'; port: number; baseUrl: string }>;
  stop(): Promise<void>;
  openPairing(taskId: string): { taskId: string; pairCode: string; expiresAt: number };
  connectionSnapshot(): FigmaConnectionSnapshot[];
  clientConfiguration(taskId: string, documentSessionId: string): {
    baseUrl: string;
    controlToken: string;
    taskId: string;
    documentSessionId: string;
  };
  closeConnection(taskId: string, documentSessionId: string): boolean;
  request(
    taskId: string,
    documentSessionId: string,
    operation: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

export class FigmaRuntimeController {
  private readonly bridge: RuntimeBridge;
  private address: { host: '127.0.0.1'; port: number; baseUrl: string } | null = null;

  constructor(options: { bridge?: RuntimeBridge; port?: number } = {}) {
    this.bridge = options.bridge || new FigmaLoopbackBridge({ port: options.port });
  }

  async openPairing(taskId: string): Promise<{
    taskId: string;
    pairCode: string;
    expiresAt: number;
    baseUrl: string;
    port: number;
  }> {
    const normalized = String(taskId || '').trim();
    if (!normalized) throw new Error('figma_pairing_task_required');
    this.address = await this.bridge.start();
    const pairing = this.bridge.openPairing(normalized);
    return {
      ...pairing,
      baseUrl: this.address.baseUrl,
      port: this.address.port,
    };
  }

  status(taskId?: string): {
    running: boolean;
    baseUrl: string | null;
    connections: FigmaConnectionSnapshot[];
  } {
    const normalized = String(taskId || '').trim();
    return {
      running: this.address !== null,
      baseUrl: this.address?.baseUrl || null,
      connections: this.bridge.connectionSnapshot().filter(
        (connection) => !normalized || connection.taskId === normalized,
      ),
    };
  }

  clientConfigurations(): Array<{
    baseUrl: string;
    controlToken: string;
    taskId: string;
    documentSessionId: string;
    documentName: string;
    pageId?: string;
    pageName?: string;
    selectionIds: string[];
  }> {
    return this.bridge.connectionSnapshot().map((connection) => ({
      ...this.bridge.clientConfiguration(connection.taskId, connection.documentSessionId),
      documentName: connection.documentName,
      ...(connection.pageId ? { pageId: connection.pageId } : {}),
      ...(connection.pageName ? { pageName: connection.pageName } : {}),
      selectionIds: [...connection.selectionIds],
    }));
  }

  disconnect(taskId: string, documentSessionId: string): boolean {
    return this.bridge.closeConnection(
      String(taskId || '').trim(),
      String(documentSessionId || '').trim(),
    );
  }

  request(
    taskId: string,
    documentSessionId: string,
    operation: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.bridge.request(
      String(taskId || '').trim(),
      String(documentSessionId || '').trim(),
      String(operation || '').trim(),
      { ...args },
    );
  }

  async stop(): Promise<void> {
    this.address = null;
    await this.bridge.stop();
  }
}
