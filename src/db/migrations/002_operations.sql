alter table chain_operations add column if not exists pool_id text references pools(pool_id);
alter table chain_operations add column if not exists actor_account_id text;
alter table chain_operations add column if not exists request jsonb;
alter table chain_operations add column if not exists source_event_id text;
alter table chain_operations add column if not exists payload_hash text;
alter table chain_operations add column if not exists phase text not null default 'FUNDING' check (phase in ('FUNDING','RECORDING','COMPLETE'));
alter table chain_operations add column if not exists lease_owner text;
alter table chain_operations add column if not exists lease_until timestamptz;
alter table chain_operations add column if not exists next_attempt_at timestamptz not null default now();
create unique index if not exists operations_source_event_idx on chain_operations(source_event_id) where source_event_id is not null;
create unique index if not exists operations_one_active_pool_idx on chain_operations(pool_id) where state not in ('RECONCILED','CONSENSUS_FAILED');
create index if not exists operations_claim_idx on chain_operations(next_attempt_at,lease_until) where state not in ('RECONCILED','CONSENSUS_FAILED');

create table if not exists operation_transactions (
  operation_id text not null references chain_operations(operation_id),
  phase text not null check (phase in ('FUNDING','RECORDING')),
  transaction_id text not null unique,
  transaction_hash text not null,
  signed_bytes bytea not null,
  valid_until timestamptz not null,
  state text not null check (state in ('SIGNED','UNKNOWN','SUCCESS','FAILED')),
  consensus_timestamp text,
  consensus_status text,
  submit_count integer not null default 0,
  created_at timestamptz not null default now(),
  primary key(operation_id,phase)
);
alter table pools add column if not exists projection_as_of timestamptz;
alter table pools add column if not exists projection_metadata jsonb not null default '{}';
alter table collection_events add column if not exists settled_at timestamptz;
create table if not exists workspace_holders (
 pool_id text not null references pools(pool_id), address text not null,
 units numeric(38,0) not null, payment_balance numeric(38,0) not null,
 primary key(pool_id,address)
);
create table if not exists chain_events (
 event_key text primary key, pool_id text not null references pools(pool_id),
 event_type text not null, transaction_id text not null, consensus_timestamp text not null,
 payload jsonb not null, created_at timestamptz not null default now()
);
create index if not exists chain_events_pool_idx on chain_events(pool_id, consensus_timestamp desc);
