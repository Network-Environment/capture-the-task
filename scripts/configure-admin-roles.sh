#!/usr/bin/env bash
# Configure TaskBrain Admin app roles and their initial user assignments.
# Safe to rerun: role definitions and assignments converge without rotating secrets.
set -euo pipefail

ADMIN_APP_NAME="TaskBrain Admin"
ADMIN_ROLE_ID="9f4b3418-1c5f-4ad6-87c8-3c8ca316f854"
READER_ROLE_ID="e2e58f6d-94fb-47df-94b0-f5572fda7e4b"
ADMIN_UPN="${TASKBRAIN_ADMIN_UPN:-syslord@netenv.com}"
READER_UPNS="${TASKBRAIN_READER_UPNS:-vmoraru@netenv.com,jryan@netenv.com}"

app_id="${1:-}"
if [[ -z "$app_id" ]]; then
  app_id=$(az ad app list --display-name "$ADMIN_APP_NAME" --query "[0].appId" -o tsv)
fi
if [[ -z "$app_id" ]]; then
  echo "TaskBrain Admin app registration was not found" >&2
  exit 1
fi

app_obj=$(az ad app show --id "$app_id" --query id -o tsv)
sp_oid=$(az ad sp show --id "$app_id" --query id -o tsv)
current_roles=$(az ad app show --id "$app_id" --query appRoles -o json)
roles=$(jq \
  --arg admin "$ADMIN_ROLE_ID" \
  --arg reader "$READER_ROLE_ID" \
  'map(select(.value != "Admin" and .value != "Reader")) + [
    {
      allowedMemberTypes: ["User"],
      description: "Full access to TaskBrain Admin, including mutations.",
      displayName: "Admin",
      id: $admin,
      isEnabled: true,
      value: "Admin"
    },
    {
      allowedMemberTypes: ["User"],
      description: "Read-only access to TaskBrain Admin.",
      displayName: "Reader",
      id: $reader,
      isEnabled: true,
      value: "Reader"
    }
  ]' <<<"$current_roles")
body=$(jq -n --argjson appRoles "$roles" '{appRoles: $appRoles}')
az rest --method PATCH \
  --uri "https://graph.microsoft.com/v1.0/applications/${app_obj}" \
  --body "$body" \
  --headers "Content-Type=application/json" >/dev/null
az ad sp update --id "$app_id" --set appRoleAssignmentRequired=true >/dev/null
echo "configured Admin and Reader app roles"

assign_role() {
  local upn="$1"
  local role_id="$2"
  local role_name="$3"
  local user_id
  user_id=$(az ad user show --id "$upn" --query id -o tsv)

  local assignments
  assignments=$(az rest --method GET \
    --uri "https://graph.microsoft.com/v1.0/servicePrincipals/${sp_oid}/appRoleAssignedTo" \
    -o json)

  while IFS=$'\t' read -r assignment_id assigned_role; do
    [[ -z "${assignment_id:-}" ]] && continue
    if [[ "$assigned_role" != "$role_id" ]]; then
      az rest --method DELETE \
        --uri "https://graph.microsoft.com/v1.0/servicePrincipals/${sp_oid}/appRoleAssignedTo/${assignment_id}" \
        >/dev/null
    fi
  done < <(jq -r --arg user "$user_id" \
    '.value[] | select(.principalId == $user) | [.id, .appRoleId] | @tsv' \
    <<<"$assignments")

  local existing
  existing=$(jq -r --arg user "$user_id" --arg role "$role_id" \
    '[.value[] | select(.principalId == $user and .appRoleId == $role) | .id][0] // ""' \
    <<<"$assignments")
  if [[ -z "$existing" ]]; then
    az rest --method POST \
      --uri "https://graph.microsoft.com/v1.0/servicePrincipals/${sp_oid}/appRoleAssignedTo" \
      --body "{\"principalId\":\"${user_id}\",\"resourceId\":\"${sp_oid}\",\"appRoleId\":\"${role_id}\"}" \
      --headers "Content-Type=application/json" >/dev/null
  fi
  echo "assigned ${upn} -> ${role_name}"
}

assign_role "$ADMIN_UPN" "$ADMIN_ROLE_ID" "Admin"
IFS=',' read -ra readers <<<"$READER_UPNS"
for upn in "${readers[@]}"; do
  upn="${upn//[[:space:]]/}"
  [[ -n "$upn" ]] && assign_role "$upn" "$READER_ROLE_ID" "Reader"
done
