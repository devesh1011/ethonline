-- Reuse chain_operations' active-pool uniqueness for every distribution stage.
-- Financial values remain exact; JSON plans contain decimal strings only.
create table distribution_workflows (
  distribution_id text primary key,
  operation_id text not null unique references chain_operations(operation_id),
  pool_id text not null references pools(pool_id),
  actor_account_id text not null,
  total numeric(38,0) not null check(total > 0),
  state text not null check(state in ('SNAPSHOT_PENDING','PREVIEW','APPROVING','PAYING','FINALIZING','FINALIZED','BLOCKED')),
  snapshot_id numeric(38,0),
  snapshot_transaction_id text,
  preview jsonb,
  approved_preview_hash text,
  approved_by text,
  approved_at timestamptz,
  approval_transaction_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((approved_preview_hash is null and approved_by is null and approved_at is null) or
    (approved_preview_hash is not null and approved_by is not null and approved_at is not null and preview is not null and approved_preview_hash=preview->>'previewHash'))
);
create index distribution_workflows_pool_idx on distribution_workflows(pool_id,created_at desc);

create table distribution_steps (
  distribution_id text not null references distribution_workflows(distribution_id),
  step_key text not null,
  kind text not null check(kind in ('SNAPSHOT','APPROVE','PAYOUT','FINALIZE')),
  holder text,
  state text not null default 'PLANNED' check(state in ('PLANNED','SIGNED','UNKNOWN','SUCCESS','FAILED')),
  transaction_id text unique,
  signed_bytes bytea,
  submit_count integer not null default 0 check(submit_count >= 0),
  receipt jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  primary key(distribution_id,step_key),
  check((transaction_id is null)=(signed_bytes is null)),
  check((kind='PAYOUT')=(holder is not null))
);

create function preserve_distribution_approval() returns trigger language plpgsql as $$
begin
  if old.preview is not null and new.preview is distinct from old.preview then
    raise exception 'Distribution preview is immutable' using errcode='23514';
  end if;
  if old.approved_preview_hash is not null and
    (new.approved_preview_hash,new.approved_by,new.approved_at) is distinct from
    (old.approved_preview_hash,old.approved_by,old.approved_at) then
    raise exception 'Trustee approval is immutable' using errcode='23514';
  end if;
  if (new.pool_id,new.operation_id,new.actor_account_id,new.total) is distinct from
    (old.pool_id,old.operation_id,old.actor_account_id,old.total) then
    raise exception 'Distribution request is immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger distribution_approval_immutable before update on distribution_workflows
  for each row execute function preserve_distribution_approval();

create function preserve_distribution_signed_step() returns trigger language plpgsql as $$
begin
  if old.signed_bytes is not null and (new.transaction_id,new.signed_bytes) is distinct from (old.transaction_id,old.signed_bytes) then
    raise exception 'Signed distribution transaction is immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger distribution_step_immutable before update on distribution_steps
  for each row execute function preserve_distribution_signed_step();
