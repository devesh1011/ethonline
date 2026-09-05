create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists pools (
  pool_id text primary key,
  pool_root text not null,
  eligibility_root text not null,
  manifest_hash text not null,
  chain_id bigint,
  registry_address text,
  security_address text,
  payout_address text,
  payment_token_id text,
  original_face numeric(38, 0) not null check (original_face > 0),
  performing_face numeric(38, 0) not null check (performing_face >= 0),
  delinquent_face numeric(38, 0) not null default 0 check (delinquent_face >= 0),
  defaulted_face numeric(38, 0) not null default 0 check (defaulted_face >= 0),
  estimated_recoveries numeric(38, 0) not null default 0 check (estimated_recoveries >= 0),
  realized_losses numeric(38, 0) not null default 0 check (realized_losses >= 0),
  available_cash numeric(38, 0) not null default 0 check (available_cash >= 0),
  reserved_cash numeric(38, 0) not null default 0 check (reserved_cash >= 0),
  principal_outstanding numeric(38, 0) not null check (principal_outstanding >= 0),
  reserved_principal numeric(38, 0) not null default 0 check (reserved_principal >= 0),
  state text not null check (state in ('DRAFT', 'ACTIVE', 'AMORTIZING', 'MATURED', 'CLOSED')),
  state_version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (performing_face + delinquent_face + defaulted_face <= original_face),
  check (estimated_recoveries <= defaulted_face),
  check (reserved_principal <= principal_outstanding)
);

create table if not exists receivables (
  pool_id text not null references pools(pool_id),
  fu_id_hash text not null,
  leaf_hash text not null,
  obligor_id_hash text not null,
  face_value numeric(38, 0) not null check (face_value > 0),
  outstanding numeric(38, 0) not null check (outstanding >= 0),
  due_date timestamptz not null,
  status text not null check (status in ('PERFORMING', 'DELINQUENT', 'DEFAULTED', 'WRITTEN_OFF', 'PAID')),
  synthetic_payload jsonb not null,
  primary key (pool_id, fu_id_hash)
);

create index if not exists receivables_pool_status_idx on receivables(pool_id, status);

create table if not exists eligibility_attestations (
  pool_id text not null references pools(pool_id),
  fu_id_hash text not null,
  rule_version text not null,
  eligible boolean not null,
  reason_codes text[] not null,
  evidence_hash text not null,
  attestor text not null,
  checked_at timestamptz not null,
  primary key (pool_id, fu_id_hash, rule_version)
);

create table if not exists chain_operations (
  operation_id text primary key,
  idempotency_key text not null unique,
  operation_type text not null,
  request_hash text not null,
  state text not null check (state in ('PLANNED', 'SIGNING', 'SUBMITTED', 'CONSENSUS_SUCCESS', 'CONSENSUS_FAILED', 'UNKNOWN', 'RECONCILED')),
  network text not null check (network = 'testnet'),
  transaction_id text unique,
  consensus_status text,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chain_operations_state_idx on chain_operations(state, updated_at);

create table if not exists collection_events (
  source_event_id text primary key,
  pool_id text not null references pools(pool_id),
  fu_id_hash text not null,
  payload_hash text not null,
  amount numeric(38, 0) not null check (amount > 0),
  settlement_reference text not null,
  outcome text not null check (outcome in ('RECORDED', 'ALREADY_PROCESSED', 'CONFLICT')),
  chain_operation_id text references chain_operations(operation_id),
  received_at timestamptz not null default now()
);

create table if not exists distributions (
  distribution_id text primary key,
  pool_id text not null references pools(pool_id),
  security_address text not null,
  snapshot_id numeric(38, 0) not null,
  entitlement_root text not null,
  principal_budget numeric(38, 0) not null check (principal_budget >= 0),
  income_budget numeric(38, 0) not null check (income_budget >= 0),
  immutable_total numeric(38, 0) not null check (immutable_total > 0),
  cash_paid numeric(38, 0) not null default 0 check (cash_paid >= 0),
  state text not null check (state in ('DRAFT', 'APPROVED', 'PARTIALLY_PAID', 'PAID', 'FINALIZED', 'CANCELLED')),
  record_date timestamptz not null,
  unique (security_address, snapshot_id),
  check (immutable_total = principal_budget + income_budget),
  check (cash_paid <= immutable_total)
);

create table if not exists distribution_entitlements (
  distribution_id text not null references distributions(distribution_id),
  holder text not null,
  snapshot_units numeric(38, 0) not null check (snapshot_units >= 0),
  cash_amount numeric(38, 0) not null check (cash_amount >= 0),
  principal_amount numeric(38, 0) not null check (principal_amount >= 0),
  income_amount numeric(38, 0) not null check (income_amount >= 0),
  paid_amount numeric(38, 0) not null default 0 check (paid_amount >= 0),
  state text not null check (state in ('PENDING', 'RETRYING', 'SUCCESS', 'FAILED')),
  transaction_id text,
  primary key (distribution_id, holder),
  check (cash_amount = principal_amount + income_amount),
  check (paid_amount <= cash_amount)
);

create table if not exists outbox_events (
  event_id bigint generated always as identity primary key,
  event_type text not null,
  aggregate_id text not null,
  payload jsonb not null,
  state text not null default 'PENDING' check (state in ('PENDING', 'PROCESSING', 'DONE', 'FAILED')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists outbox_claim_idx on outbox_events(state, next_attempt_at);
