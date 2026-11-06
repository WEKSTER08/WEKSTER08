import { openOps, sealOps, type SpaceKeys } from './crypto.ts';
import type { SetOp } from './ops.ts';
import type { Replica } from './replica.ts';

/** What a device must persist between runs for sync to resume correctly. */
export interface SyncState {
  /** Highest relay sequence number already pulled. */
  cursor: number;
  /** Local ops not yet acknowledged by the relay. */
  outbox: SetOp[];
}

export interface SyncClientOptions {
  relayUrl: string;
  keys: SpaceKeys;
  replica: Replica;
  state: SyncState;
  /** Called whenever `state` changes, so the device can persist it. */
  onStateChange?: (state: SyncState) => void;
  fetch?: typeof fetch;
  /** Max ops per encrypted blob. */
  batchSize?: number;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  applied: number;
  /** Blobs that failed to decrypt or validate (tampered, corrupt, or from a newer app version). Skipped. */
  rejected: number;
}

export class RelayError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Pushes local ops to the relay and pulls everyone else's.
 * Transport-agnostic (only needs `fetch`), so it runs in Node, React Native and browsers.
 */
export class SyncClient {
  private readonly opts: Required<Omit<SyncClientOptions, 'onStateChange'>> & Pick<SyncClientOptions, 'onStateChange'>;
  private readonly unsubscribe: () => void;
  private running: Promise<SyncResult> | null = null;

  constructor(opts: SyncClientOptions) {
    this.opts = { fetch: globalThis.fetch.bind(globalThis), batchSize: 500, ...opts };
    this.opts.relayUrl = this.opts.relayUrl.replace(/\/+$/, '');
    this.unsubscribe = opts.replica.subscribe((ops, origin) => {
      if (origin !== 'local') return;
      this.state.outbox.push(...ops);
      this.save();
    });
  }

  get state(): SyncState {
    return this.opts.state;
  }

  close(): void {
    this.unsubscribe();
  }

  /** Push then pull. Concurrent calls share one run. */
  sync(): Promise<SyncResult> {
    if (!this.running) {
      this.running = (async () => {
        const pushed = await this.push();
        const { pulled, applied, rejected } = await this.pull();
        return { pushed, pulled, applied, rejected };
      })().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  async push(): Promise<number> {
    let pushed = 0;
    while (this.state.outbox.length) {
      const batch = this.state.outbox.slice(0, this.opts.batchSize);
      await this.request('POST', '/ops', { device: this.opts.replica.nodeId, blobs: [sealOps(this.opts.keys, batch)] });
      // Only drop what we sent; new local ops may have been queued meanwhile.
      this.state.outbox.splice(0, batch.length);
      this.save();
      pushed += batch.length;
    }
    return pushed;
  }

  async pull(): Promise<{ pulled: number; applied: number; rejected: number }> {
    let pulled = 0;
    let applied = 0;
    let rejected = 0;
    for (;;) {
      const res = (await this.request('GET', `/ops?after=${this.state.cursor}&limit=200`)) as {
        ops: Array<{ seq: number; blob: string }>;
        more: boolean;
      };
      for (const { seq, blob } of res.ops) {
        try {
          const ops = openOps(this.opts.keys, blob);
          applied += this.opts.replica.applyRemote(ops).length;
          pulled += ops.length;
        } catch {
          // Never let one bad blob block sync forever.
          rejected += 1;
        }
        this.state.cursor = seq;
      }
      if (res.ops.length) this.save();
      if (!res.more) return { pulled, applied, rejected };
    }
  }

  private save(): void {
    this.opts.onStateChange?.(this.state);
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const res = await this.opts.fetch(`${this.opts.relayUrl}/v1/spaces/${this.opts.keys.spaceId}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.keys.authToken}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new RelayError(res.status, `relay ${method} ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
}
