# VoxVault (working name)

Voice notes that file themselves, and that Claude/ChatGPT can search **and reorganize**.

- **Capture:** mobile app (Flutter / React Native) records, caches and uploads audio.
- **Ingest:** Whisper/Deepgram → GPT-4o-mini structured output `{folder, subfolder, title, clean_markdown, confidence}` → upsert folders → save note → embed (`text-embedding-3-small`, 1536-d).
- **Store (local-first):** each device owns its notes in SQLite + `sqlite-vec` + FTS5. Optional E2EE sync between device replicas through a relay that never sees plaintext. Postgres (`db/schema.sql`) is only for the opt-in cloud replica. See `docs/adr-001-local-first.md`.
- **Bridge:** REST + OpenAPI (Custom GPT Actions) **and** a remote MCP server with OAuth 2.1 (Claude connectors, ChatGPT apps). Both sit on one service layer.

## Layout

| Path | What |
|---|---|
| `docs/market-research.md` | Competitive landscape, market signals, verdict |
| `docs/architecture.md` | Pipelines and MCP tool design |
| `docs/adr-001-local-first.md` | Federated/local-first storage and sync decision |
| `db/schema.sql` | Postgres/pgvector schema for the opt-in cloud replica |
| `packages/sync-core/` | Merge rules (change records, clock, folder-move handling), E2EE, sync client. Runs in Node, React Native, browsers |
| `apps/relay/` | Store-and-forward relay (Fastify + SQLite). Only ever sees ciphertext |
| `apps/cli-device/` | `vox` CLI: a fake device with its own SQLite file, for testing sync with real processes |
| `scripts/` | `vox` wrapper, `demo.sh`, `network.sh` (fault injection), toxiproxy config |
| `api/openapi.yaml` | REST contract (also the source for MCP tool definitions) |

## Running sync locally

Requires Node 22.18+ (runs TypeScript directly, no build step).

```bash
cd voxvault
npm install
npm test                 # 27 tests: merge rules, random convergence, crypto, relay, flaky network
npm run typecheck

npm run relay            # terminal 1: relay on http://localhost:8787
scripts/demo.sh          # terminal 2: two devices, concurrent edits, convergence
```

Use the CLI yourself (one directory = one device):

```bash
scripts/vox --dir .devices/phone init --relay http://localhost:8787 --name phone   # prints a pairing code
scripts/vox --dir .devices/laptop join <CODE> --relay http://localhost:8787
scripts/vox --dir .devices/phone note add "Idea" "voice notes that file themselves"
scripts/vox --dir .devices/phone sync && scripts/vox --dir .devices/laptop sync
scripts/vox --dir .devices/laptop ls
scripts/vox --dir .devices/laptop watch          # keep syncing every 2s
```

Bad-network testing with Docker:

```bash
docker compose up -d --build                     # relay on :8787, same relay through toxiproxy on :8788
scripts/vox --dir .devices/a init --relay http://localhost:8788
scripts/network.sh slow | flaky | down | up | reset
```

### How sync works

- Every change is a small record `{hlc, entity, id, field, value}`. Each field keeps the value with the latest hybrid-logical-clock timestamp, so devices that hold the same changes show the same notebook regardless of arrival order.
- Folder moves are replayed in timestamp order; a move that would put a folder inside itself is skipped.
- Deleting a folder hides its subtree; notes that were in it go to the Inbox instead of disappearing.
- Changes are encrypted on the device (XChaCha20-Poly1305) with a key derived from the pairing code. The relay stores ciphertext and a hash of an access token; it cannot read notes.

### Known limits (MVP)

- The relay keeps every change forever (no compaction/snapshots yet).
- The first device to write to a space claims it; there's no account system or key rotation yet. Anyone with the pairing code has full access.
- Devices poll; no push notifications/websocket yet.
- Note bodies merge last-write-wins (a concurrent edit to the same body on two devices keeps only the later one).

## Next steps

0. ~~Sync engine, relay, CLI test device~~ (done)
1. Ingestion worker (FastAPI + a queue): transcribe → categorize → embed.
2. Remote MCP server exposing `search_notes`, `get_note`, `create_note`, `move_note`, `create_folder`, `merge_notes`.
3. Mobile capture app with an **Inbox** for low-confidence auto-filing.
