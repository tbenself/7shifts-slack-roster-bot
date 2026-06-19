import test from "node:test";
import assert from "node:assert/strict";
import { readConfig, validateConfig } from "../src/config.js";

test("static 7shifts access token does not require OAuth client credentials", () => {
  const config = readConfig({
    SLACK_SIGNING_SECRET: "slack-secret",
    SLACK_BOT_TOKEN: "slack-bot-token",
    SEVENSHIFTS_ACCESS_TOKEN: "issued-token",
    SEVENSHIFTS_COMPANY_ID: "123",
  });

  assert.doesNotThrow(() => validateConfig(config));
  assert.equal(config.sevenShifts.accessToken, "issued-token");
});

test("SEVENSHIFTS_API_KEY alias is accepted", () => {
  const config = readConfig({
    SLACK_SIGNING_SECRET: "slack-secret",
    SLACK_BOT_TOKEN: "slack-bot-token",
    SEVENSHIFTS_API_KEY: "issued-token",
    SEVENSHIFTS_COMPANY_ID: "123",
  });

  assert.doesNotThrow(() => validateConfig(config));
  assert.equal(config.sevenShifts.accessToken, "issued-token");
});

test("OAuth fallback still requires client credentials and company guid", () => {
  const config = readConfig({
    SLACK_SIGNING_SECRET: "slack-secret",
    SLACK_BOT_TOKEN: "slack-bot-token",
    SEVENSHIFTS_COMPANY_ID: "123",
  });

  assert.throws(
    () => validateConfig(config),
    /SEVENSHIFTS_CLIENT_ID, SEVENSHIFTS_CLIENT_SECRET, SEVENSHIFTS_COMPANY_GUID/,
  );
});
