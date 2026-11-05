# VoxVault (working name)

Voice notes that file themselves, and that Claude/ChatGPT can search **and reorganize**.

- **Capture:** mobile app (Flutter / React Native) records, caches and uploads audio.
- **Ingest:** Whisper/Deepgram → GPT-4o-mini structured output `{folder, subfolder, title, clean_markdown, confidence}` → upsert folders → save note → embed (`text-embedding-3-small`, 1536-d).
- **Store:** Supabase Postgres + pgvector, strict Folder → Subfolder → Note tree, RLS per user.
- **Bridge:** REST + OpenAPI (Custom GPT Actions) **and** a remote MCP server with OAuth 2.1 (Claude connectors, ChatGPT apps). Both sit on one service layer.

## Layout

| Path | What |
|---|---|
| `docs/market-research.md` | Competitive landscape, market signals, verdict |
| `docs/architecture.md` | Pipelines and MCP tool design |
| `db/schema.sql` | Postgres/pgvector schema, RLS, `match_notes()` |
| `api/openapi.yaml` | REST contract (also the source for MCP tool definitions) |

## Next steps

1. Ingestion worker (FastAPI + a queue): transcribe → categorize → embed.
2. Remote MCP server exposing `search_notes`, `get_note`, `create_note`, `move_note`, `create_folder`, `merge_notes`.
3. Mobile capture app with an **Inbox** for low-confidence auto-filing.
