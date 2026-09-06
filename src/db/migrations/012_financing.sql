create table financing_workflows (
  financing_id uuid primary key,
  issuance_id uuid not null unique references issuance_workflows(issuance_id),
  operation_id text not null unique references chain_operations(operation_id),
  pool_id text not null unique,
  state text not null check(state in ('SUBSCRIBING','SETTLING','BLOCKED','ACTIVE')),
  configuration jsonb not null,
  approved_snapshot jsonb not null,
  unit_price numeric(38,0) not null check(unit_price>0),
  total_units numeric(38,0) not null check(total_units>0),
  retained_units numeric(38,0) not null check(retained_units>0),
  subscription_units numeric(38,0) not null check(subscription_units>0),
  cash_required numeric(38,0) not null check(cash_required>0),
  payout_address text unique,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(retained_units*20=total_units),
  check(subscription_units+retained_units=total_units),
  check(cash_required=unit_price*subscription_units),
  check(configuration ?& array['runId','registryAddress','escrowAddress','custodyAddress']),
  check(jsonb_typeof(configuration->'runId')='string' and jsonb_typeof(configuration->'registryAddress')='string' and jsonb_typeof(configuration->'escrowAddress')='string' and jsonb_typeof(configuration->'custodyAddress')='string'),
  check(length(configuration->>'runId')>0),
  check(configuration->>'registryAddress' ~ '^0x[0-9a-fA-F]{40}$'),
  check(configuration->>'escrowAddress' ~ '^0x[0-9a-fA-F]{40}$'),
  check(configuration->>'custodyAddress' ~ '^0x[0-9a-fA-F]{40}$')
);
create table subscription_quotes (
  quote_id uuid primary key,
  financing_id uuid not null references financing_workflows(financing_id),
  actor_account_id text not null,
  payer_address text not null,
  idempotency_key text not null unique,
  request_hash text not null,
  units numeric(38,0) not null check(units>0),
  amount numeric(38,0) not null check(amount>0),
  state text not null check(state in ('QUOTED','WALLET_PENDING','PAYMENT_PENDING','PAID','FAILED','CANCELLED','REVIEW_REQUIRED')),
  wallet_kind text check(wallet_kind in ('native','metamask')),
  prepared jsonb not null,
  transaction_id text unique,
  canonical_hash text unique,
  receipt jsonb,
  last_error text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Permanent reservations survive failed/blocked settlement. A new deal requires
-- a new isolated run and new Registry, payment escrow and security custody.
create unique index financing_registry_reservation_idx on financing_workflows(lower(configuration->>'registryAddress'));
create unique index financing_escrow_reservation_idx on financing_workflows(lower(configuration->>'escrowAddress'));
create unique index financing_custody_reservation_idx on financing_workflows(lower(configuration->>'custodyAddress'));
create unique index financing_run_reservation_idx on financing_workflows((configuration->>'runId'));
create unique index subscription_actor_open_idx on subscription_quotes(actor_account_id) where state in ('QUOTED','WALLET_PENDING','PAYMENT_PENDING','REVIEW_REQUIRED');
create index subscription_financing_state_idx on subscription_quotes(financing_id,state);
create table financing_steps (
  operation_id text not null references chain_operations(operation_id),
  sequence integer not null,
  kind text not null,
  recipient jsonb,
  state text not null default 'PLANNED' check(state in ('PLANNED','PREPARED','SIGNED','UNKNOWN','SUCCESS','FAILED')),
  prepared jsonb,
  signed_bytes bytea,
  transaction_id text unique,
  receipt jsonb,
  result jsonb,
  last_error text,
  primary key(operation_id,sequence),
  check((signed_bytes is null)=(transaction_id is null))
);
alter table pools add column if not exists name text;
alter table pools add column if not exists approved_source jsonb;
alter table issuance_workflows drop constraint issuance_workflows_state_check;
alter table issuance_workflows add constraint issuance_workflows_state_check check(state in ('PROCESSING','BLOCKED','AWAITING_FINANCING','FINANCED_ACTIVE'));
