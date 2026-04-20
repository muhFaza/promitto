#!/bin/sh
# deploy/backup.sh — tarball backend/data with a UTC timestamp.
# Backs up everything that matters: sqlite + Baileys auth state.
# Usage:   ./deploy/backup.sh [destination-dir]
# Default: ~/promitto-backups

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HOME/promitto-backups}"
mkdir -p "$DEST"

TS="$(date -u +%Y%m%d-%H%M%SZ)"
ARCHIVE="$DEST/promitto-data-$TS.tar.gz"

if [ ! -d "$ROOT/backend/data" ]; then
  echo "No backend/data directory found at $ROOT/backend/data" >&2
  exit 1
fi

tar -czf "$ARCHIVE" -C "$ROOT/backend" data
echo "$ARCHIVE"
