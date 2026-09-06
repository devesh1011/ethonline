-- Definitively failed recording attempts remain auditable when an operator retries.
create table operation_transaction_attempts (
 operation_id text not null references chain_operations(operation_id),
 transaction_id text not null,
 phase text not null check(phase='RECORDING'),
 transaction_hash text not null,
 signed_bytes bytea not null,
 valid_until timestamptz not null,
 consensus_timestamp text not null,
 consensus_status text not null,
 submit_count integer not null,
 archived_at timestamptz not null default now(),
 primary key(operation_id,transaction_id)
);
