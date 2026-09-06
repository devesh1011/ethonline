-- Each retry is a new row. Original signed transactions and receipts stay intact.
alter table distribution_steps add column attempt_no integer not null default 1 check(attempt_no > 0);
alter table distribution_steps add column failure_code text check(failure_code in ('RECIPIENT_INELIGIBLE','PAYOUT_PREFLIGHT_REVERT','CONSENSUS_REVERT','RESULT_UNVERIFIED'));
create unique index distribution_holder_attempt_idx on distribution_steps(distribution_id,holder,attempt_no) where kind='PAYOUT';

update distribution_steps set failure_code=case
  when receipt->>'status'='0' then 'CONSENSUS_REVERT'
  when signed_bytes is null and last_error='Recipient eligibility must be restored before payout' then 'RECIPIENT_INELIGIBLE'
  else 'RESULT_UNVERIFIED' end where kind='PAYOUT' and state='FAILED';

create table distribution_retry_requests (
  distribution_id text not null references distribution_workflows(distribution_id),
  idempotency_key text not null,
  actor_account_id text not null,
  request_hash text not null,
  preview_hash text not null,
  holders jsonb not null check(jsonb_typeof(holders)='array'),
  created_at timestamptz not null default now(),
  primary key(distribution_id,idempotency_key)
);

create function preserve_distribution_attempt_history() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' or old.state in ('SUCCESS','FAILED') then
    raise exception 'Completed distribution attempt history is immutable' using errcode='23514';
  end if;
  if (new.distribution_id,new.step_key,new.kind,new.holder,new.attempt_no) is distinct from
     (old.distribution_id,old.step_key,old.kind,old.holder,old.attempt_no) then
    raise exception 'Distribution attempt identity is immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
-- Snapshot receipt persistence precedes preview construction; only payout attempts
-- need terminal immutability here. Snapshot recovery keeps the original trigger.
create trigger distribution_attempt_history before update or delete on distribution_steps
  for each row when(old.kind='PAYOUT') execute function preserve_distribution_attempt_history();

create function preserve_distribution_retry_request() returns trigger language plpgsql as $$
begin
  raise exception 'Distribution retry request is immutable' using errcode='23514';
end;
$$;
create trigger distribution_retry_request_immutable before update or delete on distribution_retry_requests
  for each row execute function preserve_distribution_retry_request();
