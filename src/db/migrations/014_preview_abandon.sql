alter table distribution_workflows drop constraint distribution_workflows_state_check;
alter table distribution_workflows add constraint distribution_workflows_state_check check(state in ('SNAPSHOT_PENDING','PREVIEW','APPROVING','PAYING','FINALIZING','FINALIZED','BLOCKED','CANCELLING','CANCELLED','ABANDONED'));
create table distribution_preview_abandonments (
  distribution_id text primary key references distribution_workflows(distribution_id),
  operation_id text not null references chain_operations(operation_id),
  actor_account_id text not null,
  idempotency_key text not null,
  preview_hash text not null,
  reason text not null check(length(reason) between 10 and 1000),
  created_at timestamptz not null default now()
);
create index distribution_abandonment_operation_idx on distribution_preview_abandonments(operation_id);
create function preserve_distribution_abandonment() returns trigger language plpgsql as $$
begin
  raise exception 'Abandoned preview history is immutable' using errcode='23514';
end;
$$;
create trigger distribution_abandonment_immutable before update or delete on distribution_preview_abandonments for each row execute function preserve_distribution_abandonment();
