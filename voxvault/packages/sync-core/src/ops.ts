import { parseHlc, type Hlc } from './hlc.ts';

export type Entity = 'folder' | 'note';
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/**
 * The only operation type: set one field of one entity.
 * Creating an entity = setting its fields. Deleting = setting `deleted: true`.
 * Each (entity, id, field) is a last-writer-wins register ordered by HLC.
 */
export interface SetOp {
  hlc: Hlc;
  entity: Entity;
  id: string;
  field: string;
  value: Json;
}

export const FIELDS: Record<Entity, readonly string[]> = {
  folder: ['name', 'parent_id', 'deleted'],
  note: ['title', 'body_md', 'folder_id', 'status', 'deleted', 'embedding', 'embedding_model'],
};

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

/** Validate an op from an untrusted source (another device, after decryption). */
export function validateOp(raw: unknown): SetOp {
  if (typeof raw !== 'object' || raw === null) throw new Error('op must be an object');
  const op = raw as Record<string, unknown>;
  if (typeof op.hlc !== 'string') throw new Error('op.hlc must be a string');
  parseHlc(op.hlc);
  if (op.entity !== 'folder' && op.entity !== 'note') throw new Error('op.entity invalid');
  if (!isValidId(op.id)) throw new Error('op.id invalid');
  if (typeof op.field !== 'string' || !FIELDS[op.entity].includes(op.field)) {
    throw new Error(`op.field invalid: ${String(op.field)}`);
  }
  const value = op.value as Json;
  switch (op.field) {
    case 'name':
    case 'title':
    case 'body_md':
    case 'embedding_model':
      if (typeof value !== 'string') throw new Error(`${op.field} must be a string`);
      break;
    case 'parent_id':
    case 'folder_id':
      if (value !== null && !isValidId(value)) throw new Error(`${op.field} must be an id or null`);
      break;
    case 'deleted':
      if (typeof value !== 'boolean') throw new Error('deleted must be a boolean');
      break;
    case 'status':
      if (value !== 'inbox' && value !== 'filed') throw new Error('status must be inbox|filed');
      break;
    case 'embedding':
      if (value !== null && !(Array.isArray(value) && value.every((v) => typeof v === 'number'))) {
        throw new Error('embedding must be a number[] or null');
      }
      break;
  }
  return { hlc: op.hlc, entity: op.entity, id: op.id, field: op.field, value };
}
