-- Off-chain underwriting records. Approval does not create or activate a pool.
create table pool_drafts (
  draft_id uuid primary key,
  owner_account_id text not null,
  trustee_account_id text not null,
  creation_key uuid not null,
  creation_hash text not null,
  version integer not null default 1 check (version > 0),
  state text not null default 'DRAFT' check (state in ('DRAFT','APPROVED')),
  source jsonb not null,
  terms jsonb not null,
  review jsonb not null,
  pool_root text not null check (pool_root ~ '^0x[0-9a-f]{64}$'),
  eligibility_root text not null check (eligibility_root ~ '^0x[0-9a-f]{64}$'),
  manifest_hash text not null check (manifest_hash ~ '^0x[0-9a-f]{64}$'),
  approval jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_account_id, creation_key),
  check ((state = 'APPROVED') = (approval is not null))
);
create index pool_drafts_owner_updated_idx on pool_drafts(owner_account_id, updated_at desc);
create index pool_drafts_trustee_updated_idx on pool_drafts(trustee_account_id, updated_at desc);
create table pool_draft_revisions (
  draft_id uuid not null references pool_drafts(draft_id),
  version integer not null check (version > 0),
  actor_account_id text not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  primary key(draft_id, version)
);
