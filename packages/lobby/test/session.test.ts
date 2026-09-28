/**
 * LobbySession over an in-memory transport.
 *
 * The hub below delivers synchronously, with the same event shapes a real
 * transport raises, so these drive the session exactly as a host and phones
 * would -- only without timing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TransportKind, type PeerId, type Transport, type TransportEvents } from '@lan-party/net';
import { LOBBY_MSG, LobbyOp, MAX_LOBBY_SLOTS, LobbySession, MODE_TEAMS } from '../src/index.js';

/** A star: one host id, any number of clients, every packet delivered at once. */
class Hub {
  ends = new Map<PeerId, FakeTransport>();
  /** Every packet sent, as [from, to]. */
  log: [PeerId, PeerId][] = [];

  end(id: PeerId): FakeTransport {
    const t = new FakeTransport(this, id);
    this.ends.set(id, t);
    return t;
  }

  deliver(from: PeerId, to: PeerId, data: Uint8Array): void {
    this.log.push([from, to]);
    this.ends.get(to)?.events.onPacket?.(from, data.slice());
  }
}

class FakeTransport implements Transport {
  readonly kind = TransportKind.Loopback;
  readonly maxPayload = 512;
  events: Partial<TransportEvents> = {};
  peers = new Set<PeerId>();

  constructor(
    private hub: Hub,
    readonly id: PeerId,
  ) {}

  async host(): Promise<void> {}
  async discover(): Promise<void> {}

  async join(peerId: PeerId): Promise<void> {
    const host = this.hub.ends.get(peerId)!;
    this.peers.add(peerId);
    host.peers.add(this.id);
    host.events.onPeerJoin?.({ id: this.id, name: this.id, rtt: 0 });
  }

  /** The client drops off; the host hears about it. */
  leave(): void {
    for (const p of this.peers) {
      const other = this.hub.ends.get(p)!;
      other.peers.delete(this.id);
      other.events.onPeerLeave?.(this.id, 'left');
    }
    this.peers.clear();
  }

  send(to: PeerId, data: Uint8Array): void {
    this.hub.deliver(this.id, to, data);
  }

  broadcast(data: Uint8Array): void {
    for (const p of this.peers) this.hub.deliver(this.id, p, data);
  }

  async close(): Promise<void> {}

  setEvents(events: Partial<TransportEvents>): void {
    this.events = { ...this.events, ...events };
  }
}

async function lobby() {
  const hub = new Hub();
  const host = new LobbySession(hub.end('host'), 'Host');
  await host.startHosting();
  const players = new Map<string, { t: FakeTransport; s: LobbySession }>();
  const join = async (name: string) => {
    const t = hub.end(name);
    const s = new LobbySession(t, name);
    await s.join('host');
    players.set(name, { t, s });
    return s;
  };
  const teams = () => host.get().roster.slots.map((s) => `${s.name}=t${s.team}`);
  return { hub, host, players, join, teams };
}

test('everyone in a free-for-all is on their own team', async () => {
  const { join, teams } = await lobby();
  await join('A');
  await join('B');
  assert.deepEqual(teams(), ['Host=t0', 'A=t1', 'B=t2']);
});

test('a leave and a join never put two players on one team (issue #9)', async () => {
  // The exact sequence from the review: with slots.length as the team, C landed
  // on B's team 2 and the two could not hurt each other for the whole match.
  const { join, players, teams } = await lobby();
  await join('A');
  await join('B');
  players.get('A')!.t.leave();
  assert.deepEqual(teams(), ['Host=t0', 'B=t2']);

  await join('C');
  assert.deepEqual(teams(), ['Host=t0', 'B=t2', 'C=t1']);
  const all = teams().map((x) => x.split('=')[1]);
  assert.equal(new Set(all).size, all.length, 'two players share a free-for-all team');
});

test('in teams mode a joiner goes to the smaller side', async () => {
  const { host, join, teams } = await lobby();
  await join('A');
  await join('B');
  host.setMode(MODE_TEAMS);
  assert.deepEqual(teams(), ['Host=t0', 'A=t1', 'B=t0']);
  await join('C');
  assert.deepEqual(teams(), ['Host=t0', 'A=t1', 'B=t0', 'C=t1']);
});

test('every client sees the host roster and learns its own slot', async () => {
  const { host, join } = await lobby();
  const a = await join('A');
  const b = await join('B');
  assert.deepEqual(a.get().roster, host.get().roster);
  assert.deepEqual(b.get().roster, host.get().roster);
  assert.equal(a.get().roster.slots.find((s) => s.slotId === a.get().mySlotId)?.name, 'A');
  assert.equal(b.get().roster.slots.find((s) => s.slotId === b.get().mySlotId)?.name, 'B');
});

test('a client team request changes nothing until the host answers', async () => {
  const { host, join, hub, players } = await lobby();
  const a = await join('A');
  // A second peer on A's transport, so a broadcast and a send to the host are
  // distinguishable: with only the host connected they deliver identically.
  hub.end('stray');
  players.get('A')!.t.peers.add('stray');
  const before = hub.log.length;
  a.setTeam(5);
  assert.deepEqual(
    hub.log.slice(before).filter(([from]) => from === 'A'),
    [['A', 'host']],
    'the request went somewhere other than the host alone',
  );
  // The host applied it and the roster that came back carries it.
  assert.equal(host.get().roster.slots.find((s) => s.name === 'A')?.team, 5);
  assert.equal(a.get().roster.slots.find((s) => s.name === 'A')?.team, 5);
});

test('ready gates the start', async () => {
  const { host, join } = await lobby();
  assert.equal(host.canStart(), false, 'one player is not a match');
  const a = await join('A');
  assert.equal(host.canStart(), false, 'A has not readied');
  a.setReady(true);
  assert.equal(host.canStart(), true);
});

test('the lobby seats no more than the roster can carry', async () => {
  const { host, join } = await lobby();
  for (let i = 1; i < MAX_LOBBY_SLOTS + 3; i++) await join(`P${i}`);
  assert.equal(host.get().roster.slots.length, MAX_LOBBY_SLOTS);
});

test('a repeated join from one peer is one player, not two', async () => {
  const { host, players, join } = await lobby();
  await join('A');
  await players.get('A')!.s.join('host');
  assert.equal(host.get().roster.slots.filter((s) => s.name === 'A').length, 1);
});

test('handlePacket claims lobby packets and passes everything else on', async () => {
  const { host } = await lobby();
  assert.equal(host.handlePacket('x', Uint8Array.from([LOBBY_MSG, LobbyOp.SetReady, 1])), true);
  assert.equal(host.handlePacket('x', Uint8Array.from([2, 0, 0, 0])), false, 'a game message');
  assert.equal(host.handlePacket('x', Uint8Array.from([LOBBY_MSG])), false, 'too short to be one');
});

test('a malformed lobby packet is reported, not thrown', async () => {
  const { host } = await lobby();
  // Join with a name length that runs past the end.
  assert.doesNotThrow(() => host.handlePacket('x', Uint8Array.from([LOBBY_MSG, LobbyOp.Join, 40])));
  assert.match(host.get().error ?? '', /lobby packet/);
});
