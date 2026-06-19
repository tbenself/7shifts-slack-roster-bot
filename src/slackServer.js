import crypto from "node:crypto";
import http from "node:http";
import { buildLocationMatcher, locationOptions, parseRosterIntent } from "./intent.js";
import {
  formatRosterAtTimeResponse,
  formatRosterResponse,
  formatScheduleResponse,
  formatUnknownLocation,
} from "./format.js";

const MAX_BODY_BYTES = 1024 * 1024;

export function createSlackServer({ config, sevenShiftsClient, logger = console }) {
  const seenEvents = new ExpiringSet(10 * 60 * 1000);

  return http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        return sendJson(response, 200, { ok: true });
      }

      if (request.method !== "POST" || request.url !== "/slack/events") {
        return sendJson(response, 404, { ok: false, error: "not_found" });
      }

      const rawBody = await readRawBody(request);
      if (!verifySlackRequest(request.headers, rawBody, config.slack.signingSecret)) {
        return sendJson(response, 401, { ok: false, error: "invalid_signature" });
      }

      const payload = JSON.parse(rawBody.toString("utf8"));
      if (!isAllowedSlackTeam(payload, config.slack.allowedTeamIds)) {
        return sendJson(response, 403, { ok: false, error: "workspace_not_allowed" });
      }

      if (payload.type === "url_verification") {
        return sendJson(response, 200, { challenge: payload.challenge });
      }

      sendJson(response, 200, { ok: true });

      if (payload.type !== "event_callback" || seenEvents.has(payload.event_id)) return;
      seenEvents.add(payload.event_id);
      handleSlackEvent(payload.event, { config, sevenShiftsClient, logger }).catch((error) => {
        logger.error("Failed to handle Slack event", safeError(error));
      });
    } catch (error) {
      logger.error("Slack request failed", safeError(error));
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: "server_error" });
    }
  });
}

export async function handleSlackEvent(event, { config, sevenShiftsClient, logger = console }) {
  if (!event || event.type !== "message") return;
  if (event.subtype || event.bot_id) return;
  if (event.team && !isAllowedTeamId(event.team, config.slack.allowedTeamIds)) return;

  const isDm = event.channel_type === "im";
  const allowedChannel = config.allowedChannelIds.has(event.channel);
  if (!isDm && !allowedChannel) return;

  let locations = [];
  try {
    locations = await sevenShiftsClient.listLocations();
  } catch (error) {
    logger.warn("Could not load 7shifts locations; falling back to configured aliases", safeError(error));
  }

  const matcher = buildLocationMatcher(locations, config.locationAliases);
  const intent = parseRosterIntent(event.text, matcher);
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

export function verifySlackRequest(headers, rawBody, signingSecret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!signingSecret) return false;
  const timestamp = headers["x-slack-request-timestamp"];
  const signature = headers["x-slack-signature"];
  if (!timestamp || !signature) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody.toString("utf8")}`;
  const expected = `v0=${crypto.createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  return timingSafeEqual(signature, expected);
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

function usageText(options) {
  const suffix = options.length ? `\n\nLocation options: ${options.join(", ")}` : "";
  return `You can DM just a location - no need to type "who's working".\n\nExamples: "downtown", "downtown noon", "downtown 2pm", "riverside tomorrow", "events today".\n\nAdd "today", "tomorrow", or "yesterday" for a full-day schedule. Add a time like "noon" or "2pm" to check who is working at that time today.${suffix}`;
}

function prettyLocationName(target, locations, fallback) {
  if (!target) return fallback;
  const match = locations.find((location) => String(location.id) === String(target));
  return match?.name || String(fallback || target);
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

function readRawBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
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
