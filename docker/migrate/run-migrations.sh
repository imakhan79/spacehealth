#!/bin/sh
# Applies /omni/migrations/*.sql in lexical order, once each, inside a single
# transaction per file. Records a sha256 per version and refuses to start if
# an already-applied migration file has been altered.
set -eu

log() { printf '%s [migrate] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# db is "healthy" before GoTrue finishes its own migrations on first boot;
# compose already waits for auth, but retry the connection regardless.
attempt=0
until psql -qtAc 'select 1' >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    log "database unreachable after $attempt attempts"
    exit 1
  fi
  sleep 2
done

psql -v ON_ERROR_STOP=1 -q <<'SQL'
create schema if not exists omni_meta;
revoke all on schema omni_meta from public;
create table if not exists omni_meta.schema_migrations (
  version    text primary key,
  checksum   text not null,
  applied_at timestamptz not null default clock_timestamp()
);
SQL

for file in /omni/migrations/*.sql; do
  [ -e "$file" ] || continue
  version=$(basename "$file" .sql)
  sum=$(sha256sum "$file" | cut -d' ' -f1)
  recorded=$(psql -qtA -v v="$version" <<'SQL'
select checksum from omni_meta.schema_migrations where version = :'v';
SQL
)
  if [ -n "$recorded" ]; then
    if [ "$recorded" != "$sum" ]; then
      log "FATAL: $version was modified after being applied (db $recorded, file $sum)"
      exit 1
    fi
    continue
  fi

  log "applying $version"
  # One transaction: the migration and its bookkeeping row commit together.
  {
    cat "$file"
    printf "\ninsert into omni_meta.schema_migrations (version, checksum) values (:'v', :'s');\n"
  } | psql -v ON_ERROR_STOP=1 -q --single-transaction -v v="$version" -v s="$sum"
done

# The relay role is created NOLOGIN by the schema migration; enable it with the
# password from this deployment's secrets. Idempotent on every boot.
psql -v ON_ERROR_STOP=1 -q -v pw="$OMNI_RELAY_PASSWORD" <<'SQL'
alter role omni_relay with login password :'pw';
SQL

log "schema up to date"
