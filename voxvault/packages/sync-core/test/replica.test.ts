import { describe, expect, it } from 'vitest';
import { Clock, Replica, parseHlc, type SetOp } from '../src/index.ts';

/** Deliver every op each replica has to every other replica. */
function syncAll(...rs: Replica[]) {
  const all = rs.flatMap((r) => r.allOps());
  for (const r of rs) r.applyRemote(all);
}

describe('Clock', () => {
  it('is strictly increasing even when the wall clock stalls or goes backwards', () => {
    let t = 1000;
    const c = new Clock('a', () => t);
    const a = c.tick();
    const b = c.tick();
    t = 500;
    const d = c.tick();
    expect(a < b && b < d).toBe(true);
  });

  it('moves past remote timestamps from a device whose clock is ahead', () => {
    const c = new Clock('a', () => 1000);
    const remote = new Clock('b', () => 9_000_000).tick();
    c.observe(remote);
    expect(c.tick() > remote).toBe(true);
    expect(parseHlc(c.tick()).ms).toBe(9_000_000);
  });
});

describe('Replica basics', () => {
  it('creates folders and notes and files notes', () => {
    const r = new Replica('a');
    const books = r.createFolder('Books');
    const phm = r.createFolder('Project Hail Mary', books);
    const n = r.createNote({ title: 'Survival mechanics', body_md: 'Astrophage...', folder_id: phm });
    const inbox = r.createNote({ title: 'Unsorted', body_md: '...' });
    const snap = r.snapshot();
    expect(snap.folders.find((f) => f.id === phm)?.parent_id).toBe(books);
    expect(snap.notes.find((x) => x.id === n)).toMatchObject({ folder_id: phm, status: 'filed' });
    expect(snap.notes.find((x) => x.id === inbox)).toMatchObject({ folder_id: null, status: 'inbox' });
  });

  it('rejects moving a folder into its own subfolder locally', () => {
    const r = new Replica('a');
    const a = r.createFolder('A');
    const b = r.createFolder('B', a);
    expect(() => r.moveFolder(a, b)).toThrow(/itself/);
  });

  it('applying the same ops twice changes nothing', () => {
    const r = new Replica('a');
    r.createNote({ title: 't', body_md: 'b' });
    const before = JSON.stringify(r.snapshot());
    expect(r.applyRemote(r.allOps())).toHaveLength(0);
    expect(JSON.stringify(r.snapshot())).toBe(before);
  });

  it('rejects malformed remote ops without applying any of the batch', () => {
    const r = new Replica('a');
    const good = new Replica('b');
    good.createFolder('ok');
    const bad = { ...good.allOps()[0], hlc: good.allOps()[0].hlc.replace('b', 'c'), field: 'evil' };
    expect(() => r.applyRemote([...good.allOps(), bad])).toThrow();
    expect(r.opCount).toBe(0);
  });
});

describe('Merging concurrent changes', () => {
  it('last edit wins for the same field; different fields both survive', () => {
    let t = 1;
    const now = () => t;
    const a = new Replica('a', now);
    const b = new Replica('b', now);
    const id = a.createNote({ title: 'v0', body_md: 'body0' });
    syncAll(a, b);
    t = 10;
    a.editNote(id, { title: 'from A' });
    t = 20;
    b.editNote(id, { title: 'from B' });
    a.editNote(id, { body_md: 'body from A' });
    syncAll(a, b);
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(a.snapshot().notes[0]).toMatchObject({ title: 'from B', body_md: 'body from A' });
  });

  it('concurrent folder moves that would form a cycle: the later one is skipped', () => {
    let t = 1;
    const now = () => t;
    const a = new Replica('a', now);
    const b = new Replica('b', now);
    const x = a.createFolder('X');
    const y = a.createFolder('Y');
    syncAll(a, b);
    t = 10;
    a.moveFolder(x, y); // X into Y
    t = 11;
    b.moveFolder(y, x); // Y into X — concurrent, would make a cycle
    syncAll(a, b);
    const snap = a.snapshot();
    expect(snap).toEqual(b.snapshot());
    expect(snap.folders.find((f) => f.id === x)?.parent_id).toBe(y);
    expect(snap.folders.find((f) => f.id === y)?.parent_id).toBe(null);
  });

  it('deleting a folder while another device files a note into it never loses the note', () => {
    const a = new Replica('a');
    const b = new Replica('b');
    const f = a.createFolder('Old');
    const sub = a.createFolder('Sub', f);
    syncAll(a, b);
    a.deleteFolder(f);
    const n = b.createNote({ title: 'new idea', body_md: '...', folder_id: sub });
    syncAll(a, b);
    for (const r of [a, b]) {
      const snap = r.snapshot();
      expect(snap.folders).toHaveLength(0); // subtree hidden
      expect(snap.notes.find((x) => x.id === n)).toMatchObject({ folder_id: null, status: 'inbox' });
    }
  });

  it('ops can arrive in any order (child before parent, move before create)', () => {
    const a = new Replica('a');
    const p = a.createFolder('Parent');
    const c = a.createFolder('Child', p);
    a.createNote({ title: 'n', body_md: '', folder_id: c });
    const ops = a.allOps();
    const b = new Replica('b');
    // Deliver in reverse, one at a time; every intermediate state must be readable.
    for (const op of [...ops].reverse()) {
      b.applyRemote([op]);
      expect(() => b.snapshot()).not.toThrow();
    }
    expect(b.snapshot()).toEqual(a.snapshot());
  });

  it('carries embeddings and their model name', () => {
    const a = new Replica('a');
    const b = new Replica('b');
    const n = a.createNote({ title: 't', body_md: 'b' });
    a.editNote(n, { embedding: [0.1, 0.2, 0.3], embedding_model: 'text-embedding-3-small@512' });
    syncAll(a, b);
    expect(b.snapshot().notes[0]).toMatchObject({ embedding: [0.1, 0.2, 0.3], embedding_model: 'text-embedding-3-small@512' });
  });
});

export type { SetOp };
