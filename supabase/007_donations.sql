-- «Охота на лис» — дополнение 7: поддержка игры звёздами Telegram (бот записывает каждую оплату)
create table if not exists donations (
  charge_id  text primary key,                 -- telegram_payment_charge_id: по нему же делается возврат (refundStarPayment)
  tg_id      bigint not null,
  tg_user    text,
  name       text,
  stars      int not null,
  created_at timestamptz not null default now()
);
alter table donations enable row level security;   -- игрокам не видна, пишет только функция бота
grant select, insert, update, delete on donations to service_role;
select 'Готово ✅ (дополнение 7)' as result;
