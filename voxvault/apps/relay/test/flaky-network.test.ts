import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Replica, SyncClient, deriveSpaceKeys, newSpaceSecret } from '@voxvault/sync-core';
import { buildRelay } from '../src/server.ts';

/**
 * Stage (b) without Docker: several devices sync through the real relay over
 * a deliberately bad network — requests randomly fail before reaching the
 * relay, or reach it but the response is lost. Devices keep editing while
 * syncs fail. Once the network recovers, everyone must converge.
 */

const { app } = buildRelay();
let url = '';
beforeAll(async () => {
  url = await app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await app.close();
});

function flakyFetch(rand: () => number, enabled: { on: boolean }): typeof fetch {
  return async (input, init) => {
    if (enabled.on && rand() < 0.25) throw new TypeError('network down (before relay)');
    const res = await fetch(input, init);
    if (enabled.on && rand() < 0.25) throw new TypeError('connection reset (after relay processed it)');
    return res;
  };
}

describe('sync over a flaky network', () => {
  it('devices converge after the network recovers', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ dev: fc.nat(2), op: fc.nat(5), pick: fc.nat(50) }), { minLength: 5, maxLength: 40 }),
        fc.integer({ min: 1, max: 2 ** 30 }),
        async (steps, seed) => {
          let s = seed;
          const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
          const net = { on: true };
          const keys = deriveSpaceKeys(newSpaceSecret());
          const devs = [0, 1, 2].map((i) => {
            const replica = new Replica(`d${i}`);
            const client = new SyncClient({
              relayUrl: url,
              keys,
              replica,
              state: { cursor: 0, outbox: [] },
              fetch: flakyFetch(rand, net),
              batchSize: 2,
            });
            return { replica, client };
          });

          for (const st of steps) {
            const { replica, client } = devs[st.dev];
            const snap = replica.snapshot();
            const f = snap.folders.length ? snap.folders[st.pick % snap.folders.length] : undefined;
            const n = snap.notes.length ? snap.notes[st.pick % snap.notes.length] : undefined;
            switch (st.op) {
              case 0: replica.createFolder(`f${st.pick}`, f?.id ?? null); break;
              case 1: replica.createNote({ title: `n${st.pick}`, body_md: '', folder_id: f?.id ?? null }); break;
              case 2: if (n) replica.editNote(n.id, { body_md: `edit ${st.pick}` }); break;
              case 3: if (n) replica.moveNote(n.id, f?.id ?? null); break;
              case 4: if (f) replica.deleteFolder(f.id); break;
              case 5: await client.sync().catch(() => undefined); break; // failures are expected
            }
          }

          net.on = false; // network recovers
          for (let round = 0; round < 2; round++) for (const d of devs) await d.client.sync();

          const snaps = devs.map((d) => JSON.stringify(d.replica.snapshot()));
          expect(new Set(snaps).size).toBe(1);
          for (const d of devs) expect(d.client.state.outbox).toHaveLength(0);
        },
      ),
      { numRuns: 40 },
    );
  });
});
