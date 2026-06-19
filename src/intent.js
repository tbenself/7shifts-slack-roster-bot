const WHO_WORKING_PATTERNS = [
  /\bwho'?s\s+working\b/i,
  /\bwho\s+s\s+working\b/i,
  /\bwho\s+is\s+working\b/i,
  /\bwhos\s+working\b/i,
  /\bwho'?s\s+on\b/i,
  /\bwho\s+s\s+on\b/i,
  /\bwho\s+is\s+on\b/i,
];

const FILLER_WORDS = new Set([
  "at",
  "in",
  "for",
  "right",
  "now",
  "today",
  "currently",
  "please",
  "pls",
  "the",
]);

const SCHEDULE_DAYS = new Map([
  ["yesterday", -1],
  ["today", 0],
  ["tomorrow", 1],
]);

export function normalizeText(text) {
  return String(text || "")
    .replace(/<@[^>]+>/g, " ")
    .replace(/[’]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9\s&:-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildLocationMatcher(locations = [], configuredAliases = {}) {
  const aliases = new Map();

  for (const [alias, target] of Object.entries(configuredAliases || {})) {
    const key = normalizeLocationKey(alias);
    if (key) aliases.set(key, target);
  }

  for (const location of locations || []) {
    if (!location) continue;
    const name = location.name || location.location_name;
    if (!name) continue;
    aliases.set(normalizeLocationKey(name), location.id);
  }

  return aliases;
}

export function parseRosterIntent(text, locationAliases = new Map()) {
  const normalized = normalizeText(text);
  if (!normalized) return { recognized: false };
  const scheduleDay = extractScheduleDay(normalized);
  const requestedTime = extractRequestedTime(normalized);

  const directLocationText = stripIntentWords(stripRequestedTime(normalized));
  const directLocation = resolveLocation(directLocationText, locationAliases);
  if (directLocation.matched) {
    return {
      recognized: true,
      locationQuery: directLocation.query,
      locationTarget: directLocation.target,
      scheduleDay,
      requestedTime,
    };
  }

  const whoPattern = WHO_WORKING_PATTERNS.find((pattern) => pattern.test(normalized));
  if (!whoPattern) return { recognized: false };

  const locationText = stripRequestedTime(normalized)
    .replace(whoPattern, " ")
    .split(/\s+/)
    .filter((word) => !FILLER_WORDS.has(word) && !SCHEDULE_DAYS.has(word))
    .join(" ")
    .trim();

  if (!locationText) {
    return { recognized: true, scheduleDay, requestedTime };
  }

  const resolved = resolveLocation(locationText, locationAliases);
  return {
    recognized: true,
    locationQuery: locationText,
    locationTarget: resolved.matched ? resolved.target : undefined,
    scheduleDay,
    requestedTime,
    unknownLocation: !resolved.matched,
  };
}

export function locationOptions(locationAliases = new Map()) {
  return Array.from(locationAliases.keys()).sort();
}

function resolveLocation(text, aliases) {
  const key = normalizeLocationKey(text);
  if (!key) return { matched: false };
  if (aliases.has(key)) return { matched: true, query: key, target: aliases.get(key) };

  for (const [alias, target] of aliases.entries()) {
    if (key.includes(alias) || alias.includes(key)) {
      return { matched: true, query: key, target };
    }
  }
  return { matched: false };
}

function extractScheduleDay(text) {
  for (const word of text.split(/\s+/)) {
    if (SCHEDULE_DAYS.has(word)) {
      return { keyword: word, offsetDays: SCHEDULE_DAYS.get(word) };
    }
  }
  return null;
}

function extractRequestedTime(text) {
  const normalized = normalizeText(text);
  if (/\bnoon\b/.test(normalized)) return { hour: 12, minute: 0, label: "noon" };
  if (/\bmidnight\b/.test(normalized)) return { hour: 0, minute: 0, label: "midnight" };

  const clockMatch = normalized.match(/\b([01]?\d|2[0-3]):([0-5]\d)\s*(am|pm|a|p)?\b/);
  if (clockMatch) {
    return normalizeTimeParts(Number(clockMatch[1]), Number(clockMatch[2]), clockMatch[3]);
  }

  const meridiemMatch = normalized.match(/\b(1[0-2]|0?[1-9])\s*(am|pm|a|p)\b/);
  if (meridiemMatch) {
    return normalizeTimeParts(Number(meridiemMatch[1]), 0, meridiemMatch[2]);
  }

  return null;
}

function normalizeTimeParts(hour, minute, meridiem) {
  const normalizedMeridiem = meridiem ? meridiem[0].toLowerCase() : "";
  let normalizedHour = hour;
  if (normalizedMeridiem === "p" && hour < 12) normalizedHour += 12;
  if (normalizedMeridiem === "a" && hour === 12) normalizedHour = 0;
  if (normalizedHour > 23 || minute > 59) return null;

  return {
    hour: normalizedHour,
    minute,
    label: formatTimeLabel(normalizedHour, minute),
  };
}

function formatTimeLabel(hour, minute) {
  if (hour === 0 && minute === 0) return "midnight";
  if (hour === 12 && minute === 0) return "noon";
  const meridiem = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${meridiem}`;
}

function stripRequestedTime(text) {
  return normalizeText(text)
    .replace(/\b(noon|midnight)\b/g, " ")
    .replace(/\b([01]?\d|2[0-3]):([0-5]\d)\s*(am|pm|a|p)?\b/g, " ")
    .replace(/\b(1[0-2]|0?[1-9])\s*(am|pm|a|p)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripIntentWords(text) {
  return text
    .split(/\s+/)
    .filter((word) => !FILLER_WORDS.has(word) && !SCHEDULE_DAYS.has(word))
    .join(" ")
    .trim();
}

function normalizeLocationKey(value) {
  return normalizeText(value)
    .replace(/\bhaus\b/g, "haus")
    .replace(/\s+/g, " ")
    .trim();
}
