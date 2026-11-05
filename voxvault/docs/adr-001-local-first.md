# ADR-001: Local-first, federated note storage

**Status:** Proposed · **Date:** 2026-11-05

## Decision

Each device is the **owner of its own notes**. The source of truth is a local SQLite database on the device. Syncing across devices is **opt-in**. When it's on, devices exchange changes through replicas, and the server only relays them. There is no central cloud store by default.

## Why

- **Security/privacy:** there's no central store to breach, and notes are encrypted in transit and at rest on the relay. This also sets us apart from Voicenotes, Otter and others, which are cloud-first.
- **Scaling/cost:** the server stores and forwards small encrypted change logs. Search and indexing run on the device.
- **Offline:** capture, search and filing all work with no network.

## Storage budget (per device)

| Item | Size | 10k notes |
|---|---|---|
| Markdown text | ~2 KB/note | ~20 MB |
| Embedding, 1536-d float32 | 6 KB/note | ~60 MB |
| Embedding, 512-d float32 | 2 KB/note | ~20 MB |
| Embedding, 384-d int8 (on-device model) | 0.4 KB/note | ~4 MB |

Text is cheap, but **the embeddings take more space than the text**. Default to 512-d (`text-embedding-3-small` supports `dimensions=512`) or a small on-device model. Audio is the real space hog: delete it after transcription, or keep it on one device only.

## Local stack

- **DB:** SQLite (`folders`, `notes`, `note_events`). Same shape as `db/schema.sql`.
- **Vector search:** `sqlite-vec` (brute-force search is fine up to ~100k notes on a phone).
- **Full-text search:** SQLite FTS5 for keyword + hybrid search.
- **Sync engine options:** cr-sqlite (CRDT SQLite), Automerge, or PowerSync/ElectricSQL. Choose one that supports **tree move** semantics (see risks).

## Sync model

```
 Device A (SQLite) ◄──E2EE change log──► Relay (stores ciphertext only) ◄──► Device B (SQLite)
```

- Every change is a CRDT op (create/edit/move/delete) with a hybrid logical clock.
- The relay never sees plaintext. Keys come from the user's account and are shared between devices by pairing (QR code / passkey).
- New device = pull a snapshot + log, then index embeddings locally.

## Consequences / open problems

1. **The cloud steps in the ingestion pipeline still see the data.** Whisper/Deepgram and GPT-4o-mini receive the audio and text. To make the privacy claim honest, offer on-device options: Apple Speech / whisper.cpp for transcription, a small local LLM for categorization. Otherwise say plainly that it's "private at rest, processed by X."
2. **Claude/ChatGPT connectors need a reachable server.** Remote MCP connectors call a URL. A phone can't reliably host one (iOS kills background servers). Options:
   - **a. Local MCP:** a desktop app that holds a replica and runs a stdio MCP server for Claude Desktop/Code. Fully private, desktop only.
   - **b. Cloud replica as a "device":** the user opts in to a server-side replica that holds the decryption key, so the remote MCP works on claude.ai/ChatGPT. This breaks E2EE for that user, so make it an explicit choice.
   - **c. Live tunnel to a desktop replica:** remote MCP that proxies to the user's online desktop. Fails when that desktop is offline.
   - **Recommendation:** ship **a** first. Add **b** as an opt-in "Connect to Claude.ai/ChatGPT" toggle with clear disclosure.
3. **Conflicting folder moves.** Two devices moving/renaming folders concurrently can create cycles or orphans. Use a move-CRDT (Kleppmann et al., "A highly-available move operation for replicated trees") or detect cycles at merge time and send the note to the Inbox.
4. **Concurrent re-filing by LLM + user.** Log the actor in `note_events`. The user's moves beat LLM moves on conflict.
5. **Embedding model must match across devices.** Store `embedding_model` + `dim` per note. Re-embed on model change.
6. **Recovery.** If every device is lost and sync was off, the notes are gone. Offer encrypted export / backup.
