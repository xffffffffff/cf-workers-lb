#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

PREFIX="worker-lb"
ACCESS_TEAM_DOMAIN=""
ACCESS_AUD=""
ADMIN_HOST=""
CLEAR_ADMIN_HOST=0

usage() {
  cat <<'USAGE'
Worker LB Cloudflare installer

Usage:
  bash scripts/install.sh [options]

Options:
  --name PREFIX                 Worker/resource name prefix (default: worker-lb)
  --admin-host HOSTNAME        Create and bind a Worker Custom Domain for the WebUI/API
  --no-admin-host              Remove a previously configured management Custom Domain
  --access-team-domain DOMAIN  Cloudflare Access team domain, e.g. team.cloudflareaccess.com
  --access-aud AUD             Cloudflare Access application audience tag
  -h, --help                   Show this help

No traffic domain is required during installation. When --admin-host is set,
Wrangler creates the management DNS record, certificate, and Worker binding.
Add load-balanced hostnames later from the WebUI.

The script reuses generated D1, KV, and secret files on subsequent runs.
USAGE
}

while (($#)); do
  case "$1" in
    --name) PREFIX="${2:?Missing value for --name}"; shift 2 ;;
    --admin-host) ADMIN_HOST="${2:?Missing value for --admin-host}"; shift 2 ;;
    --no-admin-host) CLEAR_ADMIN_HOST=1; shift ;;
    --access-team-domain) ACCESS_TEAM_DOMAIN="${2:?Missing value for --access-team-domain}"; shift 2 ;;
    --access-aud) ACCESS_AUD="${2:?Missing value for --access-aud}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -n "$ADMIN_HOST" && "$CLEAR_ADMIN_HOST" -eq 1 ]]; then
  echo "--admin-host and --no-admin-host cannot be used together." >&2
  exit 2
fi

WORKER_CONFIG=".wrangler.generated.toml"
if [[ -z "$ADMIN_HOST" && "$CLEAR_ADMIN_HOST" -eq 0 && -f "$WORKER_CONFIG" ]]; then
  ADMIN_HOST="$(sed -nE 's/^[[:space:]]*ADMIN_HOSTS[[:space:]]*=[[:space:]]*"([^"]*)".*/\1/p' "$WORKER_CONFIG" | head -1)"
fi

if [[ ! "$PREFIX" =~ ^[a-z0-9][a-z0-9-]{1,40}$ ]]; then
  echo "--name must use lowercase letters, numbers, and hyphens." >&2
  exit 2
fi

if [[ -n "$ADMIN_HOST" && ! "$ADMIN_HOST" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo "Invalid --admin-host hostname." >&2
  exit 2
fi
if [[ -n "$ACCESS_TEAM_DOMAIN" && ! "$ACCESS_TEAM_DOMAIN" =~ ^[a-zA-Z0-9.-]+$ ]]; then
  echo "Invalid Cloudflare Access team domain." >&2
  exit 2
fi
if [[ -n "$ACCESS_AUD" && ! "$ACCESS_AUD" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Invalid Cloudflare Access audience tag." >&2
  exit 2
fi
if [[ -n "$ACCESS_TEAM_DOMAIN" || -n "$ACCESS_AUD" ]]; then
  if [[ -z "$ACCESS_TEAM_DOMAIN" || -z "$ACCESS_AUD" ]]; then
    echo "Both --access-team-domain and --access-aud are required together." >&2
    exit 2
  fi
fi

command -v node >/dev/null || { echo "Node.js 20+ is required." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required." >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required to generate secrets." >&2; exit 1; }
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 20 )); then
  echo "Node.js 20+ is required; found $(node --version)." >&2
  exit 1
fi

echo "[1/6] Installing dependencies and building WebUI"
npm install
npm run check
npm run build

echo "[2/6] Checking Cloudflare authentication"
if ! npx wrangler whoami >/dev/null 2>&1; then
  if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    echo "Cloudflare deployment token authentication failed." >&2
    exit 1
  fi
  npx wrangler login
fi

PROVISION_CONFIG=".wrangler.generated.provision.toml"

PROVISION_CONFIG_EXISTED=0
if [[ -f "$PROVISION_CONFIG" ]]; then
  PROVISION_CONFIG_EXISTED=1
  PROVISIONED_PREFIX="$(sed -nE 's/^[[:space:]]*name[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$PROVISION_CONFIG" | head -1)"
  if [[ -n "$PROVISIONED_PREFIX" && "$PROVISIONED_PREFIX" != "$PREFIX" ]]; then
    echo "This checkout was provisioned as '$PROVISIONED_PREFIX'; rerun with --name $PROVISIONED_PREFIX or use a fresh clone." >&2
    exit 1
  fi
else
  cat > "$PROVISION_CONFIG" <<EOF
name = "$PREFIX"
main = "workers/unified/index.ts"
compatibility_date = "2026-09-15"
EOF
fi

DB_ID="${WORKER_LB_DB_ID:-$(sed -nE 's/^[[:space:]]*database_id[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$PROVISION_CONFIG" | head -1)}"
KV_ID="${WORKER_LB_KV_ID:-$(sed -nE 's/^[[:space:]]*id[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$PROVISION_CONFIG" | tail -1)}"

find_existing_d1() {
  npx wrangler d1 list --json --config "$PROVISION_CONFIG" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk });
    process.stdin.on("end", () => {
      const matches = JSON.parse(input).filter((item) => item.name === process.argv[1]);
      if (matches.length === 1) process.stdout.write(String(matches[0].uuid ?? matches[0].id ?? ""));
      if (matches.length > 1) process.stdout.write("AMBIGUOUS");
    });
  ' "$PREFIX"
}

find_existing_kv() {
  npx wrangler kv namespace list --config "$PROVISION_CONFIG" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk });
    process.stdin.on("end", () => {
      const matches = JSON.parse(input).filter((item) => item.title === process.argv[1]);
      if (matches.length === 1) process.stdout.write(String(matches[0].id ?? ""));
      if (matches.length > 1) process.stdout.write("AMBIGUOUS");
    });
  ' "$PREFIX-config"
}

json_has_id() {
  node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk });
    process.stdin.on("end", () => {
      const id = process.argv[1];
      const key = process.argv[2];
      const found = JSON.parse(input).some((item) => String(item[key] ?? item.uuid ?? item.id ?? "") === id);
      process.exit(found ? 0 : 1);
    });
  ' "$1" "$2"
}

if [[ -n "$DB_ID" ]] && ! npx wrangler d1 list --json --config "$PROVISION_CONFIG" | json_has_id "$DB_ID" uuid; then
  echo "[3/6] Saved D1 $DB_ID is not in this Cloudflare account"
  DB_ID=""
fi
if [[ -n "$KV_ID" ]] && ! npx wrangler kv namespace list --config "$PROVISION_CONFIG" | json_has_id "$KV_ID" id; then
  echo "[3/6] Saved KV $KV_ID is not in this Cloudflare account"
  KV_ID=""
fi
if [[ "$PROVISION_CONFIG_EXISTED" -eq 1 && -z "$DB_ID" ]]; then
  DB_ID="$(find_existing_d1)"
fi
if [[ "$PROVISION_CONFIG_EXISTED" -eq 1 && -z "$KV_ID" ]]; then
  KV_ID="$(find_existing_kv)"
fi
if [[ "$DB_ID" == "AMBIGUOUS" || "$KV_ID" == "AMBIGUOUS" ]]; then
  echo "Found multiple resources with the generated name. Set WORKER_LB_DB_ID and WORKER_LB_KV_ID explicitly." >&2
  exit 1
fi

if [[ -z "$DB_ID" ]]; then
  echo "[3/6] Creating D1 database"
  D1_OUTPUT="$(npx wrangler d1 create "$PREFIX" --binding DB --config "$PROVISION_CONFIG")"
  printf '%s\n' "$D1_OUTPUT"
  DB_ID="$(printf '%s\n' "$D1_OUTPUT" | sed -nE 's/.*database_id[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' | head -1)"
  [[ -n "$DB_ID" ]] || DB_ID="$(find_existing_d1)"
else
  echo "[3/6] Reusing D1 database $DB_ID"
fi

if [[ -z "$KV_ID" ]]; then
  echo "[3/6] Creating KV namespace"
  KV_OUTPUT="$(npx wrangler kv namespace create "$PREFIX-config" --binding CONFIG_KV --config "$PROVISION_CONFIG")"
  printf '%s\n' "$KV_OUTPUT"
  KV_ID="$(printf '%s\n' "$KV_OUTPUT" | sed -nE 's/.*id[[:space:]]*=[[:space:]]*"([a-fA-F0-9]+)".*/\1/p' | tail -1)"
  [[ -n "$KV_ID" ]] || KV_ID="$(find_existing_kv)"
else
  echo "[3/6] Reusing KV namespace $KV_ID"
fi

if [[ ! "$DB_ID" =~ ^[a-fA-F0-9-]{36}$ || ! "$KV_ID" =~ ^[a-fA-F0-9]{32}$ ]]; then
  echo "Could not resolve generated D1/KV identifiers. Set WORKER_LB_DB_ID and WORKER_LB_KV_ID, then rerun." >&2
  exit 1
fi

cat > "$PROVISION_CONFIG" <<EOF
name = "$PREFIX"
main = "workers/unified/index.ts"
compatibility_date = "2026-09-15"

[[d1_databases]]
binding = "DB"
database_name = "$PREFIX"
database_id = "$DB_ID"

[[kv_namespaces]]
binding = "CONFIG_KV"
id = "$KV_ID"
EOF

ACCESS_VARS=""
if [[ -n "$ACCESS_TEAM_DOMAIN" ]]; then
  ACCESS_VARS=$(cat <<EOF
ACCESS_TEAM_DOMAIN = "$ACCESS_TEAM_DOMAIN"
ACCESS_AUD = "$ACCESS_AUD"
EOF
)
fi

ADMIN_ROUTE=""
if [[ -n "$ADMIN_HOST" ]]; then
  ADMIN_ROUTE=$(cat <<EOF
routes = [{ pattern = "$ADMIN_HOST", custom_domain = true }]
EOF
)
fi

cat > "$WORKER_CONFIG" <<EOF
name = "$PREFIX"
main = "workers/unified/index.ts"
compatibility_date = "2026-09-15"
$ADMIN_ROUTE

[assets]
directory = "./dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = true

[triggers]
crons = ["* * * * *"]

[[d1_databases]]
binding = "DB"
database_name = "$PREFIX"
database_id = "$DB_ID"
migrations_dir = "migrations"

[[kv_namespaces]]
binding = "CONFIG_KV"
id = "$KV_ID"

[vars]
ENVIRONMENT = "production"
WORKER_NAME = "$PREFIX"
ADMIN_HOSTS = "$ADMIN_HOST"
CONFIG_CACHE_SECONDS = "5"
REQUEST_LOG_SAMPLE_RATE = "0.01"
$ACCESS_VARS
EOF

echo "[4/6] Applying D1 migrations"
npx wrangler d1 migrations apply "$PREFIX" --remote --config "$WORKER_CONFIG"

SECRETS_FILE=".wrangler.generated.secrets"
if [[ -f "$SECRETS_FILE" ]]; then
  # This file is generated locally by this installer and is never committed.
  source "$SECRETS_FILE"
fi
ADMIN_TOKEN="${ADMIN_TOKEN:-wlb_$(openssl rand -hex 24)}"
AFFINITY_SECRET="${AFFINITY_SECRET:-$(openssl rand -hex 32)}"
TOKEN_ENCRYPTION_KEY="${TOKEN_ENCRYPTION_KEY:-$(openssl rand -hex 32)}"
umask 077
cat > "$SECRETS_FILE" <<EOF
ADMIN_TOKEN='$ADMIN_TOKEN'
AFFINITY_SECRET='$AFFINITY_SECRET'
TOKEN_ENCRYPTION_KEY='$TOKEN_ENCRYPTION_KEY'
EOF

echo "[5/6] Deploying unified Worker, WebUI, and Cron"
npx wrangler deploy --config "$WORKER_CONFIG"

echo "[6/6] Saving encrypted Worker secrets"
printf '%s' "$ADMIN_TOKEN" | npx wrangler secret put ADMIN_TOKEN --config "$WORKER_CONFIG"
printf '%s' "$AFFINITY_SECRET" | npx wrangler secret put AFFINITY_SECRET --config "$WORKER_CONFIG"
printf '%s' "$TOKEN_ENCRYPTION_KEY" | npx wrangler secret put TOKEN_ENCRYPTION_KEY --config "$WORKER_CONFIG"

cat <<EOF

Worker LB has been deployed as one Worker: $PREFIX

Management token (shown once):
$ADMIN_TOKEN
EOF

if [[ -n "$ADMIN_HOST" ]]; then
  cat <<EOF
Management WebUI: https://$ADMIN_HOST
Wrangler created the Worker Custom Domain, DNS record, and certificate.
EOF
else
  cat <<EOF
Management WebUI: open the workers.dev URL printed above.
To bind a custom management domain, rerun with --admin-host lb.example.com.
EOF
fi

cat <<EOF

In Settings, add a restricted Cloudflare API Token with Zone Read, DNS Edit,
and Workers Routes Edit. Business domains are then added entirely from the WebUI.

Generated config: $WORKER_CONFIG
Generated secrets: $SECRETS_FILE
EOF
