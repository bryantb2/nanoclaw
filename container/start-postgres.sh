#!/bin/bash
# start-postgres.sh — Start an ephemeral PostgreSQL instance inside the container.
#
# Usage (from agent via Bash tool):
#   source /app/start-postgres.sh
#
# After sourcing, PG_* env vars are exported and Postgres is running on localhost:5432.
# The database "forcify_test" is created and ready for migrations.
#
# NOTE: This script is sourced, not executed — use `return` not `exit` for errors.

PG_VERSION=$(pg_lsclusters -h 2>/dev/null | head -1 | awk '{print $1}')
PG_CLUSTER="main"
PG_PORT=5432
PG_USER="testuser"
PG_PASSWORD="testpass"
PG_DATABASE="forcify_test"

if [ -z "$PG_VERSION" ]; then
  echo "ERROR: No PostgreSQL cluster found" >&2
  return 1
fi

# Check if already running
if sudo -u postgres pg_isready -q -p $PG_PORT 2>/dev/null; then
  echo "PostgreSQL is already running on port $PG_PORT"
else
  # Start the cluster (Debian pg_ctlcluster manages data dir automatically)
  sudo -u postgres pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" start -- -o "-p $PG_PORT" 2>&1 | grep -v "^$" || true

  # Wait for it to be ready
  for i in $(seq 1 30); do
    if sudo -u postgres pg_isready -q -p $PG_PORT 2>/dev/null; then
      break
    fi
    sleep 0.2
  done

  if ! sudo -u postgres pg_isready -q -p $PG_PORT 2>/dev/null; then
    echo "ERROR: PostgreSQL failed to start" >&2
    return 1
  fi
fi

# Create user and database (idempotent)
sudo -u postgres psql -p $PG_PORT -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$PG_USER') THEN CREATE ROLE $PG_USER WITH LOGIN PASSWORD '$PG_PASSWORD' CREATEDB; END IF; END \$\$;" 2>/dev/null
sudo -u postgres createdb -p $PG_PORT -O "$PG_USER" "$PG_DATABASE" 2>/dev/null || true

# Export env vars for the app
export PG_HOST=localhost
export PG_PORT=$PG_PORT
export PG_USER=$PG_USER
export PG_PASSWORD=$PG_PASSWORD
export PG_DB_NAME=$PG_DATABASE
export DB_CONNECTION=pg
export PGPASSWORD=$PG_PASSWORD

# Convenience function to stop Postgres
pg_stop() {
  sudo -u postgres pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" stop 2>/dev/null || true
}

echo "PostgreSQL $PG_VERSION running on localhost:$PG_PORT"
echo "  Database: $PG_DATABASE"
echo "  User: $PG_USER"
echo "  Env vars exported: PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DB_NAME, DB_CONNECTION"
