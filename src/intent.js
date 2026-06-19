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
    .replace(/[^a-z0-9\s&-]/g, " ")
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

  const directLocationText = stripIntentWords(normalized);
  const directLocation = resolveLocation(directLocationText, locationAliases);
  if (directLocation.matched) {
    return {
      recognized: true,
      locationQuery: directLocation.query,
      locationTarget: directLocation.target,
      scheduleDay,
    };
  }

  const whoPattern = WHO_WORKING_PATTERNS.find((pattern) => pattern.test(normalized));
  if (!whoPattern) return { recognized: false };

  const locationText = normalized
    .replace(whoPattern, " ")
    .split(/\s+/)
    .filter((word) => !FILLER_WORDS.has(word) && !SCHEDULE_DAYS.has(word))
    .join(" ")
    .trim();

  if (!locationText) {
    return { recognized: true, scheduleDay };
  }

  const resolved = resolveLocation(locationText, locationAliases);
  return {
    recognized: true,
    locationQuery: locationText,
    locationTarget: resolved.matched ? resolved.target : undefined,
    scheduleDay,
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
