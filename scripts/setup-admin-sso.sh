#!/usr/bin/env bash
# =============================================================================
# Create (or reuse) the TaskBrain Admin Entra app used by App Service Easy Auth.
# Safe to run against an already-deployed bot — it does NOT reset the bot secret.
#
# What it does:
#   1. App registration "TaskBrain Admin" (single-tenant) + client secret
#   2. User assignment required on the enterprise app
#   3. Assigns the signed-in user (so you are not locked out)
#   4. Easy Auth redirect URI for the App Service hostname, if the app exists
#   5. Sets GitHub secrets ADMIN_APP_ID / ADMIN_APP_SECRET when `gh` is logged in
#
# Usage:
#   ./scripts/setup-admin-sso.sh [org/repo] [resource-group]
# =============================================================================
set -euo pipefail

GITHUB_REPO="${1:-}"
RG="${2:-rg-taskbrain}"
ADMIN_APP_NAME="TaskBrain Admin"

if [[ -z "$GITHUB_REPO" ]]; then
  GITHUB_REPO=$(git remote get-url origin 2>/dev/null | sed -E 's#.*github.com[:/](.+)(\.git)?#\1#' | sed 's/\.git$//' || true)
fi

TENANT_ID=$(az account show --query tenantId -o tsv)
echo "Tenant: $TENANT_ID"
echo "RG:     $RG"
echo

app_id=$(az ad app list --display-name "$ADMIN_APP_NAME" --query "[0].appId" -o tsv)
if [[ -z "$app_id" ]]; then
  app_id=$(az ad app create --display-name "$ADMIN_APP_NAME" --sign-in-audience AzureADMyOrg --query appId -o tsv)
  echo "created app '$ADMIN_APP_NAME' ($app_id)"
else
  echo "reusing app '$ADMIN_APP_NAME' ($app_id)"
fi

az ad sp show --id "$app_id" >/dev/null 2>&1 || az ad sp create --id "$app_id" >/dev/null
sp_oid=$(az ad sp show --id "$app_id" --query id -o tsv)

# User.Read so Easy Auth can read the signed-in profile
az ad app permission add \
  --id "$app_id" \
  --api 00000003-0000-0000-c000-000000000000 \
  --api-permissions e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope \
  --only-show-errors 2>/dev/null || true

az ad sp update --id "$app_id" --set appRoleAssignmentRequired=true >/dev/null
echo "user assignment required"

# Easy Auth signs in with response_type=code+id_token, so the registration must
# issue ID tokens. Without this the callback fails after the user authenticates.
app_obj=$(az ad app show --id "$app_id" --query id -o tsv)
az rest --method PATCH \
  --uri "https://graph.microsoft.com/v1.0/applications/${app_obj}" \
  --body '{"web":{"implicitGrantSettings":{"enableIdTokenIssuance":true}}}' \
  --headers "Content-Type=application/json" >/dev/null
echo "ID token issuance enabled"

ADMIN_OID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo "")
if [[ -n "$ADMIN_OID" ]]; then
  existing=$(az rest --method GET \
    --uri "https://graph.microsoft.com/v1.0/servicePrincipals/${sp_oid}/appRoleAssignedTo" \
    --query "value[?principalId=='${ADMIN_OID}'].id | [0]" -o tsv 2>/dev/null || echo "")
  if [[ -z "$existing" ]]; then
    az rest --method POST \
      --uri "https://graph.microsoft.com/v1.0/servicePrincipals/${sp_oid}/appRoleAssignedTo" \
      --body "{\"principalId\":\"${ADMIN_OID}\",\"resourceId\":\"${sp_oid}\",\"appRoleId\":\"00000000-0000-0000-0000-000000000000\"}" \
      --headers "Content-Type=application/json" >/dev/null
    echo "assigned signed-in user to '$ADMIN_APP_NAME'"
  else
    echo "signed-in user already assigned"
  fi
fi

HOST=$(az webapp list -g "$RG" --query "[?starts_with(name, 'app-taskbrain')].defaultHostName | [0]" -o tsv 2>/dev/null || echo "")
if [[ -n "$HOST" ]]; then
  az ad app update --id "$app_id" \
    --web-redirect-uris "https://${HOST}/.auth/login/aad/callback" \
    --only-show-errors
  echo "redirect URI: https://${HOST}/.auth/login/aad/callback"
else
  echo "WARNING: no App Service in $RG yet — re-run this script after the first deploy to set the Easy Auth redirect URI"
fi

ADMIN_APP_SECRET=$(az ad app credential reset \
  --id "$app_id" \
  --display-name "taskbrain-admin-$(date +%Y%m%d)" \
  --years 2 \
  --query password -o tsv)
echo "admin app secret minted"

if [[ -n "$GITHUB_REPO" ]] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh secret set ADMIN_APP_ID     -R "$GITHUB_REPO" -b "$app_id"
  gh secret set ADMIN_APP_SECRET -R "$GITHUB_REPO" -b "$ADMIN_APP_SECRET"
  echo "GitHub secrets ADMIN_APP_ID / ADMIN_APP_SECRET set on $GITHUB_REPO"
else
  echo "Set GitHub secrets:"
  echo "  ADMIN_APP_ID     = $app_id"
  echo "  ADMIN_APP_SECRET = $ADMIN_APP_SECRET"
fi

cat << SUMMARY

Share https://${HOST:-<app-hostname>}/admin — Entra login, no key in the URL.

Add more viewers:
  Entra admin center → Enterprise applications → ${ADMIN_APP_NAME}
  → Users and groups → Add user/group

This is a separate app from TaskBrain Bot, so assignment here does not
block Teams chat or Microsoft To Do OAuth.
SUMMARY
