-- Run once in Supabase SQL Editor.
-- TubeGrab's browser never receives the service-role key; only Render/GitHub use it.

create table if not exists public.tubegrab_jobs (
  id uuid primary key,
  url text not null,
  type text not null check (type in ('video', 'audio')),
  quality text not null check (quality in ('360', '720', '1080')),
  status text not null default 'queued' check (status in ('queued', 'running', 'complete', 'failed', 'expired')),
  phase text not null default 'queued',
  progress double precision not null default 0,
  speed text,
  eta text,
  title text,
  error text,
  object_path text,
  file_name text,
  file_size bigint,
  max_file_mb integer not null default 750,
  max_duration_sec integer not null default 7200,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tubegrab_jobs_expires_idx
  on public.tubegrab_jobs (expires_at)
  where object_path is not null;

alter table public.tubegrab_jobs enable row level security;

-- No anon/authenticated policies are intentionally created. The website and
-- worker use the service-role key server-side, which bypasses RLS.

insert into storage.buckets (id, name, public, file_size_limit)
values ('tubegrab-temp', 'tubegrab-temp', false, 786432000)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;
