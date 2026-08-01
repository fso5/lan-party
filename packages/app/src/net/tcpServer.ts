/**
 * `TcpServer` over the native Android listener.
 *
 * Pure translation, exactly like `bleAdapter.ts`: bytes to base64 and back,
 * native events to the interface `LanHost` expects. Nothing here decides
 * anything, because everything worth deciding is in core where it can be
 * tested without a phone.
 */

import type { TcpConnectionHandlers, TcpServer } from '@tanks/core';

import { TanksLanNative } from '../../modules/tanks-lan';
import { base64ToBytes, bytesToBase64 } from './base64';

export class NativeTcpServer implements TcpServer {
  private handlers: TcpConnectionHandlers | null = null;
  private subs: { remove(): void }[] = [];

  setHandlers(handlers: TcpConnectionHandlers): void {
    this.handlers = handlers;
  }

  getIpAddress(): string | null {
    return TanksLanNative?.getIpAddress() ?? null;
  }

  async start(port: number): Promise<number> {
    const native = TanksLanNative;
    if (!native) throw new Error('hosting over WiFi needs the Android app');

    // Subscribe before listening. A phone can connect between bind and
    // subscribe, and that connection would arrive with nobody listening for
    // it -- a player who joined and is invisible.
    this.subs = [
      native.addListener('onConnection', ({ connId }) => this.handlers?.onConnection(connId)),
      native.addListener('onData', ({ connId, data }) =>
        this.handlers?.onData(connId, base64ToBytes(data)),
      ),
      native.addListener('onClose', ({ connId }) => this.handlers?.onClose(connId)),
      native.addListener('onError', ({ where, message }) => this.handlers?.onError(where, message)),
    ];

    try {
      return await native.start(port);
    } catch (err) {
      this.removeSubs();
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.removeSubs();
    await TanksLanNative?.stop();
  }

  send(connId: string, data: Uint8Array): void {
    TanksLanNative?.send(connId, bytesToBase64(data));
  }

  close(connId: string): void {
    TanksLanNative?.close(connId);
  }

  private removeSubs(): void {
    for (const s of this.subs) s.remove();
    this.subs = [];
  }
}
