import test from "node:test";
import assert from "node:assert/strict";
import { handleSlackEvent, handleWorkerRequest, readWorkerConfig, verifySlackRequest } from "../src/worker.js";
import { recordUsage } from "../src/usage.js";

test("worker config accepts static 7shifts token", () => {
  const config = readWorkerConfig({
    SLACK_SIGNING_SECRET: "secret",
    SLACK_BOT_TOKEN: "slack-bot-token",
    SEVENSHIFTS_ACCESS_TOKEN: "7shifts-token",
    SEVENSHIFTS_COMPANY_ID: "123",
    SLACK_ALLOWED_TEAM_IDS: "T_ALLOWED",
  });

  assert.equal(config.sevenShifts.accessToken, "7shifts-token");
  assert.equal(config.slack.allowedTeamIds.has("T_ALLOWED"), true);
});

test("worker config accepts SEVENSHIFTS_API_KEY alias", () => {
  const config = readWorkerConfig({
    SLACK_SIGNING_SECRET: "secret",
    SLACK_BOT_TOKEN: "slack-bot-token",
    SEVENSHIFTS_API_KEY: "7shifts-token",
    SEVENSHIFTS_COMPANY_ID: "123",
  });

  assert.equal(config.sevenShifts.accessToken, "7shifts-token");
});

test("worker verifies Slack signature with Web Crypto", async () => {
  const body = JSON.stringify({ type: "event_callback" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signSlackBody("secret", timestamp, body);
  const headers = new Headers({
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  });

  assert.equal(await verifySlackRequest(headers, body, "secret"), true);
  assert.equal(await verifySlackRequest(headers, body, "wrong"), false);
});

test("worker rejects requests from disallowed Slack teams before waitUntil", async () => {
  const body = JSON.stringify({
    type: "event_callback",
    team_id: "T_OTHER",
    event_id: "Ev1",
    event: { type: "message", team: "T_OTHER", channel_type: "im", channel: "D1", text: "who's working" },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signSlackBody("secret", timestamp, body);
  const request = new Request("https://worker.example/slack/events", {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
  let waitUntilCalled = false;
  const response = await handleWorkerRequest(
    request,
    {
      SLACK_SIGNING_SECRET: "secret",
      SLACK_BOT_TOKEN: "slack-bot-token",
      SLACK_ALLOWED_TEAM_IDS: "T_ALLOWED",
      SEVENSHIFTS_ACCESS_TOKEN: "7shifts-token",
      SEVENSHIFTS_COMPANY_ID: "123",
    },
    { waitUntil() { waitUntilCalled = true; } },
  );

  assert.equal(response.status, 403);
  assert.equal(waitUntilCalled, false);
});

test("worker accepts Slack URL verification with only signing secret configured", async () => {
  const body = JSON.stringify({
    type: "url_verification",
      team_id: "T_ALLOWED",
    challenge: "challenge-value",
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signSlackBody("secret", timestamp, body);
  const request = new Request("https://worker.example/slack/events", {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });

  const response = await handleWorkerRequest(
    request,
    {
      SLACK_SIGNING_SECRET: "secret",
      SLACK_ALLOWED_TEAM_IDS: "T_ALLOWED",
    },
    { waitUntil() {} },
  );
  const challenge = await response.text();

  assert.equal(response.status, 200);
  assert.equal(challenge, "challenge-value");
});

test("worker acknowledges allowed Slack events immediately", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/locations")) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (String(url).includes("/users")) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (String(url).includes("/roles")) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (String(url).includes("/shifts")) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (String(url).includes("slack.com/api/chat.postMessage")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return originalFetch(url);
  };

  const body = JSON.stringify({
    type: "event_callback",
    team_id: "T_ALLOWED",
    event_id: "Ev2",
    event: { type: "message", team: "T_ALLOWED", channel_type: "im", channel: "D1", text: "who's working" },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signSlackBody("secret", timestamp, body);
  const request = new Request("https://worker.example/slack/events", {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
  let waitUntilCalled = false;
  let waitUntilPromise;
  try {
    const response = await handleWorkerRequest(
      request,
      {
        SLACK_SIGNING_SECRET: "secret",
        SLACK_BOT_TOKEN: "slack-bot-token",
        SLACK_ALLOWED_TEAM_IDS: "T_ALLOWED",
        SEVENSHIFTS_ACCESS_TOKEN: "7shifts-token",
        SEVENSHIFTS_COMPANY_ID: "123",
      },
      {
        waitUntil(promise) {
          waitUntilCalled = true;
          waitUntilPromise = promise;
        },
      },
    );
    await waitUntilPromise;

    assert.equal(response.status, 200);
    assert.equal(waitUntilCalled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker usage command replies from KV without calling 7shifts", async () => {
  const originalFetch = globalThis.fetch;
  const kv = new MemoryKv();
  await recordUsage(
    kv,
    { status: "matched", mode: "now", location: "downtown" },
    { now: new Date("2026-06-18T16:00:00-04:00") },
  );
  await recordUsage(
    kv,
    { status: "unmatched", unmatchedText: "nul" },
    { now: new Date("2026-06-18T16:00:00-04:00") },
  );

  const postedMessages = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("slack.com/api/chat.postMessage")) {
      postedMessages.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return originalFetch(url, init);
  };

  let calledSevenShifts = false;
  const sevenShiftsClient = {
    async listLocations() {
      calledSevenShifts = true;
      return [];
    },
  };

  try {
    await handleSlackEvent(
      {
        type: "message",
        team: "T_ALLOWED",
        user: "U1",
        channel_type: "im",
        channel: "D1",
        text: "usage",
      },
      {
        config: readWorkerConfig({
          SLACK_SIGNING_SECRET: "secret",
          SLACK_BOT_TOKEN: "slack-bot-token",
          SLACK_ALLOWED_TEAM_IDS: "T_ALLOWED",
          SEVENSHIFTS_ACCESS_TOKEN: "7shifts-token",
          SEVENSHIFTS_COMPANY_ID: "123",
        }),
        sevenShiftsClient,
        usageKv: kv,
      },
    );

    assert.equal(calledSevenShifts, false);
    assert.equal(postedMessages.length, 1);
    assert.match(postedMessages[0].text, /Usage for/);
    assert.match(postedMessages[0].text, /Locations requested: downtown 1/);
    assert.match(postedMessages[0].text, /Unmatched terms: nul 1/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker records unmatched requests in usage KV", async () => {
  const originalFetch = globalThis.fetch;
  const kv = new MemoryKv();
  const postedMessages = [];

  globalThis.fetch = async (url, init) => {
    if (String(url).includes("slack.com/api/chat.postMessage")) {
      postedMessages.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return originalFetch(url, init);
  };

  const sevenShiftsClient = {
    async listLocations() {
      return [];
    },
  };

  try {
    await handleSlackEvent(
      {
        type: "message",
        team: "T_ALLOWED",
        user: "U1",
        channel_type: "im",
        channel: "D1",
        text: "who's working at Mars",
      },
      {
        config: readWorkerConfig({
          SLACK_SIGNING_SECRET: "secret",
          SLACK_BOT_TOKEN: "slack-bot-token",
          SLACK_ALLOWED_TEAM_IDS: "T_ALLOWED",
          LOCATION_ALIASES_JSON: "{\"downtown\":\"Downtown Taproom\"}",
          SEVENSHIFTS_ACCESS_TOKEN: "7shifts-token",
          SEVENSHIFTS_COMPANY_ID: "123",
        }),
        sevenShiftsClient,
        usageKv: kv,
      },
    );

    const report = await kv.get([...kv.values.keys()][0]);

    assert.equal(postedMessages.length, 1);
    assert.match(report, /"mars":1/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function signSlackBody(secret, timestamp, body) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `v0=${hex}`;
}

class MemoryKv {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return this.values.get(key) || null;
  }

  async put(key, value) {
    this.values.set(key, value);
  }
}
