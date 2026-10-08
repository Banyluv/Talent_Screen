#!/usr/bin/env sh
# Fills empty secrets in .env with strong random values. Safe to re-run: existing values are kept.
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env
rand() { openssl rand -base64 "$1" | tr -d '\n'; }
alnum() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-"$1"; }
fill() {
  key="$1"; val="$2"
  if grep -qE "^${key}=$" .env; then
    # use | as sed delimiter; base64 may contain /
    sed -i.bak "s|^${key}=$|${key}=${val}|" .env && rm -f .env.bak
    echo "  generated ${key}"
  fi
}
echo "Filling secrets in .env"
fill POSTGRES_PASSWORD "$(alnum 32)"
fill MINIO_ROOT_PASSWORD "$(alnum 32)"
fill JWT_SECRET "$(rand 48)"
fill DATA_ENCRYPTION_KEY "$(rand 32)"
echo "Done. Back up DATA_ENCRYPTION_KEY somewhere safe (e.g. Azure Key Vault)."
