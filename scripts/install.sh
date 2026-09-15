#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

PREFIX="worker-lb"
ROUTES=""
ACCESS_TEAM_DOMAIN=""
ACCESS_AUD=""
NON_INTERACTIVE=0

usage() {
  cat <<'USAGE'
Worker LB Cloudflare installer

Usage:
  bash scripts/install.sh [options]

Options:
  --name PREFIX                 Worker/resource name prefix (default: worker-lb)
  --routes HOSTS                Comma-separated load-balanced hostnames
                                Example: www.example.com,api.example.com
  --access-team-domain DOMAIN   Cloudflare Access team domain, e.g. team.cloudflareaccess.com
  --access-aud AUD              Cloudflare Access application audience tag
  --yes                         Do not prompt for routes; deploy without routes when omitted
  -h, --help                    Show this help

The script reuses .wrangler.generated.provision.toml on subsequent runs.
USAGE
}

while (($#)); do
  case "$1" in
    --name) PREFIX="${2:?Missing value for --name}"; shift 2 ;;
    --routes) ROUTES="${2:?Missing value for --routes}"; shift 2 ;;
    --access-team-domain) ACCESS_TEAM_DOMAIN="${2:?Missing value for --access-team-domain}"; shift 2 ;;
    --access-aud) ACCESS_AUD="${2:?Missing value for --access-aud}"; shift 2 ;;
    --yes) NON_INTERACTIVE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ! "$PREFIX" =~ ^[a-z0-9][a-z0-9-]{1,40}$ ]]; then
  echo "--name must use lowercase letters, numbers, and hyphens." >&2
  exit 2
fi

command -v node >/dev/null || { echo "Node.js 20+ is required." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required." >&2; exit 1; }
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 20 )); then
  echo "Node.js 20+ is required; found $(node --version)." >&2
  exit 1
fi

if [[ -z "$ROUTES" && "$NON_INTERACTIVE" -eq 0 && -t 0 ]]; then
  read -r -p "Load-balanced hostnames, comma separated (blank to configure later): " ROUTES
fi

if [[ -n "$ACCESS_TEAM_DOMAIN" && ! "$ACCESS_TEAM_DOMAIN" =~ ^[a-zA-Z0-9.-]+$ ]]; then
  echo "Invalid Cloudflare Access team domain." >&2
  exit 2
fi
if [[ -n "$ACCESS_AUD" && ! "$ACCESS_AUD" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Invalid Cloudflare Access audience tag." >&2
  exit 2
fi

echo "[1/8] Installing dependencies and building WebUI"
npm install
npm run check
npm run build

echo "[2/8] Checking Cloudflare authentication"
if ! npx wrangler whoami >/dev/null 2>&1; then
  if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    echo "Cloudflare API token authentication failed." >&2
    exit 1
  fi
  npx wrangler login
fi

PROVISION_CONFIG=".wrangler.generated.provision.toml"
CONTROL_CONFIG=".wrangler.generated.control.toml"
HEALTH_CONFIG=".wrangler.generated.health.toml"
TRAFFIC_CONFIG=".wrangler.generated.traffic.toml"

if [[ ! -f "$PROVISION_CONFIG" ]]; then
  cat > "$PROVISION_CONFIG" <<EOF
name = "$PREFIX-control"
main = "workers/control/index.ts"
compatibility_date = "2026-09-15"
EOF

  echo "[3/8] Creating D1 database"
  npx wrangler d1 create "$PREFIX" --binding DB --update-config --config "$PROVISION_CONFIG"
  echo "[4/8] Creating KV namespace"
  npx wrangler kv namespace create "$PREFIX-config" --binding CONFIG_KV --update-config --config "$PROVISION_CONFIG"
else
  echo "[3/8] Reusing existing D1 database"
  echo "[4/8] Reusing existing KV namespace"
fi

DB_ID="$(sed -nE 's/^[[:space:]]*database_id[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$PROVISION_CONFIG" | head -1)"
KV_ID="$(sed -nE 's/^[[:space:]]*id[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$PROVISION_CONFIG" | tail -1)"
if [[ -z "$DB_ID" || -z "$KV_ID" ]]; then
  echo "Could not read the generated D1/KV identifiers from $PROVISION_CONFIG." >&2
  exit 1
fi

ROUTES_TOML=""
if [[ -n "$ROUTES" ]]; then
  IFS=',' read -r -a HOSTS <<< "$ROUTES"
  ROUTE_ITEMS=()
  for raw_host in "${HOSTS[@]}"; do
    host="$(printf '%s' "$raw_host" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
    if [[ ! "$host" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
      echo "Invalid route hostname: $host" >&2
      exit 2
    fi
    ROUTE_ITEMS+=("\"$host/*\"")
  done
  ROUTES_TOML="routes = [$(IFS=,; echo "${ROUTE_ITEMS[*]}")]"
fi

ACCESS_VARS=""
if [[ -n "$ACCESS_TEAM_DOMAIN" || -n "$ACCESS_AUD" ]]; then
  if [[ -z "$ACCESS_TEAM_DOMAIN" || -z "$ACCESS_AUD" ]]; then
    echo "Both --access-team-domain and --access-aud are required together." >&2
    exit 2
  fi
  ACCESS_VARS=$(cat <<EOF
ACCESS_TEAM_DOMAIN = "$ACCESS_TEAM_DOMAIN"
ACCESS_AUD = "$ACCESS_AUD"
EOF
)
fi

cat > "$CONTROL_CONFIG" <<EOF
name = "$PREFIX-control"
main = "workers/control/index.ts"
compatibility_date = "2026-09-15"

[assets]
directory = "./dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = true

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
$ACCESS_VARS
EOF

cat > "$HEALTH_CONFIG" <<EOF
name = "$PREFIX-health"
main = "workers/health/index.ts"
compatibility_date = "2026-09-15"

[triggers]
crons = ["* * * * *"]

[[d1_databases]]
binding = "DB"
database_name = "$PREFIX"
database_id = "$DB_ID"

[[kv_namespaces]]
binding = "CONFIG_KV"
id = "$KV_ID"

[vars]
ENVIRONMENT = "production"
EOF

cat > "$TRAFFIC_CONFIG" <<EOF
name = "$PREFIX-traffic"
main = "workers/traffic/index.ts"
compatibility_date = "2026-09-15"
$ROUTES_TOML

[[d1_databases]]
binding = "DB"
database_name = "$PREFIX"
database_id = "$DB_ID"

[[kv_namespaces]]
binding = "CONFIG_KV"
id = "$KV_ID"

[vars]
CONFIG_CACHE_SECONDS = "5"
REQUEST_LOG_SAMPLE_RATE = "0.01"
EOF

echo "[5/8] Applying D1 migrations"
npx wrangler d1 migrations apply "$PREFIX" --remote --config "$CONTROL_CONFIG"

command -v openssl >/dev/null || { echo "openssl is required to generate secrets." >&2; exit 1; }
SECRETS_FILE=".wrangler.generated.secrets"
if [[ -f "$SECRETS_FILE" ]]; then
  # This file is generated locally by this installer and is never committed.
  source "$SECRETS_FILE"
else
  ADMIN_TOKEN="wlb_$(openssl rand -hex 24)"
  AFFINITY_SECRET="$(openssl rand -hex 32)"
  umask 077
  cat > "$SECRETS_FILE" <<EOF
ADMIN_TOKEN='$ADMIN_TOKEN'
AFFINITY_SECRET='$AFFINITY_SECRET'
EOF
fi

echo "[6/8] Deploying control Worker and UI"
npx wrangler deploy --config "$CONTROL_CONFIG"
printf '%s' "$ADMIN_TOKEN" | npx wrangler secret put ADMIN_TOKEN --config "$CONTROL_CONFIG"

echo "[7/8] Deploying scheduled health Worker"
npx wrangler deploy --config "$HEALTH_CONFIG"

echo "[8/8] Deploying traffic Worker"
npx wrangler deploy --config "$TRAFFIC_CONFIG"
printf '%s' "$AFFINITY_SECRET" | npx wrangler secret put AFFINITY_SECRET --config "$TRAFFIC_CONFIG"

cat <<EOF

Worker LB has been deployed.

Management token (shown once):
$ADMIN_TOKEN

Open the $PREFIX-control workers.dev URL printed above. If Cloudflare Access is
configured, login through Access. Otherwise enter this token in the WebUI.

Traffic routes: ${ROUTES:-not configured}
Generated configs are stored in .wrangler.generated.*.toml and can be reused.
EOF
