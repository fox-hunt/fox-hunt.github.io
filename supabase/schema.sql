-- «Охота на лис» — общая таблица игры дня (Supabase / Postgres)
-- Вставить целиком в SQL Editor и нажать Run. Можно запускать повторно,
-- но потом обязательно снова запустить дополнения 002, 003 и 004: этот файл возвращает
-- старые версии my_profile / day_board / set_nick / nick_free и снимает права с функций из 002.
--
-- Устройство:
--   profiles — ник, «показывать другим», код друга
--   friends  — друзья (взаимно)
--   results  — результаты игры дня: только ПЕРВАЯ попытка, только победа, партия проверяется сервером
-- Таблицы закрыты (RLS без политик), всё — через функции ниже.

-- ---------- помощники: та же расстановка лис, что в игре ----------
-- Math.imul для беззнаковых 32-битных чисел
create or replace function fox_imul(a bigint, b bigint) returns bigint
language sql immutable as $$
  select ((a * (b & 65535)) + (((a * (b >> 16)) & 65535) << 16)) & 4294967295
$$;

-- точная копия seeded() + newState() из index.html: клетки с лисами для зерна 'fox|YYYY-MM-DD|level'
create or replace function fox_layout(seed text, n int, k int) returns int[]
language plpgsql immutable as $$
declare
  m constant bigint := 4294967295;
  h bigint; a bigint; t bigint; i int; cell int;
  foxes int[] := '{}';
begin
  h := (1779033703 # length(seed)::bigint) & m;
  for i in 1..length(seed) loop
    h := fox_imul(h # ascii(substr(seed, i, 1))::bigint, 3432918353);
    h := ((h << 13) & m) | (h >> 19);
  end loop;
  a := h;
  while coalesce(array_length(foxes, 1), 0) < k loop
    a := (a + 1831565813) & m;
    t := fox_imul(a # (a >> 15), 1 | a);
    t := ((t + fox_imul(t # (t >> 7), 61 | t)) & m) # t;
    cell := floor((((t # (t >> 14)) & m)::float8 / 4294967296.0) * n * n)::int;
    if not (cell = any(foxes)) then foxes := foxes || cell; end if;
  end loop;
  return foxes;
end $$;

create or replace function fox_new_code() returns text
language plpgsql volatile as $$
declare abc constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; c text;
begin
  c := 'LIS-';
  for i in 1..4 loop c := c || substr(abc, 1 + floor(random() * 32)::int, 1); end loop;
  return c;
end $$;

-- ---------- таблицы ----------
create table if not exists profiles (
  id         uuid primary key references auth.users on delete cascade,
  nick       text not null,
  public     boolean not null default true,
  code       text not null unique default fox_new_code(),
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_nick_lc on profiles (lower(nick));

create table if not exists friends (
  user_id   uuid references profiles on delete cascade,
  friend_id uuid references profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id)
);

create table if not exists results (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references profiles on delete cascade,
  level      text not null check (level in ('kid', 'classic', 'pro')),
  game_day   date not null,
  moves      int  not null,
  time_ms    int  not null,
  hints      boolean not null,
  opened     int[] not null,
  flagged    boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, level, game_day)
);
create index if not exists results_board on results (level, game_day, moves, time_ms);

alter table profiles enable row level security;
alter table friends  enable row level security;
alter table results  enable row level security;
revoke all on profiles, friends, results from anon, authenticated;

-- ---------- профиль ----------
create or replace function my_profile() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'id', p.id, 'nick', p.nick, 'public', p.public, 'code', p.code,
    'anon', coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false),
    'friends', coalesce((select json_agg(json_build_object('id', q.id, 'nick', q.nick) order by lower(q.nick))
                         from friends f join profiles q on q.id = f.friend_id where f.user_id = p.id), '[]'::json))
  from profiles p where p.id = auth.uid()
$$;

create or replace function nick_free(p_nick text) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from profiles where lower(nick) = lower(btrim(p_nick)) and id is distinct from auth.uid())
$$;

create or replace function set_nick(p_nick text) returns json
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n text := btrim(p_nick);
begin
  if uid is null then raise exception 'auth'; end if;
  if n !~ '^[A-Za-zА-Яа-яЁё0-9_-]{3,16}$' then raise exception 'nick_format'; end if;
  if lower(n) ~ '(хуй|пизд|еба|бля|fuck|shit)' then raise exception 'nick_bad'; end if;
  begin
    insert into profiles (id, nick) values (uid, n)
    on conflict (id) do update set nick = excluded.nick;
  exception when unique_violation then raise exception 'nick_taken';
  end;
  return my_profile();
end $$;

create or replace function set_public(p_on boolean) returns void
language sql security definer set search_path = public as $$
  update profiles set public = p_on where id = auth.uid()
$$;

create or replace function add_friend(p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); fid uuid; fnick text;
begin
  if not exists (select 1 from profiles where id = uid) then raise exception 'nick'; end if;
  select id, nick into fid, fnick from profiles where code = upper(btrim(p_code));
  if fid is null then raise exception 'friend_notfound'; end if;
  if fid = uid then raise exception 'friend_self'; end if;
  insert into friends (user_id, friend_id) values (uid, fid), (fid, uid) on conflict do nothing;
  return fnick;
end $$;

create or replace function remove_friend(p_id uuid) returns void
language sql security definer set search_path = public as $$
  delete from friends where (user_id = auth.uid() and friend_id = p_id) or (user_id = p_id and friend_id = auth.uid())
$$;

-- удаляет аккаунт целиком: профиль, друзей и результаты (каскадом)
create or replace function delete_account() returns void
language sql security definer set search_path = public as $$
  delete from auth.users where id = auth.uid()
$$;

-- ---------- серия: сколько дней подряд игрок проходил игру дня (по любому уровню) ----------
create or replace function fox_streak(u uuid) returns int
language sql stable security definer set search_path = public as $$
  with d as (select distinct game_day from results where user_id = u),
       g as (select game_day, game_day + (row_number() over (order by game_day desc))::int as grp from d)
  select case when (select max(game_day) from d) >= (now() at time zone 'utc')::date - 1
              then (select count(*)::int from g where grp = (select grp from g order by game_day desc limit 1))
              else 0 end
$$;

-- ---------- отправка результата игры дня ----------
-- p_opened — открытые клетки по порядку. Сервер сам пересчитывает расстановку и проверяет, что лисы найдены.
create or replace function submit_daily(p_level text, p_day date, p_time_ms int, p_hints boolean, p_opened int[])
returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  n int; k int; foxes int[]; mv int := coalesce(array_length(p_opened, 1), 0);
  today date := (now() at time zone 'utc')::date;
  susp boolean;
begin
  if uid is null then raise exception 'auth'; end if;
  if not exists (select 1 from profiles where id = uid) then raise exception 'nick'; end if;
  select x.n, x.k into n, k from (values ('kid', 8, 4), ('classic', 10, 5), ('pro', 12, 7)) as x(lv, n, k) where x.lv = p_level;
  if n is null then raise exception 'level'; end if;
  if p_day not between today - 1 and today + 1 then raise exception 'day'; end if;

  foxes := fox_layout('fox|' || to_char(p_day, 'YYYY-MM-DD') || '|' || p_level, n, k);
  if mv < k or mv > n * n
     or (select count(distinct c) from unnest(p_opened) c) <> mv
     or exists (select 1 from unnest(p_opened) c where c < 0 or c >= n * n)
     or not (foxes <@ p_opened)
     or not (p_opened[mv] = any(foxes))
  then raise exception 'invalid'; end if;
  if p_time_ms is null or p_time_ms < mv * 150 or p_time_ms > 86400000 then raise exception 'invalid'; end if;

  susp := mv <= k + 1;  -- почти без промахов: в общую таблицу не попадёт, но у игрока сохранится
  insert into results (user_id, level, game_day, moves, time_ms, hints, opened, flagged)
  values (uid, p_level, p_day, mv, p_time_ms, coalesce(p_hints, true), p_opened, susp)
  on conflict (user_id, level, game_day) do nothing;
  if not found then return json_build_object('status', 'already'); end if;
  return json_build_object('status', 'ok');
end $$;

-- ---------- таблица дня ----------
-- p_scope: 'all' — все, кто разрешил показывать; 'friends' — я и мои друзья
create or replace function day_board(p_level text, p_day date, p_scope text default 'all') returns json
language sql stable security definer set search_path = public as $$
  with me as (select auth.uid() as uid),
  base as (
    select r.user_id, r.moves, r.time_ms, r.hints, r.created_at, p.nick
    from results r join profiles p on p.id = r.user_id cross join me
    where r.level = p_level and r.game_day = p_day
      and (r.user_id = me.uid or (not r.flagged and case
            when p_scope = 'friends' then exists (select 1 from friends f where f.user_id = me.uid and f.friend_id = r.user_id)
            else p.public end))
  ),
  ranked as (select b.*, row_number() over (order by moves, time_ms, created_at)::int as rk from base b)
  select json_build_object(
    'total', (select count(*) from ranked),
    'rows', coalesce((select json_agg(json_build_object('rank', rk, 'nick', nick, 'moves', moves, 'ms', time_ms, 'hints', hints,
                       'me', user_id = (select uid from me), 'streak', fox_streak(user_id)) order by rk)
                      from (select * from ranked order by rk limit 50) t), '[]'::json),
    'mine', (select json_build_object('rank', rk, 'nick', nick, 'moves', moves, 'ms', time_ms, 'hints', hints, 'me', true,
                     'streak', fox_streak(user_id)) from ranked where user_id = (select uid from me)),
    'dist', coalesce((select json_agg(json_build_object('m', moves, 'n', c) order by moves)
                      from (select moves, count(*) c from ranked group by moves) z), '[]'::json)
  )
$$;

-- ---------- права: таблицы закрыты, функции открыты ----------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function day_board(text, date, text), nick_free(text), fox_layout(text, int, int), fox_imul(bigint, bigint) to anon, authenticated;
grant execute on function my_profile(), set_nick(text), set_public(boolean), add_friend(text), remove_friend(uuid),
  delete_account(), submit_daily(text, date, int, boolean, int[]) to authenticated;

select 'Готово ✅' as result;
