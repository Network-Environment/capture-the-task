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

// ---- Model deployments created in Foundry. Verify names/versions in your region's model catalog. ----
// Claude models must be deployed via the Foundry portal today; set CHAT deployments to their names afterward.
param cheapModelName string = 'gpt-5-mini'
param cheapModelVersion string = '2025-08-07'
param standardModelName string = 'gpt-5'
param standardModelVersion string = '2025-08-07'
param embedModelName string = 'text-embedding-3-small'
param embedModelVersion string = '1'

var suffix = uniqueString(resourceGroup().id)

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
      indexingPolicy: {
        vectorIndexes: [ { path: '/embedding', type: 'diskANN' } ]
        excludedPaths: [ { path: '/embedding/*' } ]
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
  location: location
  sku: { name: 'B1' }
  properties: { reserved: true } // linux
}

resource app 'Microsoft.Web/sites@2024-04-01' = {
  name: 'app-${appName}-${suffix}'
  location: location
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      alwaysOn: true
      appCommandLine: 'node dist/index.js'
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
        { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
      ]
    }
  }
  identity: { type: 'SystemAssigned' }
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

output appHostname string = app.properties.defaultHostName
output storageAccount string = storage.name
output cosmosAccount string = cosmos.name
output speechEndpoint string = speech.properties.endpoint
output foundryEndpoint string = foundry.properties.endpoint
