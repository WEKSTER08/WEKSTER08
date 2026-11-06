import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { RelayStore } from './store.ts';

export interface RelayOptions {
  dbPath?: string;
  logger?: boolean;
  /** Max blobs per push request. */
  maxBlobs?: number;
  /** Max size of one encrypted blob, in characters. */
  maxBlobChars?: number;
}

const SPACE_ID_RE = /^[a-f0-9]{32}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BLOB_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Store-and-forward relay for end-to-end encrypted sync.
 *
 *   POST /v1/spaces/:spaceId/ops   { device, blobs: string[] }  -> { seqs }
 *   GET  /v1/spaces/:spaceId/ops?after=N&limit=M                -> { ops: [{seq, blob}], more }
 *   GET  /healthz
 */
export function buildRelay(opts: RelayOptions = {}): { app: FastifyInstance; store: RelayStore } {
  const store = new RelayStore(opts.dbPath);
  const maxBlobs = opts.maxBlobs ?? 100;
  const maxBlobChars = opts.maxBlobChars ?? 2_000_000;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: maxBlobs * maxBlobChars + 10_000 });

  app.addHook('onClose', async () => store.close());

  app.get('/healthz', async () => ({ ok: true }));

  const auth = (req: FastifyRequest<{ Params: { spaceId: string } }>, reply: FastifyReply, allowClaim: boolean) => {
    const { spaceId } = req.params;
    if (!SPACE_ID_RE.test(spaceId)) {
      reply.code(400).send({ error: 'invalid space id' });
      return false;
    }
    const m = /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(req.headers.authorization ?? '');
    if (!m) {
      reply.code(401).send({ error: 'missing bearer token' });
      return false;
    }
    const result = store.authorize(spaceId, m[1]);
    if (result === 'ok') return true;
    if (result === 'unknown') {
      if (allowClaim) {
        store.claim(spaceId, m[1]);
        // Re-check: if two devices raced to claim, only the winner's token passes.
        if (store.authorize(spaceId, m[1]) === 'ok') return true;
      } else {
        // Reading a space nobody has written yet: nothing to see.
        reply.send({ ops: [], more: false });
        return false;
      }
    }
    reply.code(403).send({ error: 'forbidden' });
    return false;
  };

  app.post<{ Params: { spaceId: string }; Body: { device?: unknown; blobs?: unknown } }>(
    '/v1/spaces/:spaceId/ops',
    async (req, reply) => {
      if (!auth(req, reply, true)) return reply;
      const { device, blobs } = req.body ?? {};
      if (typeof device !== 'string' || !DEVICE_RE.test(device)) return reply.code(400).send({ error: 'invalid device' });
      if (
        !Array.isArray(blobs) ||
        blobs.length === 0 ||
        blobs.length > maxBlobs ||
        !blobs.every((b) => typeof b === 'string' && b.length <= maxBlobChars && BLOB_RE.test(b))
      ) {
        return reply.code(400).send({ error: 'invalid blobs' });
      }
      return { seqs: store.append(req.params.spaceId, device, blobs as string[]) };
    },
  );

  app.get<{ Params: { spaceId: string }; Querystring: { after?: string; limit?: string } }>(
    '/v1/spaces/:spaceId/ops',
    async (req, reply) => {
      if (!auth(req, reply, false)) return reply;
      const after = Number(req.query.after ?? 0);
      const limit = Math.min(Number(req.query.limit ?? 200), 1000);
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) {
        return reply.code(400).send({ error: 'invalid after/limit' });
      }
      return store.list(req.params.spaceId, after, limit);
    },
  );

  return { app, store };
}
