#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

{
  echo
  echo "==== $(date -Is) deploy start ===="
  git fetch origin main
  git reset --hard origin/main
  .venv/bin/pip install -r requirements.txt
  if [ ! -f data/dictionary.db ]; then
    .venv/bin/python import_dictionary.py || echo "dictionary import skipped"
  fi
  systemctl restart mom-word-study
  echo "==== $(date -Is) deploy done ===="
} >> data/deploy.log 2>&1
