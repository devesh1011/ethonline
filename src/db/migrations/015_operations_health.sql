create table worker_instances (
  worker_id text primary key,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  stopped_at timestamptz
);
create index worker_instances_heartbeat_idx on worker_instances(heartbeat_at desc) where stopped_at is null;
create table worker_lanes (
  worker_id text not null references worker_instances(worker_id),
  lane text not null check(lane in ('projection','collection','servicing','lifecycle','exceptions','distribution','issuance','financing')),
  enabled boolean not null,
  state text not null check(state in ('DISABLED','IDLE','RUNNING','OK','ERROR')),
  last_started_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  consecutive_failures integer not null default 0 check(consecutive_failures >= 0),
  next_attempt_at timestamptz not null default now(),
  primary key(worker_id,lane)
);
create table operation_reconciliation_checks (
  check_id text primary key,
  operation_id text not null references chain_operations(operation_id),
  actor_account_id text not null,
  transaction_id text not null,
  result text not null check(result in ('UNKNOWN','SUCCESS','FAILED')),
  checked_at timestamptz not null default now()
);
create index operation_checks_operation_idx on operation_reconciliation_checks(operation_id,checked_at desc);
alter table distribution_preview_abandonments alter column preview_hash drop not null;
alter table distribution_preview_abandonments add column snapshot_transaction_id text;
alter table distribution_preview_abandonments add column snapshot_id numeric(38,0);
alter table distribution_preview_abandonments add constraint abandonment_original_identity check(preview_hash is not null or snapshot_transaction_id is not null);
alter table distribution_preview_abandonments add constraint abandonment_snapshot_identity check(snapshot_transaction_id is null or snapshot_id is not null and snapshot_id>0);

create function redact_operation_error(value text) returns text language plpgsql immutable as $$
begin
  if value is null then return null; end if;
  if value ~* '(credentialSubject|proofValue|credentialJson|private[_ -]?key|operator[_ -]?key|authorization[[:space:]]*[:=]|password[[:space:]]*[:=]|requestBody|payload[[:space:]]*[:=]|transaction[[:space:]]*[:=])' then
    return 'Operation failed; sensitive error details were removed.';
  end if;
  if value ~* '(Unexpected token|Unexpected end of JSON|is not valid JSON)' then return 'Invalid JSON or request data.'; end if;
  value := regexp_replace(value, '(https?|postgres(ql)?|redis)://[^[:space:]"''<>]+', '[redacted-url]', 'gi');
  value := regexp_replace(value, 'Bearer[[:space:]]+[^[:space:]]+', 'Bearer [redacted]', 'gi');
  value := regexp_replace(value, '(0x)?[a-f0-9]{64,}', '[redacted-hex]', 'gi');
  value := regexp_replace(value, 'eyJ[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){1,2}', '[redacted-token]', 'g');
  return left(value,400);
end;
$$;
create function redact_last_error() returns trigger language plpgsql as $$
begin new.last_error := redact_operation_error(new.last_error); return new; end;
$$;

-- Redact old diagnostic text as well. Only terminal-attempt guards are paused,
-- under the migration's table locks; all signed envelopes/receipts remain intact.
do $$
declare target record; guard record; guards jsonb;
begin
  for target in select table_name from information_schema.columns where table_schema=current_schema() and column_name='last_error' loop
    guards := '{}'::jsonb;
    for guard in select tgname,tgenabled from pg_trigger where tgrelid=format('%I.%I',current_schema(),target.table_name)::regclass
      and tgname in ('distribution_attempt_history','distribution_cancel_attempt_history') loop
      guards := guards || jsonb_build_object(guard.tgname,guard.tgenabled);
      if guard.tgenabled<>'D' then execute format('alter table %I disable trigger %I',target.table_name,guard.tgname); end if;
    end loop;
    execute format('update %I set last_error=redact_operation_error(last_error) where last_error is distinct from redact_operation_error(last_error)',target.table_name);
    for guard in select key,value from jsonb_each_text(guards) loop
      if guard.value='O' then execute format('alter table %I enable trigger %I',target.table_name,guard.key);
      elsif guard.value='A' then execute format('alter table %I enable always trigger %I',target.table_name,guard.key);
      elsif guard.value='R' then execute format('alter table %I enable replica trigger %I',target.table_name,guard.key);
      end if;
    end loop;
    execute format('create trigger zz_redact_last_error before insert or update on %I for each row execute function redact_last_error()',target.table_name);
  end loop;
end;
$$;
