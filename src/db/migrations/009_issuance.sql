create table issuance_workflows (
  issuance_id uuid primary key,
  operation_id text not null unique references chain_operations(operation_id),
  draft_id uuid not null unique references pool_drafts(draft_id),
  actor_account_id text not null,
  approved_version integer not null,
  approved_snapshot jsonb not null,
  configuration jsonb not null,
  state text not null check (state in ('PROCESSING','BLOCKED','AWAITING_FINANCING')),
  security_address text unique,
  security_id text unique,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index issuance_actor_created_idx on issuance_workflows(actor_account_id,created_at desc);
create table issuance_steps (
  operation_id text not null references chain_operations(operation_id),
  sequence integer not null,
  kind text not null,
  state text not null default 'PLANNED' check(state in ('PLANNED','PREPARED','SIGNED','UNKNOWN','SUCCESS','FAILED')),
  prepared jsonb,
  signed_bytes bytea,
  transaction_id text unique,
  receipt jsonb,
  result jsonb,
  submit_count integer not null default 0,
  last_error text,
  primary key(operation_id,sequence),
  check ((signed_bytes is null) = (transaction_id is null))
);
create table compliance_commands (
  operation_id text primary key references chain_operations(operation_id),
  issuance_id uuid not null references issuance_workflows(issuance_id),
  actor_account_id text not null,
  command jsonb not null,
  created_at timestamptz not null default now()
);
create index compliance_issuance_created_idx on compliance_commands(issuance_id,created_at desc);
