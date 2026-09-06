#!/usr/bin/env bash
# =============================================================================
# TaskBrain bootstrap — one-time Entra / M365 prerequisites
# Run this BEFORE deploying infra or code. Idempotent: safe to re-run; it
# reuses anything that already exists by display name.
#
# What it creates:
#   1. Bot app registration (single-tenant) + client secret
#      - Graph delegated permission Tasks.ReadWrite (for Microsoft To Do)
#   2. CI app registration for GitHub Actions with OIDC federated credentials
#      (no secret) for BOTH subject formats GitHub may present
#      (name-based and org@id/repo@id) + Contributor on the resource group
#   3. Resource group (so the role assignment has a target)
#   4. Patched copies of teams-app/manifest.json and .env with real IDs
#
# What it prints at the end: every value you need, grouped by destination
# (.env, GitHub secrets, portal follow-ups).
#
# Prereqs: az CLI 2.60+, logged in (az login) as a user who can create app
# registrations and role assignments (Application Administrator + Owner/User
# Access Administrator on the subscription, or Global Admin).
#
# Usage:
#   ./scripts/bootstrap.sh <github-org>/<github-repo> [resource-group] [location]
# Example:
#   ./scripts/bootstrap.sh tristan-energy/taskbrain rg-taskbrain eastus
# =============================================================================
set -euo pipefail

GITHUB_REPO="${1:?Usage: bootstrap.sh <github-org>/<github-repo> [resource-group] [location]}"
RG="${2:-rg-taskbrain}"
LOCATION="${3:-eastus}"
BOT_APP_NAME="TaskBrain Bot"
CI_APP_NAME="TaskBrain GitHub CI"
GITHUB_ENV_NAME="production"   # must match `environment:` in deploy.yml

SUB_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
echo "Subscription: $SUB_ID"
echo "Tenant:       $TENANT_ID"
echo

# -----------------------------------------------------------------------------
# Helper: get-or-create an app registration by display name, echo its appId
# -----------------------------------------------------------------------------
get_or_create_app() {
  local name="$1"
  local app_id
  app_id=$(az ad app list --display-name "$name" --query "[0].appId" -o tsv)
  if [[ -z "$app_id" ]]; then
    app_id=$(az ad app create --display-name "$name" --sign-in-audience AzureADMyOrg --query appId -o tsv)
    echo "created app '$name' ($app_id)" >&2
  else
    echo "reusing app '$name' ($app_id)" >&2
  fi
  echo "$app_id"
}

# -----------------------------------------------------------------------------
# 1. Bot app registration
# -----------------------------------------------------------------------------
echo "== Bot app registration =="
BOT_APP_ID=$(get_or_create_app "$BOT_APP_NAME")

# Service principal (required for SingleTenant bots + Graph consent)
az ad sp show --id "$BOT_APP_ID" >/dev/null 2>&1 || az ad sp create --id "$BOT_APP_ID" >/dev/null
echo "service principal ok"

# Client secret (2-year). Re-running mints a new one; old ones keep working
# until you clean them up in the portal.
BOT_APP_SECRET=$(az ad app credential reset \
  --id "$BOT_APP_ID" \
  --display-name "taskbrain-$(date +%Y%m%d)" \
  --years 2 \
  --query password -o tsv)
echo "client secret minted"

# Graph delegated permission: Tasks.ReadWrite (Microsoft To Do)
# Graph API appId: 00000003-0000-0000-c000-000000000000
# Tasks.ReadWrite delegated scope id: 2219042f-cab5-40cc-b0d2-16b1540b4c5f
az ad app permission add \
  --id "$BOT_APP_ID" \
  --api 00000003-0000-0000-c000-000000000000 \
  --api-permissions 2219042f-cab5-40cc-b0d2-16b1540b4c5f=Scope \
  --only-show-errors 2>/dev/null || true
echo "Graph Tasks.ReadWrite (delegated) requested"

# Admin consent so users never see a consent wall in the OAuth card
if az ad app permission admin-consent --id "$BOT_APP_ID" --only-show-errors 2>/dev/null; then
  echo "admin consent granted"
else
  echo "WARNING: admin consent failed (insufficient role?) — grant it in the portal:"
  echo "  Entra admin center > App registrations > $BOT_APP_NAME > API permissions > Grant admin consent"
fi

# Redirect URI for the Bot Service OAuth flow (token.botframework.com)
az ad app update --id "$BOT_APP_ID" \
  --web-redirect-uris "https://token.botframework.com/.auth/web/redirect" \
  --only-show-errors
echo "OAuth redirect URI set"

# -----------------------------------------------------------------------------
# 2. Resource providers. A new subscription has most of these unregistered, and
# ARM preflight does NOT catch it — the Bicep deploy fails partway through with
# MissingSubscriptionRegistration. Registering is idempotent and free.
# -----------------------------------------------------------------------------
echo
echo "== Resource providers =="
RPS=(
  Microsoft.Web                    # App Service plan + site
  Microsoft.ContainerRegistry      # application image registry + ACR Tasks
  Microsoft.Storage                # notes blobs
  Microsoft.DocumentDB             # Cosmos
  Microsoft.CognitiveServices      # Speech + Foundry (AIServices) models — there is no Microsoft.Foundry RP
  Microsoft.MachineLearningServices # Foundry hub/project in ai.azure.com
  Microsoft.Capacity               # Azure Portal Quotas blade
  Microsoft.Insights               # App Insights
  Microsoft.BotService             # Azure Bot + Teams channel
)
PENDING=()
for rp in "${RPS[@]}"; do
  state=$(az provider show -n "$rp" --query registrationState -o tsv 2>/dev/null || echo "NotRegistered")
  if [[ "$state" == "Registered" ]]; then
    echo "  $rp already registered"
  else
    az provider register -n "$rp" --only-show-errors >/dev/null
    PENDING+=("$rp")
    echo "  $rp registering..."
  fi
done
for i in $(seq 1 30); do
  [[ ${#PENDING[@]} -eq 0 ]] && break
  STILL=()
  for rp in "${PENDING[@]}"; do
    state=$(az provider show -n "$rp" --query registrationState -o tsv 2>/dev/null || echo "")
    if [[ "$state" == "Registered" ]]; then
      echo "  $rp registered"
    else
      STILL+=("$rp")
    fi
  done
  PENDING=("${STILL[@]}")
  [[ ${#PENDING[@]} -eq 0 ]] && break
  sleep 10
done
if [[ ${#PENDING[@]} -gt 0 ]]; then
  echo "WARNING: still registering: ${PENDING[*]}"
  echo "  Deploy may fail with MissingSubscriptionRegistration; re-run the pipeline once they finish."
fi

# -----------------------------------------------------------------------------
# 2b. Resource group (needed as role-assignment scope before infra deploys)
# -----------------------------------------------------------------------------
echo
echo "== Resource group =="
az group create -n "$RG" -l "$LOCATION" --only-show-errors -o none
echo "resource group $RG ready in $LOCATION"

# -----------------------------------------------------------------------------
# 3. CI app registration + OIDC federated credential + RBAC
# -----------------------------------------------------------------------------
echo
echo "== GitHub Actions CI identity (OIDC, no secrets) =="
CI_APP_ID=$(get_or_create_app "$CI_APP_NAME")
az ad sp show --id "$CI_APP_ID" >/dev/null 2>&1 || az ad sp create --id "$CI_APP_ID" >/dev/null
CI_APP_OBJECT_ID=$(az ad app show --id "$CI_APP_ID" --query id -o tsv)

# Wait for the service principal to replicate — assigning by appId in the
# seconds after create is what produced "No subscriptions found" (login
# succeeded, RBAC saw nothing) on the first pipeline run.
CI_SP_OBJECT_ID=""
for i in $(seq 1 12); do
  CI_SP_OBJECT_ID=$(az ad sp show --id "$CI_APP_ID" --query id -o tsv 2>/dev/null || true)
  if [[ -n "$CI_SP_OBJECT_ID" ]]; then
    break
  fi
  echo "waiting for CI service principal to replicate ($i/12)..."
  sleep 5
done
if [[ -z "$CI_SP_OBJECT_ID" ]]; then
  echo "ERROR: CI service principal never became visible. Re-run this script." >&2
  exit 1
fi

# GitHub Actions may present either the name-based subject or the immutable
# org@id/repo@id form. Create both so azure/login succeeds either way.
ensure_federated_credential() {
  local name="$1"
  local subject="$2"
  if az ad app federated-credential show --id "$CI_APP_OBJECT_ID" --federated-credential-id "$name" >/dev/null 2>&1; then
    echo "federated credential '$name' already exists"
    return 0
  fi
  local existing
  existing=$(az ad app federated-credential list --id "$CI_APP_OBJECT_ID" \
    --query "[?subject=='${subject}'].name | [0]" -o tsv)
  if [[ -n "$existing" ]]; then
    echo "federated credential for subject already exists as '$existing'"
    return 0
  fi
  az ad app federated-credential create --id "$CI_APP_OBJECT_ID" --parameters "{
    \"name\": \"$name\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"$subject\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }" -o none
  echo "federated credential created: $subject"
}

ensure_federated_credential \
  "github-${GITHUB_ENV_NAME}" \
  "repo:${GITHUB_REPO}:environment:${GITHUB_ENV_NAME}"

GH_OWNER_ID=""
GH_REPO_ID=""
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  GH_OWNER_ID=$(gh api "repos/${GITHUB_REPO}" --jq .owner.id)
  GH_REPO_ID=$(gh api "repos/${GITHUB_REPO}" --jq .id)
else
  GH_JSON=$(curl -fsS "https://api.github.com/repos/${GITHUB_REPO}" 2>/dev/null || true)
  if [[ -n "$GH_JSON" ]] && command -v node >/dev/null 2>&1; then
    GH_OWNER_ID=$(printf '%s' "$GH_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);process.stdout.write(String(j.owner.id))})")
    GH_REPO_ID=$(printf '%s' "$GH_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);process.stdout.write(String(j.id))})")
  fi
fi
if [[ -n "$GH_OWNER_ID" && -n "$GH_REPO_ID" ]]; then
  OWNER="${GITHUB_REPO%%/*}"
  REPO="${GITHUB_REPO##*/}"
  ensure_federated_credential \
    "github-${GITHUB_ENV_NAME}-ids" \
    "repo:${OWNER}@${GH_OWNER_ID}/${REPO}@${GH_REPO_ID}:environment:${GITHUB_ENV_NAME}"
else
  echo "WARNING: could not resolve GitHub org/repo numeric IDs."
  echo "  If azure/login later fails with AADSTS700213, add a second federated"
  echo "  credential whose subject matches the claim GitHub printed in the log"
  echo "  (repo:Org@NNNN/repo@NNNN:environment:${GITHUB_ENV_NAME})."
fi

# Contributor deploys resources. Role Based Access Control Administrator lets
# Bicep grant the App Service managed identity AcrPull on the registry. ACR
# Tasks Contributor runs remote builds; AcrPush publishes their resulting tags.
# All roles are RG-scoped; CI cannot assign access outside this application.
# Assign by object id so we do not race Entra lookup-by-appId.
SCOPE="/subscriptions/${SUB_ID}/resourceGroups/${RG}"
ensure_role_assignment() {
  local role="$1"
  local existing
  existing=$(az role assignment list \
    --assignee-object-id "$CI_SP_OBJECT_ID" \
    --scope "$SCOPE" \
    --query "[?roleDefinitionName=='${role}'].id | [0]" -o tsv)
  if [[ -n "$existing" ]]; then
    echo "$role already assigned on $RG"
    return 0
  fi
  az role assignment create \
    --assignee-object-id "$CI_SP_OBJECT_ID" \
    --assignee-principal-type ServicePrincipal \
    --role "$role" \
    --scope "$SCOPE" \
    --only-show-errors -o none
  echo "$role granted on $RG"
}

ensure_role_assignment "Contributor"
ensure_role_assignment "Role Based Access Control Administrator"
ensure_role_assignment "Container Registry Tasks Contributor"
ensure_role_assignment "AcrPush"

# -----------------------------------------------------------------------------
# 4. Admin identity (for alerts) — your own object id
# -----------------------------------------------------------------------------
ADMIN_OID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo "")

# -----------------------------------------------------------------------------
# 4b. Admin dashboard key
# -----------------------------------------------------------------------------
ADMIN_KEY=$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 48)

# -----------------------------------------------------------------------------
# 5. Patch local files with real values
# -----------------------------------------------------------------------------
echo
echo "== Patching local files =="
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

if [[ -f "$ROOT/teams-app/manifest.json" ]]; then
  sed -i.bak "s/REPLACE-WITH-BOT-APP-ID/${BOT_APP_ID}/g" "$ROOT/teams-app/manifest.json" \
    && rm -f "$ROOT/teams-app/manifest.json.bak"
  echo "teams-app/manifest.json patched with bot app id"
fi

if [[ -f "$ROOT/.env.example" && ! -f "$ROOT/.env" ]]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
fi
if [[ -f "$ROOT/.env" ]]; then
  sed -i.bak \
    -e "s|^MicrosoftAppId=.*|MicrosoftAppId=${BOT_APP_ID}|" \
    -e "s|^MicrosoftAppPassword=.*|MicrosoftAppPassword=${BOT_APP_SECRET}|" \
    -e "s|^MicrosoftAppTenantId=.*|MicrosoftAppTenantId=${TENANT_ID}|" \
    -e "s|^ADMIN_AAD_OBJECT_ID=.*|ADMIN_AAD_OBJECT_ID=${ADMIN_OID}|" \
    -e "s|^ADMIN_KEY=.*|ADMIN_KEY=${ADMIN_KEY}|" \
    "$ROOT/.env" && rm -f "$ROOT/.env.bak"
  echo ".env patched (bot id, secret, tenant, admin oid) — .env is gitignored"
fi

# -----------------------------------------------------------------------------
# 5b. Push secrets to GitHub automatically if `gh` is installed and logged in
# -----------------------------------------------------------------------------
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  echo
  echo "== Setting GitHub secrets on ${GITHUB_REPO} via gh =="
  gh secret set AZURE_CLIENT_ID        -R "$GITHUB_REPO" -b "$CI_APP_ID"
  gh secret set AZURE_TENANT_ID        -R "$GITHUB_REPO" -b "$TENANT_ID"
  gh secret set AZURE_SUBSCRIPTION_ID  -R "$GITHUB_REPO" -b "$SUB_ID"
  gh secret set BOT_APP_ID             -R "$GITHUB_REPO" -b "$BOT_APP_ID"
  gh secret set BOT_APP_PASSWORD       -R "$GITHUB_REPO" -b "$BOT_APP_SECRET"
  gh secret set ADMIN_KEY              -R "$GITHUB_REPO" -b "$ADMIN_KEY"
  [[ -n "$ADMIN_OID" ]] && gh secret set ADMIN_AAD_OBJECT_ID -R "$GITHUB_REPO" -b "$ADMIN_OID"
  # Environment the federated credential is bound to
  gh api -X PUT "repos/${GITHUB_REPO}/environments/${GITHUB_ENV_NAME}" >/dev/null && echo "environment '${GITHUB_ENV_NAME}' ensured"
  echo "GitHub secrets set. (Optional ones — Smartsheet/Photon — add later with: gh secret set NAME -R $GITHUB_REPO)"
  GH_DONE=1
else
  GH_DONE=0
fi

# -----------------------------------------------------------------------------
# 6. The handoff sheet
# -----------------------------------------------------------------------------
cat << SUMMARY

=============================================================================
BOOTSTRAP COMPLETE — copy these where they belong
=============================================================================

--> GitHub repo secrets  (Settings > Secrets and variables > Actions)
    REQUIRED — the pipeline refuses to run without these:
    AZURE_CLIENT_ID        = ${CI_APP_ID}
    AZURE_TENANT_ID        = ${TENANT_ID}
    AZURE_SUBSCRIPTION_ID  = ${SUB_ID}
    BOT_APP_ID             = ${BOT_APP_ID}
    BOT_APP_PASSWORD       = ${BOT_APP_SECRET}
    ADMIN_KEY              = ${ADMIN_KEY}
    ADMIN_AAD_OBJECT_ID    = ${ADMIN_OID:-<your object id>}
    OPTIONAL — add when you have them (empty = feature disabled):
    SMARTSHEET_API_TOKEN, SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET

--> GitHub repo: create an Environment named "${GITHUB_ENV_NAME}"
    (Settings > Environments) — the federated credential is bound to it.

--> App Service settings: NONE to set by hand. Bicep wires every runtime
    setting (Cosmos/Storage/Speech/Foundry keys, model deployment names, the
    secrets above) on each deploy.

--> Local .env: already patched. NOTE: the client secret above is shown ONCE
    here and stored in .env — treat this terminal output as sensitive.

--> Portal follow-ups that can't be scripted:
    1. Teams app package: zip manifest.json + color.png + outline.png from
       teams-app/ and upload via Teams admin center > Manage apps.
    2. If admin consent printed a WARNING above, grant it in Entra.
       (Graph OAuth connection graph-connection is created by Bicep.)
=============================================================================
SUMMARY
