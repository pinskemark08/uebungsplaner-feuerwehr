create table if not exists public.roadster_project_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz not null default now()
);

alter table public.roadster_project_state enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'roadster_project_state'
  ) then
    alter publication supabase_realtime add table public.roadster_project_state;
  end if;
end
$$;

drop policy if exists "Users read their own roadster state" on public.roadster_project_state;
create policy "Users read their own roadster state"
  on public.roadster_project_state for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users create their own roadster state" on public.roadster_project_state;
create policy "Users create their own roadster state"
  on public.roadster_project_state for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users update their own roadster state" on public.roadster_project_state;
create policy "Users update their own roadster state"
  on public.roadster_project_state for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public)
values ('roadster-files', 'roadster-files', false)
on conflict (id) do update set public = false;

drop policy if exists "Users read their own roadster files" on storage.objects;
create policy "Users read their own roadster files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'roadster-files'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users upload their own roadster files" on storage.objects;
create policy "Users upload their own roadster files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'roadster-files'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users update their own roadster files" on storage.objects;
create policy "Users update their own roadster files"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'roadster-files'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'roadster-files'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users delete their own roadster files" on storage.objects;
create policy "Users delete their own roadster files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'roadster-files'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
