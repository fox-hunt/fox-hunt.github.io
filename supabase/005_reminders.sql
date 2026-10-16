-- «Охота на лис» — дополнение 5: бот напоминает об игре дня
-- Можно запускать повторно. Время напоминаний — по Москве.

-- кто писал боту и когда ему напоминать (remind_hour = null — напоминания выключены)
create table if not exists tg_chats (
  chat_id     bigint primary key,
  tg_user     text,
  remind_hour smallint default 19 check (remind_hour between 0 and 23),
  last_sent   date,
  sent_count  int not null default 0,
  blocked     boolean not null default false,             -- игрок остановил бота: не пишем, пока он снова не напишет
  chosen      boolean not null default false,             -- игрок сам выбрал время в /remind
  created_at  timestamptz not null default now()
);
alter table tg_chats add column if not exists chosen boolean not null default false;
alter table tg_chats enable row level security;
revoke all on tg_chats from anon, authenticated;
grant all on tg_chats to service_role;

-- все, кто входил через Telegram (напоминать начнём только после первой игры дня)
insert into tg_chats (chat_id, tg_user) select tg_id, tg_user from tg_links on conflict do nothing;

-- игрок написал боту: запомнить чат (настройки не трогаем)
create or replace function tg_seen(p_chat bigint, p_user text) returns void
language sql security definer set search_path = public as $$
  insert into tg_chats (chat_id, tg_user) values (p_chat, p_user)
  on conflict (chat_id) do update set tg_user = coalesce(excluded.tg_user, tg_chats.tg_user), blocked = false
$$;

-- p_hour: 0–23 — время, null — выключить; p_set = false — только прочитать. Возвращает текущее время (или null)
create or replace function tg_remind(p_chat bigint, p_hour smallint, p_set boolean default true) returns json
language plpgsql security definer set search_path = public as $$
declare h smallint;
begin
  insert into tg_chats (chat_id) values (p_chat) on conflict do nothing;
  if p_set then update tg_chats set remind_hour = p_hour, blocked = false, chosen = true where chat_id = p_chat; end if;
  select remind_hour into h from tg_chats where chat_id = p_chat;
  return json_build_object('hour', h);
end $$;

-- кому напомнить в этот час: кто хоть раз играл игру дня (или сам включил в /remind),
-- сегодня ещё не получал напоминание и ещё не сыграл
create or replace function tg_remind_due(p_hour int, p_day date) returns json
language sql stable security definer set search_path = public as $$
  with due as (
    select c.chat_id, c.sent_count, l.user_id
    from tg_chats c left join tg_links l on l.tg_id = c.chat_id
    where c.remind_hour = p_hour and not c.blocked and (c.last_sent is null or c.last_sent < p_day)
      and (c.chosen or exists (select 1 from results r where r.user_id = l.user_id))
  )
  select json_build_object(
    'players', (select count(distinct user_id) from results where game_day = p_day and not flagged),
    'due', coalesce((select json_agg(json_build_object('chat', chat_id, 'first', sent_count = 0, 'linked', user_id is not null,
                       'streak', case when user_id is null then 0 else fox_streak(user_id) end))
                     from due d
                     where d.user_id is null or not exists (select 1 from results r where r.user_id = d.user_id and r.game_day = p_day)), '[]'::json))
$$;

-- отметить разосланные (и тех, кто остановил бота)
create or replace function tg_remind_sent(p_sent bigint[], p_blocked bigint[], p_day date) returns void
language sql security definer set search_path = public as $$
  update tg_chats set last_sent = p_day, sent_count = sent_count + 1 where chat_id = any(p_sent);
  update tg_chats set blocked = true where chat_id = any(p_blocked);
$$;

revoke execute on function tg_seen(bigint, text), tg_remind(bigint, smallint, boolean), tg_remind_due(int, date), tg_remind_sent(bigint[], bigint[], date) from public, anon, authenticated;
grant execute on function tg_seen(bigint, text), tg_remind(bigint, smallint, boolean), tg_remind_due(int, date), tg_remind_sent(bigint[], bigint[], date) to service_role;

-- раз в час Supabase сам вызывает функцию бота (секрет — TG_SECRET, подставляется при установке)
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('fox-remind') where exists (select 1 from cron.job where jobname = 'fox-remind');
select cron.schedule('fox-remind', '0 * * * *', $cron$
  select net.http_post(
    url := 'https://ctzapxazhaaddgghztqw.supabase.co/functions/v1/tg',
    headers := '{"Content-Type": "application/json", "x-fox-cron": "__TG_SECRET__"}'::jsonb,
    body := '{"action": "remind"}'::jsonb)
$cron$);

select 'Готово ✅ (дополнение 5)' as result;
