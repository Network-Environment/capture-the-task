#!/usr/bin/env bash
# =============================================================================
# Tenant prerequisites for Teams meeting ingest. Safe against a live bot:
# does NOT mint or rotate the bot secret. Run AFTER the Function App exists
# (first Bicep deploy). Graph/Teams policy can take up to ~30 minutes to apply.
#
# Grants the Function system-assigned identity:
#   User.Read.All
#   OnlineMeetings.Read.All
#   OnlineMeetingTranscript.Read.All
# then prints the Teams PowerShell that must be run by a Teams admin.
#
# Usage:
#   ./scripts/setup-meeting-ingest.sh [resource-group]
# =============================================================================
set -euo pipefail

RG="${1:-rg-taskbrain}"
GRAPH_APP_ID="00000003-0000-0000-c000-000000000000"
# Microsoft Graph application roles
ROLE_USER_READ_ALL="df021288-bdef-4463-88db-98f22de89214"
ROLE_ONLINE_MEETINGS_READ_ALL="c1684f21-1984-47fa-9d61-2dc8c296bb70"
ROLE_TRANSCRIPT_READ_ALL="a4a80d8d-d283-4bd8-8504-555ec3870630"

FUNC_NAME=$(az functionapp list -g "$RG" --query "[?starts_with(name, 'func-taskbrain')].name | [0]" -o tsv)
if [[ -z "$FUNC_NAME" ]]; then
  echo "No Function App matching func-taskbrain* in $RG. Deploy infra first." >&2
  exit 1
fi

PRINCIPAL_ID=$(az functionapp identity show -g "$RG" -n "$FUNC_NAME" --query principalId -o tsv)
APP_ID=$(az ad sp show --id "$PRINCIPAL_ID" --query appId -o tsv)
GRAPH_SP=$(az ad sp list --filter "appId eq '$GRAPH_APP_ID'" --query "[0].id" -o tsv)

echo "Function:     $FUNC_NAME"
echo "Principal:    $PRINCIPAL_ID"
echo "App id:       $APP_ID"
echo "Graph SP:     $GRAPH_SP"
echo

assign_role() {
  local role_id="$1"
  local name="$2"
  existing=$(az rest --method GET \
    --uri "https://graph.microsoft.com/v1.0/servicePrincipals/${PRINCIPAL_ID}/appRoleAssignments" \
    --query "value[?appRoleId=='${role_id}'].id" -o tsv || true)
  if [[ -n "$existing" ]]; then
    echo "already assigned $name"
    return
  fi
  az rest --method POST \
    --uri "https://graph.microsoft.com/v1.0/servicePrincipals/${GRAPH_SP}/appRoleAssignedTo" \
    --headers "Content-Type=application/json" \
    --body "{\"principalId\":\"${PRINCIPAL_ID}\",\"resourceId\":\"${GRAPH_SP}\",\"appRoleId\":\"${role_id}\"}" \
    >/dev/null
  echo "assigned $name"
}

assign_role "$ROLE_USER_READ_ALL" "User.Read.All"
assign_role "$ROLE_ONLINE_MEETINGS_READ_ALL" "OnlineMeetings.Read.All"
assign_role "$ROLE_TRANSCRIPT_READ_ALL" "OnlineMeetingTranscript.Read.All"

cat <<EOF

Graph application roles are assigned. A Teams admin still needs to run
(MicrosoftTeams PowerShell 7.9.0+; EnableGraphTranscriptAccess is not on
older modules):

  Update-Module MicrosoftTeams -Force
  Import-Module MicrosoftTeams -Force
  Connect-MicrosoftTeams
  Get-Module MicrosoftTeams | Select-Object Version
  \$policy = Get-CsApplicationAccessPolicy -Identity TaskBrain-MeetingIngest -ErrorAction SilentlyContinue
  if (-not \$policy) {
    New-CsApplicationAccessPolicy -Identity TaskBrain-MeetingIngest -AppIds "$APP_ID" -Description "TaskBrain meeting ingest"
  }
  Grant-CsApplicationAccessPolicy -PolicyName TaskBrain-MeetingIngest -Global
  Set-CsTeamsMeetingConfiguration -Identity Global -EnableGraphTranscriptAccess \$true -EnableAttributedTranscripts \$true
  Get-CsTeamsMeetingConfiguration | Select-Object EnableGraphTranscriptAccess, EnableAttributedTranscripts

If the Set-Cs parameters are still missing after the update, use Teams
admin center instead: Meetings → Meeting settings → Transcript API access
→ Microsoft Graph access On, then Configure → Include speaker attribution On.

Transcription being enabled in a meeting is not enough: Graph transcript
export is off until EnableGraphTranscriptAccess is true. Policy can take ~30m.

The Function polls every 5 minutes. First run backfills incrementally via
each organizer's getAllTranscripts delta link. Raw VTT is not stored.
EOF
