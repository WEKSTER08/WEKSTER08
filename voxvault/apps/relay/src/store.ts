import { createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/**
 * Relay storage. Holds only opaque encrypted blobs, keyed by space.
 * The relay cannot read notes: it never has the encryption key.
 */
export class RelayStore {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists spaces (
        id          text primary key,
        token_hash  blob not null,
        created_at  integer not null
      );
      create table if not exists ops (
        seq         integer primary key autoincrement,
        space_id    text not null references spaces(id),
        device      text not null,
        blob        text not null,
        created_at  integer not null
      );
      create index if not exists ops_space_seq on ops (space_id, seq);
    `);
  }

  /**
   * Check a bearer token for a space. The first device to write to a space
   * claims it (trust on first use); later requests must present the same token.
   * Returns 'ok', 'unknown' (space does not exist yet) or 'denied'.
   */
  authorize(spaceId: string, token: string): 'ok' | 'unknown' | 'denied' {
    const row = this.db.prepare('select token_hash from spaces where id = ?').get(spaceId) as
      | { token_hash: Uint8Array }
      | undefined;
    if (!row) return 'unknown';
    const presented = hashToken(token);
    const stored = Buffer.from(row.token_hash);
    return stored.length === presented.length && timingSafeEqual(stored, presented) ? 'ok' : 'denied';
  }

  claim(spaceId: string, token: string): void {
    this.db
      .prepare('insert or ignore into spaces (id, token_hash, created_at) values (?, ?, ?)')
      .run(spaceId, hashToken(token), Date.now());
  }

  append(spaceId: string, device: string, blobs: string[]): number[] {
    const insert = this.db.prepare('insert into ops (space_id, device, blob, created_at) values (?, ?, ?, ?) returning seq');
    const now = Date.now();
    const seqs: number[] = [];
    this.db.exec('begin');
    try {
      for (const blob of blobs) seqs.push(Number((insert.get(spaceId, device, blob, now) as { seq: number }).seq));
      this.db.exec('commit');
    } catch (e) {
      this.db.exec('rollback');
      throw e;
    }
    return seqs;
  }

  list(spaceId: string, after: number, limit: number): { ops: Array<{ seq: number; blob: string }>; more: boolean } {
    const rows = this.db
      .prepare('select seq, blob from ops where space_id = ? and seq > ? order by seq limit ?')
      .all(spaceId, after, limit + 1) as Array<{ seq: number; blob: string }>;
    const more = rows.length > limit;
    return { ops: rows.slice(0, limit).map((r) => ({ seq: Number(r.seq), blob: r.blob })), more };
  }

  /** Raw dump, for tests that check the relay never stores plaintext. */
  dumpBlobs(): string[] {
    return (this.db.prepare('select blob from ops').all() as Array<{ blob: string }>).map((r) => r.blob);
  }

  close(): void {
    this.db.close();
  }
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}
