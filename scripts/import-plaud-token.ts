import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

const [accountId, vaultUrl] = process.argv.slice(2);
if (!accountId || !vaultUrl) {
  throw new Error(
    "Usage: npm run plaud:import-token -- <account-id> <key-vault-url>"
  );
}
if (!/^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/?$/i.test(vaultUrl)) {
  throw new Error("Key Vault URL must look like https://name.vault.azure.net");
}

const tokenPath = join(homedir(), ".plaud", "tokens.json");
const local = JSON.parse(await readFile(tokenPath, "utf8")) as {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_at?: number;
};
if (!local.refresh_token) {
  throw new Error(
    `${tokenPath} has no refresh token. Run "plaud login" first.`
  );
}

const secretName = "plaud-oauth-tokens";
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
let tokens: Record<string, typeof local> = {};
try {
  const current = await client.getSecret(secretName);
  if (current.value) tokens = JSON.parse(current.value);
} catch (error) {
  const status = (error as { statusCode?: number }).statusCode;
  if (status !== 404) throw error;
}
tokens[accountId] = local;
await client.setSecret(secretName, JSON.stringify(tokens));
console.log(
  `Imported Plaud OAuth tokens for "${accountId}" into ${vaultUrl}.`
);
