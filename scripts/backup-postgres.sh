#!/bin/sh
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_VERIFY_RESTORE="${BACKUP_VERIFY_RESTORE:-true}"
POSTGRES_USER="${POSTGRES_USER:-taskuser}"
POSTGRES_DB="${POSTGRES_DB:-taskdb}"

mkdir -p "$BACKUP_DIR"

while true; do
  timestamp="$(date -u +%Y%m%d_%H%M%S)"
  tmp_file="$BACKUP_DIR/.taskdb-$timestamp.sql.gz.tmp"
  backup_file="$BACKUP_DIR/taskdb-$timestamp.sql.gz"
  verify_db="${POSTGRES_DB}_restore_check_${timestamp}"

  if pg_dump -h db -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$tmp_file"; then
    mv "$tmp_file" "$backup_file"

    if [ "$BACKUP_VERIFY_RESTORE" = "true" ]; then
      dropdb -h db -U "$POSTGRES_USER" --if-exists "$verify_db"
      createdb -h db -U "$POSTGRES_USER" "$verify_db"
      if gunzip -c "$backup_file" | psql -h db -U "$POSTGRES_USER" "$verify_db" >/dev/null; then
        dropdb -h db -U "$POSTGRES_USER" "$verify_db"
      else
        dropdb -h db -U "$POSTGRES_USER" --if-exists "$verify_db"
        echo "Backup restore verification failed for $backup_file" >&2
      fi
    fi

    find "$BACKUP_DIR" -type f -name "taskdb-*.sql.gz" -mtime +"$BACKUP_RETENTION_DAYS" -delete
  else
    rm -f "$tmp_file"
  fi

  sleep "$BACKUP_INTERVAL_SECONDS"
done
