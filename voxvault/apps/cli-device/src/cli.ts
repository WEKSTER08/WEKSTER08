import { parseArgs } from 'node:util';
import { deriveSpaceKeys, keysFromPairingCode, newSpaceSecret, type Folder, type Note, type Snapshot } from '@voxvault/sync-core';
import { Device } from './device.ts';

const HELP = `vox — a VoxVault test device (one directory = one device)

Usage: vox [--dir DIR] <command> [...]

Setup
  init  --relay URL [--name NAME]          start a new sync space, prints a pairing code
  join  CODE --relay URL [--name NAME]     join an existing space with a pairing code
  pairing-code                             print this space's pairing code again

Folders
  folder add NAME [--parent REF]
  folder mv REF (--parent REF | --root)
  folder rename REF NAME
  folder rm REF                            notes inside go to the Inbox

Notes
  note add TITLE [BODY] [--folder REF]     no --folder = Inbox
  note mv REF (--folder REF | --inbox)
  note edit REF [--title T] [--body B]
  note rm REF
  note show REF

Sync
  ls                                       print the folder tree and Inbox
  sync                                     push local changes, pull everyone else's
  watch [--interval SECONDS]               sync in a loop (default 2s)

REF = an id prefix (shown in ls) or an exact name/title.
DIR defaults to $VOX_DIR or ./.devices/default
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string' },
    relay: { type: 'string' },
    name: { type: 'string' },
    parent: { type: 'string' },
    root: { type: 'boolean' },
    folder: { type: 'string' },
    inbox: { type: 'boolean' },
    title: { type: 'string' },
    body: { type: 'string' },
    interval: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const dir = values.dir ?? process.env.VOX_DIR ?? '.devices/default';
const [cmd, sub, ...rest] = positionals;

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function resolve<T extends { id: string }>(items: T[], ref: string, label: (x: T) => string, kind: string): T {
  const exact = items.filter((x) => x.id === ref || label(x).toLowerCase() === ref.toLowerCase());
  const matches = exact.length ? exact : ref.length >= 3 ? items.filter((x) => x.id.startsWith(ref)) : [];
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) fail(`no ${kind} matches "${ref}"`);
  fail(`"${ref}" matches ${matches.length} ${kind}s; use an id prefix: ${matches.map((m) => m.id.slice(0, 6)).join(', ')}`);
}

const folderRef = (s: Snapshot, ref: string): Folder => resolve(s.folders, ref, (f) => f.name, 'folder');
const noteRef = (s: Snapshot, ref: string): Note => resolve(s.notes, ref, (n) => n.title, 'note');

function printTree(s: Snapshot): void {
  const children = new Map<string | null, Folder[]>();
  for (const f of s.folders) children.set(f.parent_id, [...(children.get(f.parent_id) ?? []), f]);
  const notesIn = new Map<string | null, Note[]>();
  for (const n of s.notes) notesIn.set(n.folder_id, [...(notesIn.get(n.folder_id) ?? []), n]);
  const byName = (a: { name?: string; title?: string }, b: { name?: string; title?: string }) =>
    (a.name ?? a.title ?? '').localeCompare(b.name ?? b.title ?? '');

  const walk = (parent: string | null, indent: string) => {
    for (const f of (children.get(parent) ?? []).sort(byName)) {
      console.log(`${indent}📁 ${f.name}  [${f.id.slice(0, 6)}]`);
      for (const n of (notesIn.get(f.id) ?? []).sort(byName)) console.log(`${indent}   📝 ${n.title}  [${n.id.slice(0, 6)}]`);
      walk(f.id, indent + '   ');
    }
  };
  walk(null, '');
  const inbox = (notesIn.get(null) ?? []).sort(byName);
  console.log(`📥 Inbox (${inbox.length})`);
  for (const n of inbox) console.log(`   📝 ${n.title}  [${n.id.slice(0, 6)}]`);
}

async function syncOnce(d: Device, quiet = false): Promise<void> {
  try {
    const r = await d.client.sync();
    if (!quiet || r.pushed || r.applied || r.rejected) {
      console.log(`synced: pushed ${r.pushed}, pulled ${r.pulled}, applied ${r.applied}${r.rejected ? `, REJECTED ${r.rejected}` : ''}`);
    }
  } catch (e) {
    console.error(`sync failed (changes are kept locally and retried): ${(e as Error).message}`);
    if (!quiet) process.exitCode = 2;
  }
}

async function main(): Promise<void> {
  if (values.help || !cmd || cmd === 'help') {
    console.log(HELP);
    return;
  }

  if (cmd === 'init' || cmd === 'join') {
    if (!values.relay) fail('--relay URL is required');
    const code = cmd === 'init' ? deriveSpaceKeys(newSpaceSecret()).pairingCode : sub;
    if (!code) fail('pairing code required: vox join CODE --relay URL');
    try {
      keysFromPairingCode(code);
    } catch (e) {
      fail((e as Error).message);
    }
    const d = Device.init(dir, values.relay, code, values.name);
    console.log(`device ${d.replica.nodeId} ready in ${dir}`);
    if (cmd === 'init') {
      console.log(`\npairing code (treat it like a password; anyone with it can read your notes):\n\n  ${code}\n`);
    } else {
      await syncOnce(d);
    }
    d.close();
    return;
  }

  const d = Device.open(dir);
  try {
    const r = d.replica;
    const s = r.snapshot();
    switch (`${cmd} ${sub ?? ''}`.trim()) {
      case 'pairing-code':
        console.log(d.keys.pairingCode);
        break;
      case 'ls':
        printTree(s);
        if (d.client.state.outbox.length) console.log(`\n(${d.client.state.outbox.length} change(s) not synced yet)`);
        break;
      case 'folder add': {
        if (!rest[0]) fail('folder name required');
        const id = r.createFolder(rest[0], values.parent ? folderRef(s, values.parent).id : null);
        console.log(`created folder ${rest[0]} [${id.slice(0, 6)}]`);
        break;
      }
      case 'folder mv': {
        if (!rest[0]) fail('folder ref required');
        if (!values.parent && !values.root) fail('use --parent REF or --root');
        r.moveFolder(folderRef(s, rest[0]).id, values.root ? null : folderRef(s, values.parent!).id);
        console.log('moved');
        break;
      }
      case 'folder rename':
        if (!rest[0] || !rest[1]) fail('usage: folder rename REF NAME');
        r.renameFolder(folderRef(s, rest[0]).id, rest[1]);
        console.log('renamed');
        break;
      case 'folder rm':
        if (!rest[0]) fail('folder ref required');
        r.deleteFolder(folderRef(s, rest[0]).id);
        console.log('deleted (its notes are now in the Inbox)');
        break;
      case 'note add': {
        if (!rest[0]) fail('note title required');
        const id = r.createNote({
          title: rest[0],
          body_md: rest[1] ?? '',
          folder_id: values.folder ? folderRef(s, values.folder).id : null,
        });
        console.log(`created note ${rest[0]} [${id.slice(0, 6)}]`);
        break;
      }
      case 'note mv': {
        if (!rest[0]) fail('note ref required');
        if (!values.folder && !values.inbox) fail('use --folder REF or --inbox');
        r.moveNote(noteRef(s, rest[0]).id, values.inbox ? null : folderRef(s, values.folder!).id);
        console.log('moved');
        break;
      }
      case 'note edit':
        if (!rest[0]) fail('note ref required');
        r.editNote(noteRef(s, rest[0]).id, { title: values.title, body_md: values.body });
        console.log('edited');
        break;
      case 'note rm':
        if (!rest[0]) fail('note ref required');
        r.deleteNote(noteRef(s, rest[0]).id);
        console.log('deleted');
        break;
      case 'note show': {
        if (!rest[0]) fail('note ref required');
        const n = noteRef(s, rest[0]);
        console.log(`# ${n.title}\n\n${n.body_md}\n\nid: ${n.id}\nfolder: ${n.folder_id ?? 'Inbox'}\nupdated: ${n.updated}`);
        break;
      }
      case 'sync':
        await syncOnce(d);
        break;
      case 'watch': {
        const secs = Number(values.interval ?? 2);
        console.log(`watching every ${secs}s (Ctrl+C to stop)`);
        for (;;) {
          await syncOnce(d, true);
          await new Promise((res) => setTimeout(res, secs * 1000));
        }
      }
      default:
        fail(`unknown command: ${cmd} ${sub ?? ''}\n\n${HELP}`);
    }
  } catch (e) {
    fail((e as Error).message);
  } finally {
    d.close();
  }
}

await main();
