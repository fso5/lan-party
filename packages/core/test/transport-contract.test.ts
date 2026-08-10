import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BleTransport, type BleAdapter } from '@lan-party/net';
import { BridgeTransport } from '@lan-party/net';
import { LoopbackNetwork, LoopbackTransport } from '../src/net/loopback.js';
import type { Peer, Transport } from '@lan-party/net';

/**
 * One property, checked against every transport that ships.
 *
 * `Transport.join` resolving has to mean "send to this peer will go somewhere".
 * BleTransport broke that -- it resolved on the platform accepting the connect
 * *request* -- and nothing noticed, because each transport was only ever tested
 * against itself. A shared check is what makes the contract binding rather than
 * aspirational, and it is cheap: the next transport (WebRTC, USB, whatever)
 * adds one line here and finds out immediately.
 *
 * Deliberately not asserting on internal peer bookkeeping. What a caller can
 * observe is whether bytes leave, so that is what this observes.
 */
type Case = {
  name: string;
  /** Build a transport plus a way to see whether a send reached the wire. */
  make: () => {
    transport: Transport;
    sent: () => number;
    /** Bring the link up, for transports that need an external event. */
    connect?: () => Promise<void>;
    /** Pump a queued medium, for transports that do not deliver inline. */
    pump?: () => void;
  };
};

const CASES: Case[] = [
  {
    name: 'BridgeTransport',
    make: () => {
      let sent = 0;
      const transport = new BridgeTransport(() => {
        sent++;
      });
      return { transport, sent: () => sent };
    },
  },
  {
    name: 'LoopbackTransport',
    make: () => {
      const net = new LoopbackNetwork();
      let sent = 0;
      const a = new LoopbackTransport('a', 'a', net);
      const b = new LoopbackTransport('host', 'host', net);
      b.setEvents({ onPacket: () => sent++ });
      // The loopback medium holds packets until virtual time is advanced by
      // hand -- that is the whole point of it -- so a send is not "gone
      // nowhere", it is in flight. Pump before judging.
      return { transport: a, sent: () => sent, pump: () => net.advance(100) };
    },
  },
  {
    name: 'BleTransport',
    make: () => {
      let sent = 0;
      let onConn: ((p: Peer) => void) | null = null;
      // A link can only come up for a connection that was asked for. `join`
      // awaits stopScanning before it registers its wait, so firing the event
      // synchronously describes an order that cannot happen -- and hangs.
      let asked: () => void;
      const wasAsked = new Promise<void>((r) => {
        asked = r;
      });
      const adapter: BleAdapter = {
        payloadSize: 18,
        startAdvertising: async () => {},
        stopAdvertising: async () => {},
        startScanning: async () => {},
        stopScanning: async () => {},
        // Accepts the request and does nothing, as connectGatt does. The link
        // only exists once `connect()` below is called.
        connect: async () => {
          asked();
        },
        disconnect: async () => {},
        sendFrame: () => {
          sent++;
        },
        onFrame: () => {},
        onPeerConnected: (cb) => {
          onConn = cb;
        },
        onPeerDisconnected: () => {},
      };
      return {
        transport: new BleTransport(adapter),
        sent: () => sent,
        connect: async () => {
          await wasAsked;
          onConn?.({ id: 'host', name: 'host', rtt: 40 });
        },
      };
    },
  },
];

for (const c of CASES) {
  test(`${c.name}: a resolved join means send actually goes somewhere`, async () => {
    const { transport, sent, connect, pump } = c.make();

    const joining = transport.join('host');
    // A transport whose link needs an external event gets that event; one that
    // is connected by construction ignores this. Either way, join must not
    // resolve before it is true.
    await connect?.();
    await joining;

    transport.send('host', Uint8Array.from([1, 2, 3]), false);
    pump?.();
    assert.ok(sent() > 0, 'join resolved, so this send must not have vanished');

    await transport.close();
  });
}

for (const c of CASES) {
  const probe = c.make();
  if (!probe.connect) continue; // connected by construction; nothing to withhold
  test(`${c.name}: join does not resolve while the link is merely requested`, async () => {
    // The asymmetric half, and the one that actually regressed. Driven off the
    // same table so a future transport with a real connect step inherits it
    // instead of someone remembering to write it.
    const { transport } = c.make();

    // Watch the join rather than racing it. A race leaves the losing promise
    // to reject later with nobody attached, which is an unhandled rejection
    // waiting to turn flaky -- and this test is about not leaving promises
    // dangling, so it should not leave one.
    const joining = transport.join('host');
    let settled = false;
    joining.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(settled, false, 'nothing connected, so join must not have settled');

    await transport.close();
    await assert.rejects(joining, /closed while connecting/);
  });
}

test('BleTransport: closing settles a join that is still in flight', async () => {
  // Without this the transport is gone but its ten second timer is not, and it
  // rejects into nothing later while holding the loop open in the meantime.
  const c = CASES.find((x) => x.name === 'BleTransport');
  assert.ok(c);
  const { transport } = c.make();

  const joining = transport.join('host');
  await transport.close();

  await assert.rejects(joining, /transport closed while connecting to host/);
});
