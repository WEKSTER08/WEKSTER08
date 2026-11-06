/**
 * Hybrid Logical Clock.
 *
 * Encoded as a fixed-width string so that plain string comparison gives a
 * total order across all devices:  "<ms:15>:<counter:6>:<nodeId>"
 */
export type Hlc = string;

const MS_WIDTH = 15;
const COUNTER_WIDTH = 6;
const MAX_COUNTER = 10 ** COUNTER_WIDTH - 1;
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface ParsedHlc {
  ms: number;
  counter: number;
  nodeId: string;
}

export function encodeHlc({ ms, counter, nodeId }: ParsedHlc): Hlc {
  return `${String(ms).padStart(MS_WIDTH, '0')}:${String(counter).padStart(COUNTER_WIDTH, '0')}:${nodeId}`;
}

export function parseHlc(hlc: Hlc): ParsedHlc {
  const parts = hlc.split(':');
  if (parts.length !== 3 || parts[0].length !== MS_WIDTH || parts[1].length !== COUNTER_WIDTH) {
    throw new Error(`invalid HLC: ${hlc}`);
  }
  const ms = Number(parts[0]);
  const counter = Number(parts[1]);
  if (!Number.isInteger(ms) || !Number.isInteger(counter) || !NODE_ID_RE.test(parts[2])) {
    throw new Error(`invalid HLC: ${hlc}`);
  }
  return { ms, counter, nodeId: parts[2] };
}

export function isValidNodeId(nodeId: string): boolean {
  return NODE_ID_RE.test(nodeId);
}

export class Clock {
  readonly nodeId: string;
  private readonly now: () => number;
  private lastMs = 0;
  private counter = 0;

  constructor(nodeId: string, now: () => number = Date.now) {
    if (!isValidNodeId(nodeId)) throw new Error(`invalid node id: ${nodeId}`);
    this.nodeId = nodeId;
    this.now = now;
  }

  /** Timestamp for a new local event. Always greater than anything seen before. */
  tick(): Hlc {
    const wall = this.now();
    if (wall > this.lastMs) {
      this.lastMs = wall;
      this.counter = 0;
    } else {
      this.bump();
    }
    return encodeHlc({ ms: this.lastMs, counter: this.counter, nodeId: this.nodeId });
  }

  /** Merge a timestamp received from another device. */
  observe(remote: Hlc): void {
    const r = parseHlc(remote);
    const wall = this.now();
    if (wall > this.lastMs && wall > r.ms) {
      this.lastMs = wall;
      this.counter = 0;
    } else if (r.ms > this.lastMs) {
      this.lastMs = r.ms;
      this.counter = r.counter;
      this.bump();
    } else if (r.ms === this.lastMs) {
      this.counter = Math.max(this.counter, r.counter);
      this.bump();
    } else {
      this.bump();
    }
  }

  private bump(): void {
    if (this.counter >= MAX_COUNTER) {
      this.lastMs += 1;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
  }
}
