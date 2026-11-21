begin;

create table public.central_topics (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 70),
  created_at timestamptz not null default now(),
  unique (owner_id, id)
);

create unique index central_topics_unique_name
  on public.central_topics (owner_id, lower(btrim(name)));

create table public.central_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider text not null check (provider in ('Gmail', 'Outlook')),
  topic_id uuid,
  payload text not null check (char_length(payload) between 1 and 16000),
  created_at timestamptz not null default now(),
  foreign key (owner_id, topic_id) references public.central_topics(owner_id, id)
    on delete set null (topic_id)
);

alter table public.central_topics enable row level security;
alter table public.central_accounts enable row level security;

revoke all on public.central_topics, public.central_accounts from anon, authenticated;
grant select, insert, update, delete on public.central_topics, public.central_accounts to authenticated;

-- Adicione o UUID da única conta em ambas as políticas antes de executar.
create policy admin_topics on public.central_topics
  for all to authenticated
  using (owner_id = (select auth.uid()) and owner_id = '00000000-0000-0000-0000-000000000000'::uuid)
  with check (owner_id = (select auth.uid()) and owner_id = '00000000-0000-0000-0000-000000000000'::uuid);

create policy admin_accounts on public.central_accounts
  for all to authenticated
  using (owner_id = (select auth.uid()) and owner_id = '00000000-0000-0000-0000-000000000000'::uuid)
  with check (owner_id = (select auth.uid()) and owner_id = '00000000-0000-0000-0000-000000000000'::uuid);

commit;
