#!/usr/bin/env bash
# Nightly database backup for pamA Cloud: pg_dump (custom format) to deploy/cloud/backups, copy to
# S3 when BACKUP_S3_URI is set, keep BACKUP_KEEP_DAYS days locally.
# Cron (bootstrap.sh installs it): 30 3 * * * /opt/pama/deploy/cloud/backup.sh
# Restore into an empty database:
#   docker compose -f deploy/cloud/docker-compose.yml exec -T db \
#     pg_restore -U postgres -d pama --clean --if-exists < backups/pama-YYYY-MM-DDTHHMM.dump
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
set -a; source "$DIR/.env"; set +a
mkdir -p "$DIR/backups"
FILE="$DIR/backups/pama-$(date -u +%Y-%m-%dT%H%M).dump"

docker compose -f "$DIR/docker-compose.yml" exec -T db pg_dump -U postgres -Fc pama > "$FILE.part"
mv "$FILE.part" "$FILE"
echo "backup: $FILE ($(du -h "$FILE" | cut -f1))"

if [ -n "${BACKUP_S3_URI:-}" ]; then
  aws s3 cp --only-show-errors "$FILE" "$BACKUP_S3_URI/$(basename "$FILE")"
  echo "backup: copied to $BACKUP_S3_URI"
fi
find "$DIR/backups" -name 'pama-*.dump' -mtime +"${BACKUP_KEEP_DAYS:-14}" -delete
