import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Replica, type SetOp, type Snapshot } from '../src/index.ts';

/**
 * Property test: N simulated devices make random changes while syncing only
 * partially (random subsets of ops, in random order). After everyone finally
 * exchanges everything, all devices must show exactly the same notebook, and
 * that notebook must be a valid tree.
 */

type Action =
  | { kind: 'createFolder'; dev: number; pick: number; root: boolean }
  | { kind: 'createNote'; dev: number; pick: number; inbox: boolean }
  | { kind: 'moveFolder'; dev: number; pick: number; pick2: number; toRoot: boolean }
  | { kind: 'moveNote'; dev: number; pick: number; pick2: number; toInbox: boolean }
  | { kind: 'editNote'; dev: number; pick: number; text: string }
  | { kind: 'renameFolder'; dev: number; pick: number; text: string }
  | { kind: 'deleteFolder'; dev: number; pick: number }
  | { kind: 'deleteNote'; dev: number; pick: number }
  | { kind: 'partialSync'; from: number; to: number; seed: number; fraction: number }
  | { kind: 'tick'; ms: number };

const DEVICES = 3;
const dev = fc.integer({ min: 0, max: DEVICES - 1 });
const pick = fc.nat(1000);

const action: fc.Arbitrary<Action> = fc.oneof(
  fc.record({ kind: fc.constant('createFolder' as const), dev, pick, root: fc.boolean() }),
  fc.record({ kind: fc.constant('createNote' as const), dev, pick, inbox: fc.boolean() }),
  fc.record({ kind: fc.constant('moveFolder' as const), dev, pick, pick2: pick, toRoot: fc.boolean() }),
  fc.record({ kind: fc.constant('moveFolder' as const), dev, pick, pick2: pick, toRoot: fc.constant(false) }),
  fc.record({ kind: fc.constant('moveNote' as const), dev, pick, pick2: pick, toInbox: fc.boolean() }),
  fc.record({ kind: fc.constant('editNote' as const), dev, pick, text: fc.string({ maxLength: 8 }) }),
  fc.record({ kind: fc.constant('renameFolder' as const), dev, pick, text: fc.string({ maxLength: 8 }) }),
  fc.record({ kind: fc.constant('deleteFolder' as const), dev, pick }),
  fc.record({ kind: fc.constant('deleteNote' as const), dev, pick }),
  fc.record({ kind: fc.constant('partialSync' as const), from: dev, to: dev, seed: fc.nat(), fraction: fc.double({ min: 0, max: 1, noNaN: true }) }),
  fc.record({ kind: fc.constant('tick' as const), ms: fc.integer({ min: 0, max: 5 }) }),
);

function shuffled<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  let s = seed || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function at<T>(xs: T[], i: number): T | undefined {
  return xs.length ? xs[i % xs.length] : undefined;
}

function run(actions: Action[]): Replica[] {
  let t = 1;
  const now = () => t; // shared, coarse clock => lots of same-millisecond ties
  const rs = Array.from({ length: DEVICES }, (_, i) => new Replica(`dev${i}`, now));

  for (const a of actions) {
    if (a.kind === 'tick') {
      t += a.ms;
      continue;
    }
    if (a.kind === 'partialSync') {
      const ops = rs[a.from].allOps();
      const subset = shuffled(ops, a.seed).slice(0, Math.floor(ops.length * a.fraction));
      for (const op of subset) rs[a.to].applyRemote([op]);
      continue;
    }
    const r = rs[a.dev];
    const { folders, notes } = r.snapshot();
    const f = at(folders, a.pick);
    const n = at(notes, a.pick);
    switch (a.kind) {
      case 'createFolder':
        r.createFolder(`f${a.pick}`, a.root ? null : (f?.id ?? null));
        break;
      case 'createNote':
        r.createNote({ title: `n${a.pick}`, body_md: '', folder_id: a.inbox ? null : (f?.id ?? null) });
        break;
      case 'moveFolder': {
        const target = a.toRoot ? null : (at(folders, a.pick2)?.id ?? null);
        if (!f) break;
        try {
          r.moveFolder(f.id, target);
        } catch {
          /* locally invalid (cycle) — the UI would refuse it too */
        }
        break;
      }
      case 'moveNote':
        if (n) r.moveNote(n.id, a.toInbox ? null : (at(folders, a.pick2)?.id ?? null));
        break;
      case 'editNote':
        if (n) r.editNote(n.id, { body_md: a.text });
        break;
      case 'renameFolder':
        if (f) r.renameFolder(f.id, a.text);
        break;
      case 'deleteFolder':
        if (f) r.deleteFolder(f.id);
        break;
      case 'deleteNote':
        if (n) r.deleteNote(n.id);
        break;
    }
  }
  return rs;
}

function assertValidTree(s: Snapshot) {
  const ids = new Set(s.folders.map((f) => f.id));
  const parent = new Map(s.folders.map((f) => [f.id, f.parent_id]));
  for (const f of s.folders) {
    if (f.parent_id !== null) expect(ids.has(f.parent_id)).toBe(true);
    // walk to root: must terminate within |folders| steps
    let cur: string | null = f.id;
    let steps = 0;
    while (cur !== null) {
      cur = parent.get(cur) ?? null;
      expect(++steps).toBeLessThanOrEqual(s.folders.length);
    }
  }
  for (const n of s.notes) {
    if (n.folder_id !== null) expect(ids.has(n.folder_id)).toBe(true);
    else expect(['inbox', 'filed']).toContain(n.status);
  }
}

describe('convergence (property-based)', () => {
  it('all devices converge to the same valid notebook', () => {
    fc.assert(
      fc.property(fc.array(action, { minLength: 1, maxLength: 120 }), fc.nat(), (actions, seed) => {
        const rs = run(actions);
        // Final full exchange, each device receiving everything in a different random order.
        const all: SetOp[] = rs.flatMap((r) => r.allOps());
        rs.forEach((r, i) => r.applyRemote(shuffled(all, seed + i)));

        const snaps = rs.map((r) => JSON.stringify(r.snapshot()));
        expect(new Set(snaps).size).toBe(1);
        assertValidTree(rs[0].snapshot());
      }),
      { numRuns: 400 },
    );
  });

  it('concurrent random folder moves on every device never produce a cycle', () => {
    const move = fc.record({ dev, a: fc.nat(5), b: fc.nat(6) }); // b === 6 means "to root"
    fc.assert(
      fc.property(fc.array(move, { minLength: 2, maxLength: 30 }), fc.nat(), (moves, seed) => {
        let t = 1;
        const now = () => t;
        const rs = Array.from({ length: DEVICES }, (_, i) => new Replica(`dev${i}`, now));
        const ids = Array.from({ length: 6 }, (_, i) => rs[0].createFolder(`F${i}`));
        for (const r of rs.slice(1)) r.applyRemote(rs[0].allOps());
        // Every device moves folders without hearing from the others: maximally concurrent.
        for (const m of moves) {
          t += 1;
          try {
            rs[m.dev].moveFolder(ids[m.a], m.b === 6 ? null : ids[m.b]);
          } catch {
            /* locally invalid */
          }
        }
        const all = rs.flatMap((r) => r.allOps());
        rs.forEach((r, i) => r.applyRemote(shuffled(all, seed + i)));
        const snaps = rs.map((r) => JSON.stringify(r.snapshot()));
        expect(new Set(snaps).size).toBe(1);
        const s = rs[0].snapshot();
        expect(s.folders).toHaveLength(6); // moves never lose folders
        assertValidTree(s);
      }),
      { numRuns: 500 },
    );
  });

  it('no note is ever lost: every created, undeleted note is visible after convergence', () => {
    fc.assert(
      fc.property(fc.array(action, { minLength: 1, maxLength: 80 }), (actions) => {
        const rs = run(actions);
        const all = rs.flatMap((r) => r.allOps());
        rs.forEach((r) => r.applyRemote(all));
        const deleted = new Set(all.filter((o) => o.entity === 'note' && o.field === 'deleted').map((o) => o.id));
        const created = new Set(all.filter((o) => o.entity === 'note').map((o) => o.id));
        const visible = new Set(rs[0].snapshot().notes.map((n) => n.id));
        for (const id of created) if (!deleted.has(id)) expect(visible.has(id)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
