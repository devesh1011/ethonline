-- MVP permits one active accounting ledger. Fail on existing conflicts rather
-- than deleting, merging, or silently reassigning financial history.
create unique index pools_single_active_idx on pools ((true))
  where state in ('ACTIVE', 'AMORTIZING', 'MATURED');

-- A custody address cannot back a second pool, even after the first closes.
create unique index pools_custody_idx on pools (lower(payout_address))
  where payout_address is not null;

alter table distributions add column payout_address text;
update distributions d set payout_address = p.payout_address
  from pools p where p.pool_id = d.pool_id;
alter table distributions alter column payout_address set not null;

-- Preserve compatibility with existing projection writers, which supply the
-- pool/security pair but not the newly materialized custody address.
create function bind_distribution_custody() returns trigger language plpgsql as $$
declare bound_pool pools%rowtype;
begin
  select * into strict bound_pool from pools where pool_id = new.pool_id for key share;
  if bound_pool.payout_address is null or
     lower(new.security_address) is distinct from lower(bound_pool.security_address) or
     (new.payout_address is not null and lower(new.payout_address) <> lower(bound_pool.payout_address)) then
    raise exception 'Distribution custody/security does not match pool' using errcode = '23514';
  end if;
  new.payout_address := bound_pool.payout_address;
  return new;
end;
$$;
create trigger distributions_bind_custody before insert or update on distributions
  for each row execute function bind_distribution_custody();

-- Registry snapshotBound is keyed by payout adapter, not ATS security.
alter table distributions drop constraint distributions_security_address_snapshot_id_key;
create unique index distributions_custody_snapshot_idx
  on distributions (lower(payout_address), snapshot_id);
create index distributions_pool_record_idx on distributions (pool_id, record_date desc);
create index operations_pool_created_idx on chain_operations (pool_id, created_at desc)
  where request is not null;

-- Once assigned, a pool cannot swap custody/security and strand or reuse cash.
create function preserve_pool_bindings() returns trigger language plpgsql as $$
begin
  if old.payout_address is not null and
     (lower(old.payout_address), lower(old.security_address), old.payment_token_id, lower(old.registry_address), old.chain_id)
     is distinct from
     (lower(new.payout_address), lower(new.security_address), new.payment_token_id, lower(new.registry_address), new.chain_id) then
    raise exception 'Activated pool bindings are immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger pools_preserve_bindings before update on pools
  for each row execute function preserve_pool_bindings();
