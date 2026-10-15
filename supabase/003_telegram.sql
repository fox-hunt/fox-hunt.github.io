-- «Охота на лис» — дополнение 3: вход через Telegram
-- Вставить целиком в SQL Editor и нажать Run. Можно запускать повторно.

-- одноразовые заявки на вход: игра придумывает nonce, бот записывает, кто нажал Start
create table if not exists tg_logins (
  nonce      text primary key,
  tg_id      bigint not null,
  tg_name    text,
  tg_user    text,
  created_at timestamptz not null default now()
);
-- какой Telegram привязан к какому игроку
create table if not exists tg_links (
  tg_id      bigint primary key,
  user_id    uuid not null unique references auth.users on delete cascade,
  tg_user    text,
  created_at timestamptz not null default now()
);
alter table tg_logins enable row level security;
alter table tg_links  enable row level security;
revoke all on tg_logins, tg_links from anon, authenticated;

-- профиль показывает, привязан ли Telegram
create or replace function my_profile() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'id', p.id, 'nick', p.nick, 'public', p.public, 'code', p.code, 'ava', p.avatar_v,
    'tg', (select coalesce('@' || l.tg_user, 'Telegram') from tg_links l where l.user_id = p.id),
    'anon', coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false),
    'friends', coalesce((select json_agg(json_build_object('id', q.id, 'nick', q.nick, 'ava', q.avatar_v) order by lower(q.nick))
                         from friends f join profiles q on q.id = f.friend_id where f.user_id = p.id), '[]'::json))
  from profiles p where p.id = auth.uid()
$$;

select 'Готово ✅ (дополнение 3)' as result;
