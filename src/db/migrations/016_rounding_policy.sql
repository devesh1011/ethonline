alter table distribution_entitlements drop constraint distribution_entitlements_state_check;
alter table distribution_entitlements add constraint distribution_entitlements_state_check check(state in ('PENDING','RETRYING','SUCCESS','FAILED','NO_PAYMENT_DUE'));
alter table distribution_entitlements add constraint distribution_no_payment_due_check check (
  state <> 'NO_PAYMENT_DUE' or (snapshot_units > 0 and cash_amount=0 and principal_amount=0 and income_amount=0 and paid_amount=0 and transaction_id is null)
);
