import { Clock, type Hlc } from './hlc.ts';
import { isValidId, validateOp, type Entity, type Json, type SetOp } from './ops.ts';

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
}

export type NoteStatus = 'inbox' | 'filed';

export interface Note {
  id: string;
  title: string;
  body_md: string;
  folder_id: string | null;
  status: NoteStatus;
  embedding: number[] | null;
  embedding_model: string | null;
  /** HLC of the newest change to this note. */
  updated: Hlc;
}

export interface Snapshot {
  folders: Folder[];
  notes: Note[];
}

export type OpListener = (ops: SetOp[], origin: 'local' | 'remote') => void;

export function newId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const regKey = (entity: Entity, id: string, field: string) => `${entity}\u0000${id}\u0000${field}`;

/**
 * One device's copy of the notebook.
 *
 * State is a pure function of the *set* of ops held, so replicas that hold the
 * same ops show the same notebook no matter the order the ops arrived in.
 *
 * Merge rules:
 *  - Every field is a last-writer-wins register (highest HLC wins).
 *  - Folder moves are replayed in HLC order; a move that would put a folder
 *    inside itself (a cycle) is skipped (Kleppmann et al., 2021).
 *  - Deleting a folder hides its whole subtree. Notes that lived anywhere in a
 *    deleted (or not-yet-synced) folder are never lost: they surface in the Inbox.
 */
export class Replica {
  readonly clock: Clock;
  private readonly log = new Map<Hlc, SetOp>();
  private readonly registers = new Map<string, SetOp>();
  private readonly entities: Record<Entity, Set<string>> = { folder: new Set(), note: new Set() };
  /** All folder parent_id ops, sorted by HLC, for move replay. */
  private readonly folderMoves: SetOp[] = [];
  private readonly listeners = new Set<OpListener>();
  private cache: Snapshot | null = null;

  constructor(nodeId: string, now?: () => number) {
    this.clock = new Clock(nodeId, now);
  }

  get nodeId(): string {
    return this.clock.nodeId;
  }

  subscribe(fn: OpListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Every op this replica holds, in HLC order. */
  allOps(): SetOp[] {
    return [...this.log.values()].sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
  }

  get opCount(): number {
    return this.log.size;
  }

  /**
   * Load ops from local storage at startup (no listeners fired).
   * Ops are validated: storage is not trusted blindly.
   */
  load(ops: unknown[]): void {
    for (const raw of ops) this.ingest(validateOp(raw));
  }

  /**
   * Apply ops received from another device. Invalid ops throw before anything
   * is applied. Returns only the ops that were new to this replica.
   */
  applyRemote(raw: unknown[]): SetOp[] {
    const ops = raw.map(validateOp);
    const fresh: SetOp[] = [];
    for (const op of ops) {
      this.clock.observe(op.hlc);
      if (this.ingest(op)) fresh.push(op);
    }
    if (fresh.length) this.emit(fresh, 'remote');
    return fresh;
  }

  // ---- local mutations -------------------------------------------------------

  createFolder(name: string, parentId: string | null = null): string {
    const id = newId();
    this.local([
      ['folder', id, 'name', name],
      ['folder', id, 'parent_id', parentId],
    ]);
    return id;
  }

  renameFolder(id: string, name: string): void {
    this.requireLive('folder', id);
    this.local([['folder', id, 'name', name]]);
  }

  moveFolder(id: string, parentId: string | null): void {
    this.requireLive('folder', id);
    if (parentId !== null) {
      this.requireLive('folder', parentId);
      if (parentId === id || this.isDescendant(parentId, id)) {
        throw new Error('cannot move a folder into itself or one of its subfolders');
      }
    }
    this.local([['folder', id, 'parent_id', parentId]]);
  }

  deleteFolder(id: string): void {
    this.requireLive('folder', id);
    this.local([['folder', id, 'deleted', true]]);
  }

  createNote(input: { title: string; body_md: string; folder_id?: string | null; status?: NoteStatus }): string {
    const id = newId();
    const folderId = input.folder_id ?? null;
    if (folderId !== null) this.requireLive('folder', folderId);
    this.local([
      ['note', id, 'title', input.title],
      ['note', id, 'body_md', input.body_md],
      ['note', id, 'folder_id', folderId],
      ['note', id, 'status', input.status ?? (folderId ? 'filed' : 'inbox')],
    ]);
    return id;
  }

  editNote(id: string, patch: { title?: string; body_md?: string; embedding?: number[] | null; embedding_model?: string }): void {
    this.requireLive('note', id);
    const changes: Array<[Entity, string, string, Json]> = [];
    for (const field of ['title', 'body_md', 'embedding', 'embedding_model'] as const) {
      if (patch[field] !== undefined) changes.push(['note', id, field, patch[field] as Json]);
    }
    if (changes.length) this.local(changes);
  }

  /** Move a note into a folder (files it), or to null (back to the Inbox). */
  moveNote(id: string, folderId: string | null): void {
    this.requireLive('note', id);
    if (folderId !== null) this.requireLive('folder', folderId);
    this.local([
      ['note', id, 'folder_id', folderId],
      ['note', id, 'status', folderId ? 'filed' : 'inbox'],
    ]);
  }

  deleteNote(id: string): void {
    this.requireLive('note', id);
    this.local([['note', id, 'deleted', true]]);
  }

  // ---- reading ---------------------------------------------------------------

  snapshot(): Snapshot {
    if (this.cache) return this.cache;

    const parents = this.replayFolderMoves();
    const folderExists = (id: string) => this.entities.folder.has(id);
    const liveMemo = new Map<string, boolean>();
    // A folder is live if it exists, is not deleted, and its parent is live.
    // A parent we have not received yet does not hide the child (it shows at the root).
    // replayFolderMoves guarantees there are no cycles, so this recursion terminates.
    const isLive = (id: string): boolean => {
      const memo = liveMemo.get(id);
      if (memo !== undefined) return memo;
      let live = folderExists(id) && this.get('folder', id, 'deleted') !== true;
      if (live) {
        const p = parents.get(id) ?? null;
        if (p !== null && folderExists(p)) live = isLive(p);
      }
      liveMemo.set(id, live);
      return live;
    };

    const folders: Folder[] = [];
    for (const id of [...this.entities.folder].sort()) {
      if (!isLive(id)) continue;
      const p = parents.get(id) ?? null;
      folders.push({
        id,
        name: (this.get('folder', id, 'name') as string | undefined) ?? '',
        parent_id: p !== null && folderExists(p) && isLive(p) ? p : null,
      });
    }

    const notes: Note[] = [];
    for (const id of [...this.entities.note].sort()) {
      if (this.get('note', id, 'deleted') === true) continue;
      let folderId = (this.get('note', id, 'folder_id') as string | null | undefined) ?? null;
      let status = (this.get('note', id, 'status') as NoteStatus | undefined) ?? 'inbox';
      if (folderId !== null && !isLive(folderId)) {
        folderId = null;
        status = 'inbox';
      }
      notes.push({
        id,
        title: (this.get('note', id, 'title') as string | undefined) ?? '',
        body_md: (this.get('note', id, 'body_md') as string | undefined) ?? '',
        folder_id: folderId,
        status,
        embedding: (this.get('note', id, 'embedding') as number[] | null | undefined) ?? null,
        embedding_model: (this.get('note', id, 'embedding_model') as string | undefined) ?? null,
        updated: this.newestHlc('note', id),
      });
    }

    this.cache = { folders, notes };
    return this.cache;
  }

  // ---- internals -------------------------------------------------------------

  private local(changes: Array<[Entity, string, string, Json]>): void {
    const ops = changes.map(([entity, id, field, value]) =>
      validateOp({ hlc: this.clock.tick(), entity, id, field, value }),
    );
    for (const op of ops) this.ingest(op);
    this.emit(ops, 'local');
  }

  private ingest(op: SetOp): boolean {
    if (this.log.has(op.hlc)) return false;
    this.log.set(op.hlc, op);
    this.entities[op.entity].add(op.id);
    const key = regKey(op.entity, op.id, op.field);
    const cur = this.registers.get(key);
    if (!cur || op.hlc > cur.hlc) this.registers.set(key, op);
    if (op.entity === 'folder' && op.field === 'parent_id') insertSorted(this.folderMoves, op);
    this.cache = null;
    return true;
  }

  private emit(ops: SetOp[], origin: 'local' | 'remote'): void {
    for (const fn of this.listeners) fn(ops, origin);
  }

  private get(entity: Entity, id: string, field: string): Json | undefined {
    return this.registers.get(regKey(entity, id, field))?.value;
  }

  private newestHlc(entity: Entity, id: string): Hlc {
    let newest = '';
    for (const field of ['title', 'body_md', 'folder_id', 'status', 'deleted', 'embedding', 'embedding_model']) {
      const op = this.registers.get(regKey(entity, id, field));
      if (op && op.hlc > newest) newest = op.hlc;
    }
    return newest;
  }

  /** Replay every folder move in HLC order, skipping any that would form a cycle. */
  private replayFolderMoves(): Map<string, string | null> {
    const parents = new Map<string, string | null>();
    for (const op of this.folderMoves) {
      const target = op.value as string | null;
      if (target !== null && (target === op.id || isAncestorIn(parents, op.id, target))) continue;
      parents.set(op.id, target);
    }
    return parents;
  }

  /** Is `node` somewhere below `ancestor` in the current tree? */
  private isDescendant(node: string, ancestor: string): boolean {
    return isAncestorIn(this.replayFolderMoves(), ancestor, node);
  }

  private requireLive(entity: Entity, id: string): void {
    if (!isValidId(id)) throw new Error(`invalid ${entity} id`);
    const snap = this.snapshot();
    const list: Array<{ id: string }> = entity === 'folder' ? snap.folders : snap.notes;
    if (!list.some((x) => x.id === id)) throw new Error(`${entity} not found: ${id}`);
  }
}

/** Walk up from `node` through `parents`; true if we reach `ancestor`. */
function isAncestorIn(parents: Map<string, string | null>, ancestor: string, node: string): boolean {
  let cur = parents.get(node) ?? null;
  let steps = 0;
  while (cur !== null) {
    if (cur === ancestor) return true;
    if (++steps > parents.size) return false; // defensive; replay never builds cycles
    cur = parents.get(cur) ?? null;
  }
  return false;
}

function insertSorted(arr: SetOp[], op: SetOp): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].hlc < op.hlc) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, op);
}
