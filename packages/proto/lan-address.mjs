/**
 * The machine's own address on the local network.
 *
 * The browser tests used to talk to `127.0.0.1`, and that quietly made them
 * easier than reality: browsers treat localhost as a **secure context**, the
 * same as HTTPS. A real player's phone connects to something like
 * `192.168.43.1`, which is not.
 *
 * Anything gated on a secure context -- service workers, `crypto.subtle`,
 * clipboard, camera -- therefore works in a localhost test and fails on the
 * phone, with nothing in CI to catch it. Using a real interface address makes
 * the tests share the constraint the game actually runs under.
 *
 * Falls back to loopback when there is no such interface, because a test that
 * cannot run is worse than one that runs slightly too easily.
 */

import { networkInterfaces } from 'node:os';

export function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      // IPv6 is skipped deliberately: a link-local v6 address in a URL is
      // unusable for the thing this mimics -- somebody typing it into Safari.
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}
