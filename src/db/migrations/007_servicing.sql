-- Confirmed events only; commands remain in the existing durable operation log.
create table if not exists servicing_events (
  source_event_id text primary key,
  pool_id text not null references pools(pool_id),
  fu_id_hash text not null,
  action text not null check (action in ('DELINQUENT','DEFAULT','CURE','REVISE_RECOVERY')),
  payload_hash text not null,
  estimated_recovery numeric(38,0) not null check (estimated_recovery >= 0),
  reason text not null,
  reference text not null,
  chain_operation_id text not null unique references chain_operations(operation_id),
  transaction_id text not null,
  consensus_timestamp text not null,
  created_at timestamptz not null default now(),
  foreign key (pool_id,fu_id_hash) references receivables(pool_id,fu_id_hash)
);
create index if not exists servicing_events_pool_idx on servicing_events(pool_id,created_at desc);
alter table receivables add column if not exists estimated_recovery numeric(38,0) not null default 0 check (estimated_recovery >= 0);
