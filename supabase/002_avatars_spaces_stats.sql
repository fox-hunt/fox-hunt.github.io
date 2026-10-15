-- «Охота на лис» — дополнение 2: аватарки, ник с пробелами, «мой рейтинг»
-- Вставить целиком в SQL Editor и нажать Run. Можно запускать повторно.

-- ---------- аватарки: файл avatars/<id игрока>.jpg, номер версии в профиле ----------
alter table profiles add column if not exists avatar_v bigint;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 204800, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 204800, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "fox avatar read own"   on storage.objects;
drop policy if exists "fox avatar insert own" on storage.objects;
drop policy if exists "fox avatar update own" on storage.objects;
drop policy if exists "fox avatar delete own" on storage.objects;
create policy "fox avatar read own"   on storage.objects for select to authenticated using (bucket_id = 'avatars' and name = auth.uid()::text || '.jpg');
create policy "fox avatar insert own" on storage.objects for insert to authenticated with check (bucket_id = 'avatars' and name = auth.uid()::text || '.jpg');
create policy "fox avatar update own" on storage.objects for update to authenticated using (bucket_id = 'avatars' and name = auth.uid()::text || '.jpg') with check (bucket_id = 'avatars' and name = auth.uid()::text || '.jpg');
create policy "fox avatar delete own" on storage.objects for delete to authenticated using (bucket_id = 'avatars' and name = auth.uid()::text || '.jpg');

create or replace function set_avatar(p_v bigint) returns void
language sql security definer set search_path = public as $$
  update profiles set avatar_v = p_v where id = auth.uid()
$$;

-- ---------- ник: слова через одиночный пробел ----------
create or replace function set_nick(p_nick text) returns json
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n text := regexp_replace(btrim(p_nick), '\s+', ' ', 'g');
begin
  if uid is null then raise exception 'auth'; end if;
  if char_length(n) not between 3 and 16 or n !~ '^[A-Za-zА-Яа-яЁё0-9_-]+( [A-Za-zА-Яа-яЁё0-9_-]+)*$' then raise exception 'nick_format'; end if;
  if lower(replace(n, ' ', '')) ~ '(хуй|пизд|еба|бля|fuck|shit)' then raise exception 'nick_bad'; end if;
  begin
    insert into profiles (id, nick) values (uid, n)
    on conflict (id) do update set nick = excluded.nick;
  exception when unique_violation then raise exception 'nick_taken';
  end;
  return my_profile();
end $$;

create or replace function nick_free(p_nick text) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from profiles
    where lower(nick) = lower(regexp_replace(btrim(p_nick), '\s+', ' ', 'g')) and id is distinct from auth.uid())
$$;

-- ---------- профиль и таблица дня теперь знают про аватарку ----------
create or replace function my_profile() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'id', p.id, 'nick', p.nick, 'public', p.public, 'code', p.code, 'ava', p.avatar_v,
    'anon', coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false),
    'friends', coalesce((select json_agg(json_build_object('id', q.id, 'nick', q.nick, 'ava', q.avatar_v) order by lower(q.nick))
                         from friends f join profiles q on q.id = f.friend_id where f.user_id = p.id), '[]'::json))
  from profiles p where p.id = auth.uid()
$$;

create or replace function day_board(p_level text, p_day date, p_scope text default 'all') returns json
language sql stable security definer set search_path = public as $$
  with me as (select auth.uid() as uid),
  base as (
    select r.user_id, r.moves, r.time_ms, r.hints, r.created_at, p.nick, p.avatar_v
    from results r join profiles p on p.id = r.user_id cross join me
    where r.level = p_level and r.game_day = p_day
      and (r.user_id = me.uid or (not r.flagged and case
            when p_scope = 'friends' then exists (select 1 from friends f where f.user_id = me.uid and f.friend_id = r.user_id)
            else p.public end))
  ),
  ranked as (select b.*, row_number() over (order by moves, time_ms, created_at)::int as rk from base b)
  select json_build_object(
    'total', (select count(*) from ranked),
    'rows', coalesce((select json_agg(json_build_object('rank', rk, 'id', user_id, 'nick', nick, 'ava', avatar_v, 'moves', moves, 'ms', time_ms,
                       'hints', hints, 'me', user_id = (select uid from me), 'streak', fox_streak(user_id)) order by rk)
                      from (select * from ranked order by rk limit 50) t), '[]'::json),
    'mine', (select json_build_object('rank', rk, 'id', user_id, 'nick', nick, 'ava', avatar_v, 'moves', moves, 'ms', time_ms, 'hints', hints,
                     'me', true, 'streak', fox_streak(user_id)) from ranked where user_id = (select uid from me)),
    'dist', coalesce((select json_agg(json_build_object('m', moves, 'n', c) order by moves)
                      from (select moves, count(*) c from ranked group by moves) z), '[]'::json)
  )
$$;

-- ---------- мой рейтинг: сводка по всем моим играм дня ----------
create or replace function my_stats() returns json
language sql stable security definer set search_path = public as $$
  with mine as (select level, game_day, moves, time_ms, created_at from results where user_id = auth.uid()),
  rated as (
    select m.*,
      (select count(*) from results r join profiles p on p.id = r.user_id
        where r.level = m.level and r.game_day = m.game_day and r.user_id <> auth.uid() and not r.flagged and p.public) as others,
      (select count(*) from results r join profiles p on p.id = r.user_id
        where r.level = m.level and r.game_day = m.game_day and r.user_id <> auth.uid() and not r.flagged and p.public
          and (r.moves, r.time_ms, r.created_at) < (m.moves, m.time_ms, m.created_at)) + 1 as rk,
      (select count(*) from results r join profiles p on p.id = r.user_id
        where r.level = m.level and r.game_day = m.game_day and r.user_id <> auth.uid() and not r.flagged and p.public
          and r.moves > m.moves) as worse
    from mine m
  )
  select json_build_object(
    'streak', fox_streak(auth.uid()),
    'days',   (select count(distinct game_day) from rated),
    'games',  (select count(*) from rated),
    'first',  (select count(*) from rated where rk = 1 and others > 0),
    'top3',   (select count(*) from rated where rk <= 3 and others > 0),
    'best',   (select min(rk) from rated where others > 0),
    'pct',    (select round(avg(100.0 * worse / others)) from rated where others > 0),
    'levels', coalesce((select json_object_agg(level, best) from (select level, min(moves) best from rated group by level) l), '{}'::json)
  )
$$;

revoke execute on function set_avatar(bigint), my_stats() from public, anon;
grant execute on function set_avatar(bigint), my_stats() to authenticated;

select 'Готово ✅ (дополнение 2)' as result;
