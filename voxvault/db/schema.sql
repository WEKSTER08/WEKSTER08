-- VoxVault core schema (Supabase / PostgreSQL + pgvector)
-- NOTE: this schema is for the OPT-IN cloud replica only. The default store is per-device SQLite (see docs/adr-001-local-first.md).
create extension if not exists vector;
create extension if not exists pgcrypto;

-- Folders and subfolders share one table (parent_id null = top-level folder).
create table folders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  parent_id   uuid references folders(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now()
);
-- Folder names are unique per user within the same parent (nulls treated as equal).
create unique index folders_unique_name
  on folders (user_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

create type note_status as enum ('inbox', 'filed');

create table notes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  folder_id     uuid references folders(id) on delete set null,
  title         text not null,
  body_md       text not null,
  transcript    text,
  audio_path    text,                       -- Supabase Storage object key
  status        note_status not null default 'inbox',
  ai_confidence real,                       -- categorizer confidence 0..1
  embedding     vector(1536),               -- text-embedding-3-small
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index notes_user_folder on notes (user_id, folder_id);
create index notes_embedding on notes using hnsw (embedding vector_cosine_ops);

-- Audit trail: every move/rename made by the app or an external LLM connector.
create table note_events (
  id          bigserial primary key,
  note_id     uuid not null references notes(id) on delete cascade,
  actor       text not null,                -- 'app' | 'mcp:claude' | 'mcp:chatgpt' | ...
  action      text not null,                -- 'create' | 'move' | 'edit' | 'merge'
  payload     jsonb,
  created_at  timestamptz not null default now()
);

-- Row-level security: users only see their own rows.
alter table folders enable row level security;
alter table notes enable row level security;
alter table note_events enable row level security;
create policy own_folders on folders using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_notes   on notes   using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_events  on note_events
  using (exists (select 1 from notes n where n.id = note_id and n.user_id = auth.uid()));

-- Semantic search helper.
create or replace function match_notes(query_embedding vector(1536), match_count int default 10)
returns table (id uuid, title text, folder_id uuid, similarity float)
language sql stable as $$
  select n.id, n.title, n.folder_id, 1 - (n.embedding <=> query_embedding) as similarity
  from notes n
  where n.user_id = auth.uid() and n.embedding is not null
  order by n.embedding <=> query_embedding
  limit match_count;
$$;
