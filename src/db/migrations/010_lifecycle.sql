create table if not exists lifecycle_requests (
  operation_id text primary key references chain_operations(operation_id),
  pool_id text not null references pools(pool_id),
  actor_account_id text not null,
  action text not null check (action in ('MATURE','CLOSE','RETIRE')),
  amount_units numeric(38,0) not null check (amount_units >= 0),
  state text not null default 'QUEUED' check (state in ('QUEUED','AWAITING_HOLDER_SIGNATURE','AWAITING_TRANSACTION_HASH','SUBMITTED','CONFIRMED','FAILED')),
  prepared jsonb,
  signed_bytes bytea,
  transaction_id text unique,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((action='RETIRE' and amount_units>0) or (action<>'RETIRE' and amount_units=0))
);
create index if not exists lifecycle_requests_pool_idx on lifecycle_requests(pool_id,created_at desc);
