#!/usr/bin/env bash
# One-off release preflight, not the scheduled backup service.
# Run on production only after the owner confirms the v2 release operation.
set -euo pipefail
umask 077
cd /srv/tasktracker
[[ "$(pwd -P)" == /srv/tasktracker ]] || exit 1
stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
verify_db="st_v2_verify_${stamp//[-TZ]/_}"
[[ "$verify_db" =~ ^st_v2_verify_[0-9_]+$ ]] || exit 1
directory=/srv/tasktracker/manual-backups
mkdir -p "$directory"
partial="$directory/pre-v2-$stamp.dump.partial"
verified="$directory/pre-v2-$stamp.verified.dump"
created=false
cleanup() {
  if [[ "$created" == true && "$verify_db" =~ ^st_v2_verify_[0-9_]+$ ]]; then
    docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" -- "$1"' sh "$verify_db"
  fi
}
trap cleanup EXIT
counts_sql="SELECT 'tasks',count(*) FROM tasks UNION ALL SELECT 'users',count(*) FROM users UNION ALL SELECT 'tags',count(*) FROM tags UNION ALL SELECT 'task_tags',count(*) FROM task_tags UNION ALL SELECT 'task_change_log',count(*) FROM task_change_log UNION ALL SELECT 'processed_mail_events',count(*) FROM processed_mail_events ORDER BY 1"
docker compose exec -T db sh -c 'psql -X -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' sh "$counts_sql" > "$directory/pre-v2-$stamp.counts"
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$partial"
[[ -s "$partial" ]] || { echo 'Empty dump; stop release.' >&2; exit 1; }
docker compose exec -T db pg_restore --list < "$partial" > /dev/null
docker compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" -- "$1"' sh "$verify_db"
created=true
docker compose exec -T db sh -c 'pg_restore --exit-on-error --no-owner --no-privileges -U "$POSTGRES_USER" -d "$1"' sh "$verify_db" < "$partial"
docker compose exec -T db sh -c 'psql -X -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$1" -c "$2"' sh "$verify_db" "$counts_sql" > "$directory/pre-v2-$stamp.restored-counts"
if ! cmp -s "$directory/pre-v2-$stamp.counts" "$directory/pre-v2-$stamp.restored-counts"; then
  echo 'Row counts differ. Check concurrent writes; do not run migration.' >&2
  exit 1
fi
mv -- "$partial" "$verified"
sha256sum "$verified" > "$verified.sha256"
echo "Restored and checked: $verified"
