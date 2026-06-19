import test from "node:test";
import assert from "node:assert/strict";
import { handleSlackEvent } from "../src/slackServer.js";

test("disallowed Slack team does not trigger 7shifts lookup", async () => {
  let called = false;
  const sevenShiftsClient = {
    async listLocations() {
      called = true;
      throw new Error("should not be called");
    },
  };

  await handleSlackEvent(
    {
      type: "message",
      team: "T_OTHER",
      channel_type: "im",
      channel: "D123",
      text: "who's working",
    },
    {
      config: {
        slack: { botToken: "slack-bot-token", allowedTeamIds: new Set(["T_ALLOWED"]) },
        allowedChannelIds: new Set(),
        locationAliases: {},
        timeZone: "America/New_York",
        nameFormat: "first_last_initial",
      },
      sevenShiftsClient,
      logger: { warn() {}, error() {} },
    },
  );

  assert.equal(called, false);
});
