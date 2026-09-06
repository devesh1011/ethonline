create table exception_requests (
  operation_id text primary key references chain_operations(operation_id),
  pool_id text not null references pools(pool_id),
  source_event_id text not null unique,
  decision_hash text not null,
  state text not null default 'QUEUED' check(state in ('QUEUED','SIGNED','UNKNOWN','CONFIRMED','FAILED')),
  transaction_id text unique,
  signed_bytes bytea,
  receipt jsonb,
  created_at timestamptz not null default now(),
  check((transaction_id is null)=(signed_bytes is null))
);
create index exception_requests_pool_idx on exception_requests(pool_id,created_at desc);
create table exception_decisions (
  idempotency_key text primary key,
  operation_id text not null references chain_operations(operation_id),
  actor_account_id text not null,
  source_event_id text not null unique,
  request_hash text not null,
  command jsonb not null,
  created_at timestamptz not null default now()
);
create index exception_decisions_operation_idx on exception_decisions(operation_id);

alter table distribution_workflows drop constraint distribution_workflows_state_check;
alter table distribution_workflows add constraint distribution_workflows_state_check check(state in ('SNAPSHOT_PENDING','PREVIEW','APPROVING','PAYING','FINALIZING','FINALIZED','BLOCKED','CANCELLING','CANCELLED'));
alter table distribution_steps drop constraint distribution_steps_kind_check;
alter table distribution_steps add constraint distribution_steps_kind_check check(kind in ('SNAPSHOT','APPROVE','PAYOUT','FINALIZE','CANCEL'));
create table distribution_cancellations (
  distribution_id text primary key references distribution_workflows(distribution_id),
  operation_id text not null references chain_operations(operation_id),
  actor_account_id text not null,
  idempotency_key text not null,
  request_hash text not null,
  source_event_id text not null unique,
  decision_hash text not null,
  command jsonb not null,
  created_at timestamptz not null default now()
);
create index distribution_cancellations_operation_idx on distribution_cancellations(operation_id);
create function preserve_exception_decision() returns trigger language plpgsql as $$
begin
  raise exception 'Exception decision history is immutable' using errcode='23514';
end;
$$;
create trigger distribution_cancellation_immutable before update or delete on distribution_cancellations for each row execute function preserve_exception_decision();
create trigger exception_decision_immutable before update or delete on exception_decisions for each row execute function preserve_exception_decision();
create function preserve_exception_envelope() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' or old.state in ('CONFIRMED','FAILED') then
    raise exception 'Completed exception history is immutable' using errcode='23514';
  end if;
  if (new.operation_id,new.pool_id,new.source_event_id,new.decision_hash) is distinct from (old.operation_id,old.pool_id,old.source_event_id,old.decision_hash) or
    (old.signed_bytes is not null and (new.transaction_id,new.signed_bytes) is distinct from (old.transaction_id,old.signed_bytes)) then
    raise exception 'Exception identity and signed transaction are immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger exception_envelope_immutable before update or delete on exception_requests for each row execute function preserve_exception_envelope();
create trigger distribution_cancel_attempt_history before update or delete on distribution_steps for each row when(old.kind='CANCEL') execute function preserve_distribution_attempt_history();
