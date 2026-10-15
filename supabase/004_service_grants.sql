-- «Охота на лис» — дополнение 4: права для серверной функции входа через Telegram
grant select, insert, update, delete on tg_logins, tg_links, profiles to service_role;
select 'Готово ✅ (дополнение 4)' as result;
