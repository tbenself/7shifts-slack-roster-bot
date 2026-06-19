import { buildLocationMatcher, locationOptions, parseRosterIntent } from "./intent.js";
import {
  formatRosterAtTimeResponse,
  formatRosterResponse,
  formatScheduleResponse,
  formatUnknownLocation,
} from "./format.js";
import { SevenShiftsClient } from "./sevenShiftsClient.js";
import {
  formatUsageReport,
  isUsageAllowed,
  isUsageCommand,
  recordUsage,
  usageEntryFromIntent,
} from "./usage.js";

const encoder = new TextEncoder();
let sevenShiftsClient;

export default {
  async fetch(request, env, ctx) {
    return handleWorkerRequest(request, env, ctx);
  },
};

export async function handleWorkerRequest(request, env, ctx = { waitUntil: () => {} }) {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/healthz") {
    return jsonResponse({ ok: true });
  }

  if (request.method !== "POST" || url.pathname !== "/slack/events") {
    return jsonResponse({ ok: false, error: "not_found" }, 404);
  }

  const config = readWorkerConfig(env);
  if (!config.slack.signingSecret) {
    console.warn("Slack events request missing signing secret configuration");
    return jsonResponse({ ok: false, error: "missing_config", missing: ["SLACK_SIGNING_SECRET"] }, 500);
  }

  const rawBody = await request.text();
  const validSignature = await verifySlackRequest(request.headers, rawBody, config.slack.signingSecret);
  if (!validSignature) {
    console.warn("Slack events request failed signature verification", {
      hasTimestamp: Boolean(request.headers.get("x-slack-request-timestamp")),
      hasSignature: Boolean(request.headers.get("x-slack-signature")),
      bodyLength: rawBody.length,
    });
    return jsonResponse({ ok: false, error: "invalid_signature" }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.warn("Slack events request contained invalid JSON");
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  if (!isAllowedSlackTeam(payload, config.slack.allowedTeamIds)) {
    console.warn("Slack events request came from a disallowed workspace", {
      type: payload.type,
      hasTeamId: Boolean(payload.team_id || payload.event?.team),
    });
    return jsonResponse({ ok: false, error: "workspace_not_allowed" }, 403);
  }

  if (payload.type === "url_verification") {
    console.log("Slack URL verification challenge accepted");
    return textResponse(payload.challenge);
  }

  const missing = validateWorkerConfig(config);
  if (missing.length) {
    return jsonResponse({ ok: false, error: "missing_config", missing }, 500);
  }

  if (payload.type === "event_callback" && !seenEvents.has(payload.event_id)) {
    seenEvents.add(payload.event_id);
    ctx.waitUntil(handleSlackEvent(payload.event, {
      config,
      sevenShiftsClient: getSevenShiftsClient(config),
      usageKv: env.USAGE_KV,
    }));
  }

  return jsonResponse({ ok: true });
}

export async function handleSlackEvent(event, { config, sevenShiftsClient, usageKv }) {
  if (!event || event.type !== "message") return;
  if (event.subtype || event.bot_id) return;
  if (event.team && !isAllowedTeamId(event.team, config.slack.allowedTeamIds)) return;

  const isDm = event.channel_type === "im";
  const allowedChannel = config.allowedChannelIds.has(event.channel);
  if (!isDm && !allowedChannel) return;

  if (isUsageCommand(event.text)) {
    const text = isUsageAllowed(event.user, config.usage.allowedUserIds)
      ? await formatUsageReport(usageKv, { timeZone: config.timeZone })
      : "I can only show usage stats to approved users.";
    await postSlackMessage(config.slack.botToken, event.channel, text);
    return;
  }

  let locations = [];
  try {
    locations = await sevenShiftsClient.listLocations();
  } catch (error) {
    console.warn("Could not load 7shifts locations; falling back to configured aliases", safeError(error));
  }

  const matcher = buildLocationMatcher(locations, config.locationAliases);
  const intent = parseRosterIntent(event.text, matcher);
  await safelyRecordUsage(usageKv, usageEntryFromIntent(intent, event.text), config);
  if (!intent.recognized) {
    await postSlackMessage(config.slack.botToken, event.channel, usageText(locationOptions(matcher)));
    return;
  }

  if (intent.unknownLocation) {
    await postSlackMessage(
      config.slack.botToken,
      event.channel,
      formatUnknownLocation(intent.locationQuery, locationOptions(matcher)),
    );
    return;
  }

  const requestedLocation = intent.locationQuery ? prettyLocationName(intent.locationTarget, locations, intent.locationQuery) : "";
  const text = intent.requestedTime
    ? await rosterAtTimeResponseText({ sevenShiftsClient, intent, config, requestedLocation })
    : intent.scheduleDay
      ? await scheduleResponseText({ sevenShiftsClient, intent, config, requestedLocation })
      : formatRosterResponse(await sevenShiftsClient.getCurrentRoster({ locationTarget: intent.locationTarget }), {
      timeZone: config.timeZone,
      nameFormat: config.nameFormat,
      requestedLocation,
    });
  await postSlackMessage(config.slack.botToken, event.channel, text);
}

async function rosterAtTimeResponseText({ sevenShiftsClient, intent, config, requestedLocation }) {
  const { roster, at } = await sevenShiftsClient.getRosterAtTime({
    locationTarget: intent.locationTarget,
    requestedTime: intent.requestedTime,
    offsetDays: intent.scheduleDay?.offsetDays || 0,
    timeZone: config.timeZone,
  });
  return formatRosterAtTimeResponse(roster, {
    timeZone: config.timeZone,
    nameFormat: config.nameFormat,
    requestedLocation,
    requestedAt: at,
    scheduleLabel: intent.scheduleDay?.keyword || "today",
  });
}

async function scheduleResponseText({ sevenShiftsClient, intent, config, requestedLocation }) {
  const { roster, range } = await sevenShiftsClient.getScheduleRoster({
    locationTarget: intent.locationTarget,
    offsetDays: intent.scheduleDay.offsetDays,
    timeZone: config.timeZone,
  });
  return formatScheduleResponse(roster, {
    timeZone: config.timeZone,
    nameFormat: config.nameFormat,
    requestedLocation,
    scheduleLabel: intent.scheduleDay.keyword,
    scheduleDate: range.start,
  });
}

export async function verifySlackRequest(headers, rawBody, signingSecret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!signingSecret) return false;
  const timestamp = headers.get("x-slack-request-timestamp");
  const signature = headers.get("x-slack-signature");
  if (!timestamp || !signature) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > 60 * 5) return false;

  const expected = `v0=${await hmacSha256Hex(signingSecret, `v0:${timestamp}:${rawBody}`)}`;
  return timingSafeEqual(signature, expected);
}

export function readWorkerConfig(env = {}) {
  return {
    timeZone: env.TIME_ZONE || "America/New_York",
    nameFormat: env.NAME_FORMAT || "first_last_initial",
    locationAliases: parseJsonEnv(env.LOCATION_ALIASES_JSON, {}),
    allowedChannelIds: parseCsvSet(env.ALLOWED_CHANNEL_IDS),
    slack: {
      signingSecret: env.SLACK_SIGNING_SECRET || "",
      botToken: env.SLACK_BOT_TOKEN || "",
      allowedTeamIds: parseCsvSet(env.SLACK_ALLOWED_TEAM_IDS),
    },
    sevenShifts: {
      apiBaseUrl: env.SEVENSHIFTS_API_BASE_URL || "https://api.7shifts.com/v2",
      tokenUrl: env.SEVENSHIFTS_TOKEN_URL || "https://app.7shifts.com/oauth2/token",
      accessToken:
        env.SEVENSHIFTS_ACCESS_TOKEN ||
        env.SEVENSHIFTS_API_KEY ||
        "",
      clientId: env.SEVENSHIFTS_CLIENT_ID || "",
      clientSecret: env.SEVENSHIFTS_CLIENT_SECRET || "",
      companyId: env.SEVENSHIFTS_COMPANY_ID || "",
      companyGuid: env.SEVENSHIFTS_COMPANY_GUID || "",
      scopes: env.SEVENSHIFTS_SCOPES || "shifts:read users:read locations:read roles:read",
      apiVersion: env.SEVENSHIFTS_API_VERSION || "2025-03-01",
    },
    usage: {
      allowedUserIds: parseCsvSet(env.USAGE_ALLOWED_USER_IDS || env.USAGE_ADMIN_USER_IDS),
    },
  };
}

export function validateWorkerConfig(config) {
  const missing = [];
  if (!config.slack.signingSecret) missing.push("SLACK_SIGNING_SECRET");
  if (!config.slack.botToken) missing.push("SLACK_BOT_TOKEN");
  if (!config.sevenShifts.companyId) missing.push("SEVENSHIFTS_COMPANY_ID");
  if (!config.sevenShifts.accessToken) {
    if (!config.sevenShifts.clientId) missing.push("SEVENSHIFTS_CLIENT_ID");
    if (!config.sevenShifts.clientSecret) missing.push("SEVENSHIFTS_CLIENT_SECRET");
    if (!config.sevenShifts.companyGuid) missing.push("SEVENSHIFTS_COMPANY_GUID");
  }
  return missing;
}

function getSevenShiftsClient(config) {
  if (!sevenShiftsClient) {
    sevenShiftsClient = new SevenShiftsClient(config.sevenShifts);
  }
  return sevenShiftsClient;
}

async function postSlackMessage(botToken, channel, text) {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${botToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(`Slack chat.postMessage failed: ${payload.error || response.status}`);
  }
}

async function safelyRecordUsage(usageKv, entry, config) {
  try {
    await recordUsage(usageKv, entry, { timeZone: config.timeZone });
  } catch (error) {
    console.warn("Could not record usage stats", safeError(error));
  }
}

async function hmacSha256Hex(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    diff |= left.charCodeAt(index % left.length) ^ right.charCodeAt(index % right.length);
  }
  return diff === 0;
}

function isAllowedSlackTeam(payload, allowedTeamIds) {
  if (!allowedTeamIds?.size) return true;
  const teamId = payload.team_id || payload.event?.team;
  if (!teamId && payload.type === "url_verification") return true;
  return isAllowedTeamId(teamId, allowedTeamIds);
}

function isAllowedTeamId(teamId, allowedTeamIds) {
  if (!allowedTeamIds?.size) return true;
  return Boolean(teamId && allowedTeamIds.has(teamId));
}

function usageText(options) {
  const suffix = options.length ? `\n\nLocation options: ${options.join(", ")}` : "";
  return `You can DM just a location - no need to type "who's working".\n\nExamples: "downtown", "downtown noon", "downtown 2pm", "riverside tomorrow", "events today".\n\nAdd "today", "tomorrow", or "yesterday" for a full-day schedule. Add a time like "noon" or "2pm" to check who is working at that time today.${suffix}`;
}

function prettyLocationName(target, locations, fallback) {
  if (!target) return fallback;
  const match = locations.find((location) => String(location.id) === String(target));
  return match?.name || String(fallback || target);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body, status = 200) {
  return new Response(String(body || ""), {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function parseCsvSet(raw) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function parseJsonEnv(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid LOCATION_ALIASES_JSON: ${error.message}`);
  }
}

function safeError(error) {
  return { message: error?.message || String(error) };
}

class ExpiringSet {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.values = new Map();
  }

  has(value) {
    this.sweep();
    return this.values.has(value);
  }

  add(value) {
    this.sweep();
    this.values.set(value, Date.now() + this.ttlMs);
  }

  sweep() {
    const now = Date.now();
    for (const [value, expiresAt] of this.values.entries()) {
      if (expiresAt <= now) this.values.delete(value);
    }
  }
}

const seenEvents = new ExpiringSet(10 * 60 * 1000);
