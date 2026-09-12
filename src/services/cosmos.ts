import { CosmosClient, type Container } from "@azure/cosmos";

let client: CosmosClient | undefined;

export function cosmosConfigured(): boolean {
  return Boolean(process.env.COSMOS_ENDPOINT && process.env.COSMOS_KEY);
}

export function getCosmosClient(): CosmosClient {
  if (!client) {
    const endpoint = process.env.COSMOS_ENDPOINT;
    const key = process.env.COSMOS_KEY;
    if (!endpoint || !key) {
      throw new Error("COSMOS_ENDPOINT and COSMOS_KEY are required");
    }
    client = new CosmosClient({ endpoint, key });
  }
  return client;
}

export function cosmosContainer(name: string): Container {
  return getCosmosClient()
    .database(process.env.COSMOS_DB ?? "taskbrain")
    .container(name);
}
