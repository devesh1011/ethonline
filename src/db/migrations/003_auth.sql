create table auth_challenges (
  challenge_id uuid primary key,
  account_id text not null check (account_id ~ '^0\.0\.[1-9][0-9]*$'),
  origin text not null,
  message text not null,
  requester_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > created_at)
);
create index auth_challenges_requester_created on auth_challenges(requester_hash, created_at);
create index auth_challenges_expiry on auth_challenges(expires_at);

create table auth_sessions (
  session_id uuid primary key,
  token_hash text not null unique,
  account_id text not null,
  origin text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > created_at)
);
create index auth_sessions_expiry on auth_sessions(expires_at);
