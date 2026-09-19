#!/usr/bin/env bash
# =============================================================================
# Tenant Graph application roles for M365 follow-through (work bus).
# Grants every TaskBrain App Service identity in the resource group
# (gateway, worker, admin) AND the Function system-assigned identity:
#   Tasks.ReadWrite.All  (To Do + Planner write for another person)
#   Chat.Create
#   Chat.ReadWrite.All   (1:1 Adaptive Card when no conversationRef)
#   Mail.Send            (last-resort fallback; needs FOLLOWTHROUGH_MAIL_FROM)
#
# Channel posts need FOLLOWTHROUGH_TEAM_ID / FOLLOWTHROUGH_CHANNEL_ID in Bicep.
# Planner write-through needs PLANNER_PLAN_ID (optional PLANNER_BUCKET_ID).
#
# Does NOT mint or rotate secrets. Admin consent is implicit in app-role
# assignment to the Graph service principal.
#
# Usage:
#   ./scripts/setup-followthrough.sh [resource-group]
# =============================================================================
set -euo pipefail

RG="${1:-rg-taskbrain}"
GRAPH_APP_ID="00000003-0000-0000-c000-000000000000"
ROLE_TASKS_READWRITE_ALL="44e666d1-d276-445b-a5fc-8815eeb81d55"
ROLE_CHAT_CREATE="d9c48af6-9ad9-47ad-82c3-63757137b9af"
ROLE_CHAT_READWRITE_ALL="294ce7c9-31ba-490a-ad7d-97a7d075e4ed"
ROLE_MAIL_SEND="b633e1c5-b582-4048-a93e-9f11b44c7e96"

FUNC_NAME=$(az functionapp list -g "$RG" --query "[?starts_with(name, 'func-taskbrain')].name | [0]" -o tsv)
APPS=$(az webapp list -g "$RG" --query "[?contains(name, 'taskbrain')].name" -o tsv)
if [[ -z "$APPS" ]]; then
  echo "No App Service matching *taskbrain* in $RG. Deploy infra first." >&2
  exit 1
fi

GRAPH_SP=$(az ad sp list --filter "appId eq '$GRAPH_APP_ID'" --query "[0].id" -o tsv)

assign_role() {
  local principal_id="$1"
  local role_id="$2"
  local name="$3"
  existing=$(az rest --method GET \
    --uri "https://graph.microsoft.com/v1.0/servicePrincipals/${principal_id}/appRoleAssignments" \
    --query "value[?appRoleId=='${role_id}'].id" -o tsv || true)
  if [[ -n "$existing" ]]; then
    echo "already assigned $name"
    return
  fi
  az rest --method POST \
    --uri "https://graph.microsoft.com/v1.0/servicePrincipals/${GRAPH_SP}/appRoleAssignedTo" \
    --headers "Content-Type=application/json" \
    --body "{\"principalId\":\"${principal_id}\",\"resourceId\":\"${GRAPH_SP}\",\"appRoleId\":\"${role_id}\"}" \
    >/dev/null
  echo "assigned $name"
}

grant_principal() {
  local label="$1"
  local principal_id="$2"
  echo
  echo "$label principal $principal_id"
  assign_role "$principal_id" "$ROLE_TASKS_READWRITE_ALL" "Tasks.ReadWrite.All"
  assign_role "$principal_id" "$ROLE_CHAT_CREATE" "Chat.Create"
  assign_role "$principal_id" "$ROLE_CHAT_READWRITE_ALL" "Chat.ReadWrite.All"
  assign_role "$principal_id" "$ROLE_MAIL_SEND" "Mail.Send"
}

# Grant every TaskBrain webapp identity (gateway, worker, admin).
while IFS=$'\t' read -r name pid; do
  [[ -z "$pid" || "$pid" == "None" ]] && continue
  grant_principal "App Service $name" "$pid"
done < <(az webapp list -g "$RG" --query "[?contains(name, 'taskbrain')].[name, identity.principalId]" -o tsv)

if [[ -n "$FUNC_NAME" ]]; then
  FUNC_PID=$(az functionapp identity show -g "$RG" -n "$FUNC_NAME" --query principalId -o tsv)
  grant_principal "Function $FUNC_NAME" "$FUNC_PID"
fi

cat <<EOF

Graph application roles are assigned. Still needed in the tenant:

  1. Create a Teams team/channel for Follow-through (or pick an existing one).
  2. Redeploy Bicep with followthroughTeamId / followthroughChannelId.
  3. Optional: a Planner plan id (plannerPlanId) for people with a planner queue.
  4. Optional: followthroughMailFrom (a mailbox UPN) if Teams delivery fails.

Until those ids are set, the worker still fans out via a stored Teams
conversation reference when the owner has opened the 1:1 bot. Graph 1:1 / To Do
writes run on the worker identity, which must have the roles above.
EOF
