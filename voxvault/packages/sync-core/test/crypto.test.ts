import { describe, expect, it } from 'vitest';
import { Replica, deriveSpaceKeys, keysFromPairingCode, newSpaceSecret, openOps, sealOps } from '../src/index.ts';

describe('space keys and encryption', () => {
  const keys = deriveSpaceKeys(newSpaceSecret());
  const r = new Replica('a');
  r.createNote({ title: 'secret plans', body_md: 'launch on tuesday' });
  const ops = r.allOps();

  it('a pairing code reproduces the same keys on another device', () => {
    const joined = keysFromPairingCode(keys.pairingCode);
    expect(joined.spaceId).toBe(keys.spaceId);
    expect(joined.authToken).toBe(keys.authToken);
    expect(Buffer.from(joined.encKey).equals(Buffer.from(keys.encKey))).toBe(true);
  });

  it('round-trips ops and hides plaintext', () => {
    const blob = sealOps(keys, ops);
    expect(blob).not.toContain('secret');
    expect(Buffer.from(blob, 'base64url').toString('latin1')).not.toContain('secret plans');
    expect(openOps(keys, blob)).toEqual(ops);
  });

  it('rejects tampered blobs', () => {
    const blob = Buffer.from(sealOps(keys, ops), 'base64url');
    blob[blob.length - 1] ^= 1;
    expect(() => openOps(keys, blob.toString('base64url'))).toThrow();
  });

  it('rejects blobs from another space', () => {
    const other = deriveSpaceKeys(newSpaceSecret());
    expect(() => openOps(other, sealOps(keys, ops))).toThrow();
  });

  it('rejects malformed pairing codes', () => {
    expect(() => keysFromPairingCode('hello')).toThrow();
    expect(() => keysFromPairingCode('vv1.AAAA')).toThrow(/32 bytes/);
  });
});
