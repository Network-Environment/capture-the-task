import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  type ConfigurationBotFrameworkAuthenticationOptions,
} from "botbuilder";

export function createBotAdapter(): CloudAdapter {
  const auth = new ConfigurationBotFrameworkAuthentication(
    process.env as ConfigurationBotFrameworkAuthenticationOptions
  );
  const adapter = new CloudAdapter(auth);
  adapter.onTurnError = async (context, error) => {
    console.error("[onTurnError]", error);
    await context.sendActivity(
      "Something broke on my end — that capture was not saved. Try again in a moment."
    );
  };
  return adapter;
}
