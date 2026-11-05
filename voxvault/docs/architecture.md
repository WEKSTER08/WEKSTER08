# Architecture

```
 Mobile app ──audio──► POST /recordings ──► queue ──► worker
                                                   │
                     ┌─────────────────────────────┘
                     ▼
     Transcribe (Whisper/Deepgram) → Categorize (LLM, JSON schema)
                     │
                     ▼  single DB transaction
     upsert folder/subfolder → insert note (status=inbox|filed) → embed
                     │
                     ▼
            Postgres + pgvector (system of record)
                     ▲
        ┌────────────┴─────────────┐
   REST/OpenAPI               Remote MCP server (OAuth 2.1)
   (app, Custom GPTs)         (Claude connectors, ChatGPT apps)
```

## Design decisions

- **One service layer, two transports.** REST handlers and MCP tools call the same functions, so behaviour and permissions can't drift apart.
- **Categorizer sees the existing tree.** Pass the user's current folder names into the prompt and prefer existing folders. Create a new one only above a confidence threshold. Otherwise, set `status=inbox`.
- **Confidence-gated filing.** If `confidence < 0.7`, the note goes to the Inbox for a one-tap confirm. This protects trust.
- **Scoped write access.** `notes.read`, `notes.write` and `folders.write` OAuth scopes, so a user can connect Claude read-only.
- **Audit log** (`note_events`) for every LLM-initiated move, with one-click undo in the app.
- **Re-embed on edit**, debounced. Embed `title + body_md`. Chunk long notes later if needed.

## MCP tools (v1)

| Tool | Maps to | Scope |
|---|---|---|
| `search_notes(query, folder?, limit?)` | `GET /notes` | notes.read |
| `get_note(id)` | `GET /notes/{id}` | notes.read |
| `list_folders()` | `GET /folders` | notes.read |
| `create_note(body_md, title?, folder_id?)` | `POST /notes` | notes.write |
| `move_note(id, folder_id)` | `PATCH /notes/{id}/reindex` | folders.write |
| `create_folder(name, parent_id?)` | `POST /folders` | folders.write |
| `merge_notes(ids[], title)` | _(v1.1)_ | notes.write |
