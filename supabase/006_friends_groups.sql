-- «Охота на лис» — дополнение 6: друзья-звёздочки и компании
-- Можно запускать повторно.
--   друзья  — ⭐ отмечаешь игрока в таблице дня (в одну сторону, как «подписка»); вкладка «Друзья» — я и отмеченные
--   компании — группа по приглашению: ссылка с кодом, кто открыл — вступил; у каждой компании своя таблица дня

create table if not exists fox_groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  code       text not null unique,
  owner      uuid references profiles on delete set null,
  created_at timestamptz not null default now()
);
create table if not exists group_members (
  group_id  uuid references fox_groups on delete cascade,
  user_id   uuid references profiles on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists group_members_user on group_members (user_id);
alter table fox_groups    enable row level security;
alter table group_members enable row level security;
revoke all on fox_groups, group_members from anon, authenticated;
grant all on fox_groups, group_members to service_role;

-- компания без участников исчезает (и когда последний удалил аккаунт)
create or replace function fox_group_gc() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from fox_groups g where g.id = old.group_id and not exists (select 1 from group_members m where m.group_id = g.id);
  return null;
end $$;
drop trigger if exists group_members_gc on group_members;
create trigger group_members_gc after delete on group_members for each row execute function fox_group_gc();
delete from fox_groups g where not exists (select 1 from group_members m where m.group_id = g.id);

-- ---------- профиль: друзья и компании ----------
create or replace function my_profile() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'id', p.id, 'nick', p.nick, 'public', p.public, 'code', p.code, 'ava', p.avatar_v,
    'tg', (select coalesce('@' || l.tg_user, 'Telegram') from tg_links l where l.user_id = p.id),
    'anon', coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false),
    'friends', coalesce((select json_agg(json_build_object('id', q.id, 'nick', q.nick, 'ava', q.avatar_v) order by lower(q.nick))
                         from friends f join profiles q on q.id = f.friend_id where f.user_id = p.id), '[]'::json),
    'groups', coalesce((select json_agg(json_build_object('id', g.id, 'name', g.name, 'code', g.code, 'own', g.owner = p.id,
                          'n', (select count(*) from group_members x where x.group_id = g.id)) order by m.joined_at)
                        from group_members m join fox_groups g on g.id = m.group_id where m.user_id = p.id), '[]'::json))
  from profiles p where p.id = auth.uid()
$$;

-- ⭐ отметить / снять (только в мою сторону)
create or replace function star_friend(p_id uuid, p_on boolean) returns json
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if not exists (select 1 from profiles where id = uid) then raise exception 'nick'; end if;
  if p_id = uid then raise exception 'friend_self'; end if;
  if p_on then insert into friends (user_id, friend_id) select uid, p_id where exists (select 1 from profiles where id = p_id) on conflict do nothing;
  else delete from friends where user_id = uid and friend_id = p_id; end if;
  return my_profile();
end $$;

-- ---------- компании ----------
create or replace function group_name_ok(p_name text) returns text
language plpgsql immutable as $$
declare n text := regexp_replace(btrim(p_name), '\s+', ' ', 'g');
begin
  if char_length(n) not between 2 and 24 then raise exception 'group_name'; end if;
  if lower(replace(n, ' ', '')) ~ '(хуй|пизд|еба|бля|fuck|shit)' then raise exception 'group_name'; end if;
  return n;
end $$;

create or replace function create_group(p_name text) returns json
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n text := group_name_ok(p_name); c text; gid uuid;
begin
  if not exists (select 1 from profiles where id = uid) then raise exception 'nick'; end if;
  if (select count(*) from fox_groups where owner = uid) >= 10 then raise exception 'group_limit'; end if;
  loop
    c := (select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '') from generate_series(1, 6));
    exit when not exists (select 1 from fox_groups where code = c);
  end loop;
  insert into fox_groups (name, code, owner) values (n, c, uid) returning id into gid;
  insert into group_members (group_id, user_id) values (gid, uid);
  return json_build_object('id', gid, 'name', n, 'code', c, 'profile', my_profile());
end $$;

create or replace function join_group(p_code text) returns json
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); g fox_groups;
begin
  if not exists (select 1 from profiles where id = uid) then raise exception 'nick'; end if;
  select * into g from fox_groups where code = upper(btrim(p_code));
  if g.id is null then raise exception 'group_notfound'; end if;
  if (select count(*) from group_members where user_id = uid) >= 20 then raise exception 'group_limit'; end if;
  insert into group_members (group_id, user_id) values (g.id, uid) on conflict do nothing;
  return json_build_object('id', g.id, 'name', g.name, 'code', g.code, 'profile', my_profile());
end $$;

create or replace function rename_group(p_id uuid, p_name text) returns json
language plpgsql security definer set search_path = public as $$
begin
  update fox_groups set name = group_name_ok(p_name) where id = p_id and owner = auth.uid();
  return my_profile();
end $$;

-- выйти; последний вышедший — компания исчезает
create or replace function leave_group(p_id uuid) returns json
language plpgsql security definer set search_path = public as $$
begin
  delete from group_members where group_id = p_id and user_id = auth.uid();
  delete from fox_groups g where g.id = p_id and not exists (select 1 from group_members m where m.group_id = g.id);
  return my_profile();
end $$;

-- ---------- таблица дня: p_scope 'all' | 'friends' (я и отмеченные) | 'g:<id компании>' (если я в ней) ----------
create or replace function day_board(p_level text, p_day date, p_scope text default 'all') returns json
language sql stable security definer set search_path = public as $$
  with me as (select auth.uid() as uid),
  grp as (select case when p_scope like 'g:%' then substr(p_scope, 3) end as gid),
  base as (
    select r.user_id, r.moves, r.time_ms, r.hints, r.created_at, p.nick, p.avatar_v
    from results r join profiles p on p.id = r.user_id cross join me cross join grp
    where r.level = p_level and r.game_day = p_day
      and (case
            when p_scope = 'friends' then r.user_id = me.uid or (not r.flagged and exists (select 1 from friends f where f.user_id = me.uid and f.friend_id = r.user_id))
            when grp.gid is not null then exists (select 1 from group_members a where a.group_id::text = grp.gid and a.user_id = me.uid)
                                      and exists (select 1 from group_members b where b.group_id::text = grp.gid and b.user_id = r.user_id)
                                      and (r.user_id = me.uid or not r.flagged)
            else r.user_id = me.uid or (not r.flagged and p.public) end)
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

revoke execute on function star_friend(uuid, boolean), create_group(text), join_group(text), rename_group(uuid, text), leave_group(uuid), group_name_ok(text) from public, anon;
grant execute on function star_friend(uuid, boolean), create_group(text), join_group(text), rename_group(uuid, text), leave_group(uuid) to authenticated;

select 'Готово ✅ (дополнение 6)' as result;
