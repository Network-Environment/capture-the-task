// TaskBrain infrastructure — resource-group scope
// az group create -n rg-taskbrain -l eastus
// az deployment group create -g rg-taskbrain -f infra/main.bicep -p appName=taskbrain botAppId=<entra-app-id>

@description('Base name for all resources')
param appName string = 'taskbrain'

@description('Entra app registration (client) ID for the bot')
param botAppId string

@description('Location')
param location string = resourceGroup().location

// ---- Runtime inputs supplied by the pipeline (GitHub secrets). Optional ones may be empty. ----
@secure()
@description('Bot app registration client secret (from bootstrap.sh)')
param botAppPassword string

@secure()
@description('Key protecting the /admin dashboard')
param adminKey string

@description('Entra object id that receives admin alerts')
param adminAadObjectId string = ''

@secure()
@description('Smartsheet API token for mcp.smartsheet.com (optional)')
param smartsheetApiToken string = ''

@description('Photon project id for iMessage (optional; empty disables the channel)')
param spectrumProjectId string = ''

@secure()
@description('Photon project secret (optional)')
param spectrumProjectSecret string = ''

@description('Daily token budget before cheap-tier downgrade')
param dailyTokenBudget string = '5000000'

@description('Cron timezone for scheduled jobs')
param jobsTimezone string = 'America/Chicago'

@description('Region for the App Service plan and web app only. Kept separate from `location` because App Service SKU quota is granted per region: this subscription has 0 quota for every Basic/Free SKU in eastus, but centralus and westus2 allow any SKU. Move back to `location` once an eastus B1 quota request is approved.')
param appLocation string = location

@description('App Service plan SKU. F1 (Free) forces alwaysOn off, which stops the 60s job poller and the Photon stream from staying warm.')
@allowed(['F1', 'B1', 'B2', 'S1', 'P0v4', 'P1v4'])
param planSku string = 'B1'

var planAlwaysOn = planSku != 'F1'

@description('Immutable container tag deployed to App Service. CI passes the Git commit SHA.')
param containerImageTag string = 'bootstrap'

// ---- Model deployments created in Foundry. Verify names/versions in your region's model catalog. ----
// New Pay-As-You-Go subscriptions often have 0 TPM for full gpt-5 / gpt-4.1 / gpt-4o.
// Defaults here are the mini-class models that actually have quota so a first deploy
// can complete. Swap standardModelName back to gpt-5 once GlobalStandard quota is granted.
param cheapModelName string = 'gpt-4.1-mini'
param cheapModelVersion string = '2025-04-14'
param standardModelName string = 'gpt-5-mini'
param standardModelVersion string = '2025-08-07'
param embedModelName string = 'text-embedding-3-small'
param embedModelVersion string = '1'

var suffix = uniqueString(resourceGroup().id)

// ---------- Container registry ----------
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'acr${appName}${suffix}'
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

// ---------- Storage: markdown notes (the portable brain) ----------
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'st${appName}${suffix}'
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

resource notesContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  name: '${storage.name}/default/notes'
  properties: { publicAccess: 'None' }
}

// ---------- Cosmos DB serverless: metadata, embeddings, session ----------
resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: 'cos-${appName}-${suffix}'
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    capabilities: [
      { name: 'EnableServerless' }
      { name: 'EnableNoSQLVectorSearch' }
    ]
    locations: [ { locationName: location, failoverPriority: 0 } ]
  }
}

resource cosmosDb 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = {
  parent: cosmos
  name: 'taskbrain'
  properties: { resource: { id: 'taskbrain' } }
}

resource notesColl 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: cosmosDb
  name: 'notes'
  properties: {
    resource: {
      id: 'notes'
      partitionKey: { paths: ['/userId'], kind: 'Hash' }
      vectorEmbeddingPolicy: {
        vectorEmbeddings: [
          {
            path: '/embedding'
            dataType: 'float32'
            distanceFunction: 'cosine'
            dimensions: 1536
          }
        ]
      }
      // Cosmos rejects a custom policy that leaves the root path uncovered:
      // "The special mandatory indexing path / is not provided in any of the
      // path type sets." Index everything except the raw vector, which is
      // served by the diskANN index rather than the normal inverted index.
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [ { path: '/*' } ]
        excludedPaths: [ { path: '/embedding/*' }, { path: '/"_etag"/?' } ]
        vectorIndexes: [ { path: '/embedding', type: 'diskANN' } ]
      }
    }
  }
}

resource sessionColl 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: cosmosDb
  name: 'sessions'
  properties: {
    resource: {
      id: 'sessions'
      partitionKey: { paths: ['/userId'], kind: 'Hash' }
      defaultTtl: 900 // 15-minute follow-up window, then gone
    }
  }
}

resource jobsColl 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: cosmosDb
  name: 'jobs'
  properties: {
    resource: {
      id: 'jobs'
      partitionKey: { paths: ['/userId'], kind: 'Hash' }
    }
  }
}


resource activityColl 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: cosmosDb
  name: 'activity'
  properties: {
    resource: {
      id: 'activity'
      partitionKey: { paths: ['/day'], kind: 'Hash' }
      defaultTtl: 2592000 // 30-day retention on raw events
    }
  }
}

resource agentMemoryColl 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: cosmosDb
  name: 'agent-memory'
  properties: {
    resource: {
      id: 'agent-memory'
      partitionKey: { paths: ['/userId'], kind: 'Hash' }
    }
  }
}


resource conversationsColl 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: cosmosDb
  name: 'conversations'
  properties: {
    resource: {
      id: 'conversations'
      partitionKey: { paths: ['/userId'], kind: 'Hash' }
    }
  }
}

resource pendingColl 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: cosmosDb
  name: 'pending'
  properties: {
    resource: {
      id: 'pending'
      partitionKey: { paths: ['/userId'], kind: 'Hash' }
      defaultTtl: 3600 // unapproved write actions expire after an hour
    }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${appName}-${suffix}'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    RetentionInDays: 30
  }
}

// ---------- Azure AI Speech ----------
resource speech 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'spch-${appName}-${suffix}'
  location: location
  kind: 'SpeechServices'
  sku: { name: 'S0' }
  properties: { publicNetworkAccess: 'Enabled' }
}

// ---------- Azure AI Foundry (AIServices) — deploy chat + embedding models here ----------
resource foundry 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'aif-${appName}-${suffix}'
  location: location
  kind: 'AIServices'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: 'aif-${appName}-${suffix}'
    publicNetworkAccess: 'Enabled'
  }
}

// Deployments are created serially (dependsOn) — parallel creation on one account is rejected.
resource depCheap 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: foundry
  name: 'cheap'
  sku: { name: 'GlobalStandard', capacity: 50 }
  properties: {
    model: { format: 'OpenAI', name: cheapModelName, version: cheapModelVersion }
  }
}

resource depStandard 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: foundry
  name: 'standard'
  sku: { name: 'GlobalStandard', capacity: 50 }
  properties: {
    model: { format: 'OpenAI', name: standardModelName, version: standardModelVersion }
  }
  dependsOn: [ depCheap ]
}

resource depEmbed 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: foundry
  name: 'embed'
  sku: { name: 'GlobalStandard', capacity: 50 }
  properties: {
    model: { format: 'OpenAI', name: embedModelName, version: embedModelVersion }
  }
  dependsOn: [ depStandard ]
}

// ---------- App Service ----------
resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: 'plan-${appName}'
  location: appLocation
  sku: { name: planSku }
  properties: { reserved: true } // linux
}

resource app 'Microsoft.Web/sites@2024-04-01' = {
  name: 'app-${appName}-${suffix}'
  location: appLocation
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'DOCKER|${registry.properties.loginServer}/taskbrain:${containerImageTag}'
      acrUseManagedIdentityCreds: true
      alwaysOn: planAlwaysOn
      appSettings: [
        // --- Bot identity ---
        { name: 'MicrosoftAppType', value: 'SingleTenant' }
        { name: 'MicrosoftAppId', value: botAppId }
        { name: 'MicrosoftAppPassword', value: botAppPassword }
        { name: 'MicrosoftAppTenantId', value: tenant().tenantId }
        // --- Foundry (OpenAI-compatible) + model tiers ---
        { name: 'FOUNDRY_ENDPOINT', value: 'https://${foundry.properties.customSubDomainName}.openai.azure.com' }
        { name: 'FOUNDRY_API_KEY', value: foundry.listKeys().key1 }
        { name: 'CHEAP_DEPLOYMENT', value: depCheap.name }
        { name: 'STANDARD_DEPLOYMENT', value: depStandard.name }
        { name: 'PREMIUM_DEPLOYMENT', value: depStandard.name } // point at an Opus/large deployment later
        { name: 'EMBED_DEPLOYMENT', value: depEmbed.name }
        // --- Speech ---
        { name: 'SPEECH_REGION', value: location }
        { name: 'SPEECH_KEY', value: speech.listKeys().key1 }
        // --- Second brain ---
        { name: 'STORAGE_CONNECTION_STRING', value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}' }
        { name: 'NOTES_CONTAINER', value: 'notes' }
        { name: 'COSMOS_ENDPOINT', value: cosmos.properties.documentEndpoint }
        { name: 'COSMOS_KEY', value: cosmos.listKeys().primaryMasterKey }
        { name: 'COSMOS_DB', value: cosmosDb.name }
        // --- Integrations / channels ---
        { name: 'GRAPH_CONNECTION_NAME', value: 'graph-connection' }
        { name: 'SMARTSHEET_API_TOKEN', value: smartsheetApiToken }
        { name: 'SPECTRUM_PROJECT_ID', value: spectrumProjectId }
        { name: 'SPECTRUM_PROJECT_SECRET', value: spectrumProjectSecret }
        // --- Ops ---
        { name: 'ADMIN_KEY', value: adminKey }
        { name: 'ADMIN_AAD_OBJECT_ID', value: adminAadObjectId }
        { name: 'DAILY_TOKEN_BUDGET', value: dailyTokenBudget }
        { name: 'JOBS_TIMEZONE', value: jobsTimezone }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        { name: 'WEBSITES_PORT', value: '3978' }
      ]
    }
  }
  identity: { type: 'SystemAssigned' }
}

// App Service pulls from ACR without registry credentials or stored secrets.
var acrPullRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
resource appAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, app.id, acrPullRoleId)
  scope: registry
  properties: {
    roleDefinitionId: acrPullRoleId
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------- Bot Service ----------
resource bot 'Microsoft.BotService/botServices@2023-09-15-preview' = {
  name: 'bot-${appName}-${suffix}'
  location: 'global'
  sku: { name: 'S1' }
  kind: 'azurebot'
  properties: {
    displayName: 'TaskBrain'
    endpoint: 'https://${app.properties.defaultHostName}/api/messages'
    msaAppId: botAppId
    msaAppType: 'SingleTenant'
    msaAppTenantId: tenant().tenantId
  }
}

resource teamsChannel 'Microsoft.BotService/botServices/channels@2023-09-15-preview' = {
  parent: bot
  name: 'MsTeamsChannel'
  location: 'global'
  properties: {
    channelName: 'MsTeamsChannel'
    properties: { isEnabled: true }
  }
}

// Graph OAuth for Microsoft To Do. serviceProviderId is the portal's
// "Azure Active Directory v2" provider — not documented in the ARM schema.
resource graphConnection 'Microsoft.BotService/botServices/connections@2023-09-15-preview' = {
  parent: bot
  name: 'graph-connection'
  location: 'global'
  properties: {
    serviceProviderDisplayName: 'Azure Active Directory v2'
    serviceProviderId: '30dd229c-58e3-4a48-bdfd-91ec48eb906c'
    clientId: botAppId
    clientSecret: botAppPassword
    scopes: 'Tasks.ReadWrite'
    parameters: [
      { key: 'tenantId', value: tenant().tenantId }
      { key: 'tokenExchangeUrl', value: ' ' }
    ]
  }
}

output appHostname string = app.properties.defaultHostName
output appName string = app.name
output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
output storageAccount string = storage.name
output cosmosAccount string = cosmos.name
output speechEndpoint string = speech.properties.endpoint
output foundryEndpoint string = foundry.properties.endpoint
