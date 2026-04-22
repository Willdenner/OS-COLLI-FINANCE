-- Bootstrap do Analista FP&A para PostgreSQL.

begin;

create table if not exists app_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into app_state (key, value, updated_at)
values (
  'main',
  '{
    "settings": {
      "updatedAt": "2026-04-20T00:00:00.000Z"
    },
    "fpa": {
      "imports": [],
      "transactions": [],
      "dreAccounts": [],
      "categoryRules": []
    }
  }'::jsonb,
  now()
)
on conflict (key) do nothing;

commit;
