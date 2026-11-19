-- Бот «Харе Кришна Батуми» (функция hk-bot). Доступ к таблицам — только у функции
-- (прямое подключение к БД); через публичный API таблицы закрыты RLS без политик.

create table if not exists hk_weeks (
  sunday        date primary key,
  japa          text,
  lecturer      text,
  prev_lecturer text,
  skipped       boolean not null default false,
  blocks        jsonb,
  note          text,
  fests         jsonb,
  published_at  timestamptz,
  message_id    bigint,
  reminded_at   timestamptz,
  updated_at    timestamptz not null default now()
);

create table if not exists hk_admins (
  user_id  bigint primary key,
  chat_id  bigint not null,
  name     text,
  pending  text
);

-- Вторник и четверг: отмена, перенос, примечание
create table if not exists hk_days (
  day        date primary key,
  cancelled  boolean not null default false,
  time       text,
  note       text,
  updated_at timestamptz not null default now()
);

-- Прихожане, включившие напоминания
create table if not exists hk_subs (
  user_id    bigint primary key,
  chat_id    bigint not null,
  name       text,
  username   text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Журнал разовых действий: wd:<день> пост вт/чт, ek:<день> экадаши, rm:<день> напоминание подписчикам…
create table if not exists hk_log (
  key        text primary key,
  message_id bigint,
  at         timestamptz not null default now()
);

-- mode: 'test' — посты для канала уходят только админам; 'live' — в канал
create table if not exists hk_settings (
  k text primary key,
  v text not null
);
insert into hk_settings (k, v) values ('mode', 'test') on conflict (k) do nothing;

alter table hk_weeks    enable row level security;
alter table hk_admins   enable row level security;
alter table hk_days     enable row level security;
alter table hk_subs     enable row level security;
alter table hk_log      enable row level security;
alter table hk_settings enable row level security;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
