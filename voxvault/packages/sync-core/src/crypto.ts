import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, bytesToUtf8, concatBytes, randomBytes, utf8ToBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { validateOp, type SetOp } from './ops.ts';

/**
 * Everything a device needs to join a sync space, derived from one 32-byte
 * secret. The secret never leaves the user's devices; the relay only sees
 * `spaceId` and `authToken`, neither of which can decrypt anything.
 */
export interface SpaceKeys {
  /** Public address of the space on the relay. */
  spaceId: string;
  /** Bearer token proving membership to the relay. */
  authToken: string;
  /** Symmetric key for XChaCha20-Poly1305. Never sent anywhere. */
  encKey: Uint8Array;
  /** The root secret, encoded for pairing (QR code / copy-paste). */
  pairingCode: string;
}

const NONCE_LEN = 24;
const SECRET_LEN = 32;

export function newSpaceSecret(): Uint8Array {
  return randomBytes(SECRET_LEN);
}

export function deriveSpaceKeys(secret: Uint8Array): SpaceKeys {
  if (secret.length !== SECRET_LEN) throw new Error('space secret must be 32 bytes');
  const derive = (info: string, len: number) => hkdf(sha256, secret, undefined, utf8ToBytes(`voxvault/v1/${info}`), len);
  return {
    spaceId: bytesToHex(derive('space-id', 16)),
    authToken: toBase64Url(derive('auth', 32)),
    encKey: derive('enc', 32),
    pairingCode: `vv1.${toBase64Url(secret)}`,
  };
}

export function keysFromPairingCode(code: string): SpaceKeys {
  const m = /^vv1\.([A-Za-z0-9_-]+)$/.exec(code.trim());
  if (!m) throw new Error('invalid pairing code');
  return deriveSpaceKeys(fromBase64Url(m[1]));
}

/** Encrypt a batch of ops into one opaque blob: base64url(nonce || ciphertext+tag). */
export function sealOps(keys: SpaceKeys, ops: SetOp[]): string {
  const nonce = randomBytes(NONCE_LEN);
  const plaintext = utf8ToBytes(JSON.stringify(ops));
  const ct = xchacha20poly1305(keys.encKey, nonce, utf8ToBytes(keys.spaceId)).encrypt(plaintext);
  return toBase64Url(concatBytes(nonce, ct));
}

/** Decrypt and validate a blob. Throws if it was tampered with or is from another space. */
export function openOps(keys: SpaceKeys, blob: string): SetOp[] {
  const bytes = fromBase64Url(blob);
  if (bytes.length <= NONCE_LEN) throw new Error('blob too short');
  const pt = xchacha20poly1305(keys.encKey, bytes.subarray(0, NONCE_LEN), utf8ToBytes(keys.spaceId)).decrypt(
    bytes.subarray(NONCE_LEN),
  );
  const parsed: unknown = JSON.parse(bytesToUtf8(pt));
  if (!Array.isArray(parsed)) throw new Error('blob payload must be an array');
  return parsed.map(validateOp);
}

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
