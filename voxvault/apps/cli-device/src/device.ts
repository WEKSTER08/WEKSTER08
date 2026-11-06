import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  Replica,
  SyncClient,
  keysFromPairingCode,
  newId,
  type SetOp,
  type SpaceKeys,
  type SyncState,
} from '@voxvault/sync-core';

/**
 * A device = local SQLite file holding its op log, sync cursor, outbox and
 * pairing secret. This mirrors what the mobile app will store on the phone.
 */
export class Device {
  readonly replica: Replica;
  readonly client: SyncClient;
  readonly keys: SpaceKeys;
  readonly relayUrl: string;
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
    const meta = (k: string) => (db.prepare('select v from meta where k = ?').get(k) as { v: string } | undefined)?.v;
    const nodeId = meta('node_id');
    const code = meta('pairing_code');
    const relay = meta('relay_url');
    if (!nodeId || !code || !relay) throw new Error('device not initialised: run `vox init` or `vox join` first');
    this.keys = keysFromPairingCode(code);
    this.relayUrl = relay;

    this.replica = new Replica(nodeId);
    const rows = db.prepare('select json from ops').all() as Array<{ json: string }>;
    this.replica.load(rows.map((r) => JSON.parse(r.json)));

    const outboxRows = db.prepare('select o.json from outbox x join ops o on o.hlc = x.hlc order by x.hlc').all() as Array<{
      json: string;
    }>;
    const state: SyncState = {
      cursor: Number(meta('cursor') ?? 0),
      outbox: outboxRows.map((r) => JSON.parse(r.json) as SetOp),
    };

    const insertOp = db.prepare('insert or ignore into ops (hlc, json) values (?, ?)');
    this.replica.subscribe((ops) => {
      this.tx(() => {
        for (const op of ops) insertOp.run(op.hlc, JSON.stringify(op));
      });
    });

    this.client = new SyncClient({
      relayUrl: relay,
      keys: this.keys,
      replica: this.replica,
      state,
      onStateChange: (s) => this.saveState(s),
    });
  }

  static open(dir: string): Device {
    return new Device(openDb(dir));
  }

  /** Create a brand-new sync space (first device). */
  static init(dir: string, relayUrl: string, pairingCode: string, name?: string): Device {
    const db = openDb(dir);
    const existing = db.prepare("select v from meta where k = 'node_id'").get();
    if (existing) throw new Error(`device already initialised in ${dir}`);
    const nodeId = `${(name ?? 'dev').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || 'dev'}-${newId().slice(0, 8)}`;
    const set = db.prepare('insert into meta (k, v) values (?, ?)');
    set.run('node_id', nodeId);
    set.run('pairing_code', pairingCode);
    set.run('relay_url', relayUrl.replace(/\/+$/, ''));
    set.run('cursor', '0');
    db.close();
    return Device.open(dir);
  }

  close(): void {
    this.client.close();
    this.db.close();
  }

  private saveState(s: SyncState): void {
    this.tx(() => {
      this.db.prepare("insert or replace into meta (k, v) values ('cursor', ?)").run(String(s.cursor));
      this.db.exec('delete from outbox');
      const ins = this.db.prepare('insert or ignore into outbox (hlc) values (?)');
      for (const op of s.outbox) ins.run(op.hlc);
    });
  }

  private depth = 0;
  private tx(fn: () => void): void {
    if (this.depth++ === 0) this.db.exec('begin');
    try {
      fn();
      if (this.depth === 1) this.db.exec('commit');
    } catch (e) {
      if (this.depth === 1) this.db.exec('rollback');
      throw e;
    } finally {
      this.depth--;
    }
  }
}

function openDb(dir: string): DatabaseSync {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'device.db'));
  db.exec(`
    pragma journal_mode = wal;
    create table if not exists meta (k text primary key, v text not null);
    create table if not exists ops (hlc text primary key, json text not null);
    create table if not exists outbox (hlc text primary key);
  `);
  return db;
}
