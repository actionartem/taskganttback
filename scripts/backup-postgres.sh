#!/bin/sh
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
POSTGRES_USER="${POSTGRES_USER:-taskuser}"
POSTGRES_DB="${POSTGRES_DB:-taskdb}"

mkdir -p "$BACKUP_DIR"

while true; do
  timestamp="$(date -u +%Y%m%d-%H%M%S)"
  tmp_file="$BACKUP_DIR/.taskdb-$timestamp.sql.gz.tmp"
  backup_file="$BACKUP_DIR/taskdb-$timestamp.sql.gz"

  if pg_dump -h db -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$tmp_file"; then
    mv "$tmp_file" "$backup_file"
    find "$BACKUP_DIR" -type f -name "taskdb-*.sql.gz" -mtime +"$BACKUP_RETENTION_DAYS" -delete
  else
    rm -f "$tmp_file"
  fi

  sleep "$BACKUP_INTERVAL_SECONDS"
done
