import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Replica, SyncClient, deriveSpaceKeys, keysFromPairingCode, newSpaceSecret, type SyncState } from '@voxvault/sync-core';
import { buildRelay } from '../src/server.ts';

const { app, store } = buildRelay();
let url = '';

beforeAll(async () => {
  url = await app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await app.close();
});

function device(nodeId: string, pairingCode: string) {
  const replica = new Replica(nodeId);
  const state: SyncState = { cursor: 0, outbox: [] };
  const client = new SyncClient({ relayUrl: url, keys: keysFromPairingCode(pairingCode), replica, state, batchSize: 3 });
  return { replica, client, state };
}

describe('relay + sync client, end to end', () => {
  const keys = deriveSpaceKeys(newSpaceSecret());

  it('two devices converge through the relay', async () => {
    const phone = device('phone', keys.pairingCode);
    const laptop = device('laptop', keys.pairingCode);

    const books = phone.replica.createFolder('Books');
    phone.replica.createNote({ title: 'Survival mechanics', body_md: 'Astrophage eats light', folder_id: books });
    laptop.replica.createNote({ title: 'Grocery list', body_md: 'eggs' });

    const r1 = await phone.client.sync();
    expect(r1.pushed).toBe(6); // 2 folder ops + 4 note ops, in batches of 3
    expect(phone.state.outbox).toHaveLength(0);
    await laptop.client.sync();
    await phone.client.sync();

    expect(laptop.replica.snapshot()).toEqual(phone.replica.snapshot());
    expect(laptop.replica.snapshot().notes).toHaveLength(2);
  });

  it('the relay only ever stores ciphertext', () => {
    const dump = store.dumpBlobs().join('\n');
    expect(dump.length).toBeGreaterThan(0);
    for (const secret of ['Survival', 'Astrophage', 'Books', 'Grocery', 'eggs']) expect(dump).not.toContain(secret);
  });

  it('a device that was offline catches up from its cursor', async () => {
    const tablet = device('tablet', keys.pairingCode);
    const res = await tablet.client.sync();
    expect(res.applied).toBeGreaterThan(0);
    expect(tablet.replica.snapshot().notes).toHaveLength(2);
    const again = await tablet.client.sync();
    expect(again).toEqual({ pushed: 0, pulled: 0, applied: 0, rejected: 0 });
  });

  it('rejects a wrong token for an existing space', async () => {
    const res = await fetch(`${url}/v1/spaces/${keys.spaceId}/ops`, {
      method: 'POST',
      headers: { authorization: 'Bearer AAAAAAAAAAAAAAAAAAAAAAAA', 'content-type': 'application/json' },
      body: JSON.stringify({ device: 'evil', blobs: ['abc'] }),
    });
    expect(res.status).toBe(403);
    const read = await fetch(`${url}/v1/spaces/${keys.spaceId}/ops?after=0`, {
      headers: { authorization: 'Bearer AAAAAAAAAAAAAAAAAAAAAAAA' },
    });
    expect(read.status).toBe(403);
  });

  it('rejects malformed requests', async () => {
    const h = { authorization: `Bearer ${keys.authToken}`, 'content-type': 'application/json' };
    const bad = (body: unknown) =>
      fetch(`${url}/v1/spaces/${keys.spaceId}/ops`, { method: 'POST', headers: h, body: JSON.stringify(body) });
    expect((await bad({ device: 'x', blobs: [] })).status).toBe(400);
    expect((await bad({ device: 'x', blobs: ['not base64!'] })).status).toBe(400);
    expect((await bad({ device: '../etc', blobs: ['abc'] })).status).toBe(400);
    expect((await fetch(`${url}/v1/spaces/NOTHEX/ops`, { headers: h })).status).toBe(400);
  });

  it('a corrupt blob is skipped instead of blocking sync', async () => {
    const res = await fetch(`${url}/v1/spaces/${keys.spaceId}/ops`, {
      method: 'POST',
      headers: { authorization: `Bearer ${keys.authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ device: 'buggy', blobs: ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'] }),
    });
    expect(res.status).toBe(200);
    const d = device('fresh', keys.pairingCode);
    const r = await d.client.sync();
    expect(r.rejected).toBe(1);
    expect(d.replica.snapshot().notes).toHaveLength(2);
  });

  it('lost push responses are harmless (re-push is idempotent)', async () => {
    const a = device('a', keys.pairingCode);
    await a.client.sync();
    a.replica.createNote({ title: 'dup', body_md: '' });
    const ops = [...a.state.outbox];
    await a.client.sync();
    a.state.outbox.push(...ops); // simulate: relay stored it but the response was lost
    await a.client.sync();
    const b = device('b', keys.pairingCode);
    await b.client.sync();
    expect(b.replica.snapshot().notes.filter((n) => n.title === 'dup')).toHaveLength(1);
  });
});
