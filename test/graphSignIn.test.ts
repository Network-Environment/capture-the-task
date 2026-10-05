import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TokenResponse } from "botframework-schema";
import { exchangeGraphSignIn, graphOAuthAttachment } from "../src/services/graphTasks";

describe("Microsoft 365 sign-in", () => {
  it("builds one OAuth card against the Graph connection", () => {
    const card = graphOAuthAttachment("graph-connection", {
      signInLink: "https://example.test/signin",
      tokenExchangeResource: { id: "exchange", uri: "api://taskbrain" },
    });
    assert.equal(card?.contentType, "application/vnd.microsoft.card.oauth");
    const content = card?.content as {
      connectionName?: string;
      text?: string;
      buttons?: { type?: string; title?: string; value?: string }[];
      tokenExchangeResource?: { uri?: string };
    };
    assert.equal(content.connectionName, "graph-connection");
    assert.match(content.text ?? "", /Sign in once/);
    assert.equal(content.buttons?.[0]?.type, "signin");
    assert.equal(content.buttons?.[0]?.value, "https://example.test/signin");
    assert.equal(content.tokenExchangeResource?.uri, "api://taskbrain");
    assert.equal(graphOAuthAttachment("graph-connection", {}), undefined);
  });

  it("exchanges the Teams token and then retries the stored delegated token", async () => {
    const calls: string[] = [];
    const token = await exchangeGraphSignIn(
      {
        async exchangeToken() {
          calls.push("exchange");
          return { token: "exchanged" } as TokenResponse;
        },
        async getUserToken() {
          calls.push("retry");
          return { token: "stored" } as TokenResponse;
        },
      },
      {
        userId: "user",
        channelId: "msteams",
        connectionName: "graph-connection",
        activityName: "signin/tokenExchange",
        exchangeToken: "raw-sso-token",
      }
    );
    assert.deepEqual(calls, ["exchange", "retry"]);
    assert.equal(token, "stored");
  });

  it("retries getUserToken with the magic code from verifyState", async () => {
    let magic = "";
    const token = await exchangeGraphSignIn(
      {
        async exchangeToken() {
          throw new Error("exchange should not run");
        },
        async getUserToken(_userId, _connection, _channelId, magicCode) {
          magic = magicCode;
          return { token: "from-magic" } as TokenResponse;
        },
      },
      {
        userId: "user",
        channelId: "msteams",
        connectionName: "graph-connection",
        activityName: "signin/verifyState",
        magicCode: "123456",
      }
    );
    assert.equal(magic, "123456");
    assert.equal(token, "from-magic");
  });
});
