import fs from "node:fs";
import path from "node:path";

export function loadDotEnv(filePath = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquote(rawValue.trim());
  }
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function readConfig(env = process.env) {
  const locationAliases = parseJsonEnv(env.LOCATION_ALIASES_JSON, {});
  const allowedChannelIds = new Set(
    (env.ALLOWED_CHANNEL_IDS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const allowedTeamIds = new Set(
    (env.SLACK_ALLOWED_TEAM_IDS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );

  return {
    port: Number(env.PORT || 3000),
    timeZone: env.TIME_ZONE || "America/New_York",
    nameFormat: env.NAME_FORMAT || "first_last_initial",
    locationAliases,
    allowedChannelIds,
    slack: {
      signingSecret: env.SLACK_SIGNING_SECRET || "",
      botToken: env.SLACK_BOT_TOKEN || "",
      allowedTeamIds,
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
      scopes:
        env.SEVENSHIFTS_SCOPES ||
        "shifts:read users:read locations:read roles:read",
      apiVersion: env.SEVENSHIFTS_API_VERSION || "2025-03-01",
    },
  };
}

export function validateConfig(config) {
  const missing = [];
  if (!config.slack.signingSecret) missing.push("SLACK_SIGNING_SECRET");
  if (!config.slack.botToken) missing.push("SLACK_BOT_TOKEN");
  if (!config.sevenShifts.companyId) missing.push("SEVENSHIFTS_COMPANY_ID");
  if (!config.sevenShifts.accessToken) {
    if (!config.sevenShifts.clientId) missing.push("SEVENSHIFTS_CLIENT_ID");
    if (!config.sevenShifts.clientSecret) missing.push("SEVENSHIFTS_CLIENT_SECRET");
    if (!config.sevenShifts.companyGuid) missing.push("SEVENSHIFTS_COMPANY_GUID");
  }
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

function parseJsonEnv(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid LOCATION_ALIASES_JSON: ${error.message}`);
  }
}
