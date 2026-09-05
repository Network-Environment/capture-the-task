// Test env stubs. Imported FIRST by every test so modules that construct
// Azure clients at import time don't throw. Nothing here is ever called.
process.env.COSMOS_ENDPOINT ??= "https://localhost:443/";
process.env.COSMOS_KEY ??= "dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleQ==";
process.env.FOUNDRY_ENDPOINT ??= "https://localhost/";
process.env.FOUNDRY_API_KEY ??= "x";
process.env.STORAGE_CONNECTION_STRING ??= "UseDevelopmentStorage=true";
process.env.CONFIG_DIR ??= new URL("../config", `file://${__dirname}/`).pathname;
