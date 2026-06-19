import { normalizeText } from "./intent.js";

const MAX_UNMATCHED_TERM_LENGTH = 80;
const MAX_TOP_ITEMS = 8;

export function isUsageCommand(text) {
  const normalized = normalizeText(text);
  return normalized === "usage" || normalized === "stats";
}

export function isUsageAllowed(userId, allowedUserIds = new Set()) {
  if (!allowedUserIds?.size) return true;
  return Boolean(userId && allowedUserIds.has(userId));
}

export async function recordUsage(kv, entry, options = {}) {
  if (!kv) return null;
  const timeZone = options.timeZone || "America/New_York";
  const now = options.now || new Date();
  const week = isoWeekKey(now, timeZone);
  const key = usageKey(week);
  const stats = await readWeekStats(kv, week);

  stats.total += 1;
  stats.updatedAt = now.toISOString();

  if (entry.status === "matched") {
    stats.matched += 1;
    increment(stats.byMode, entry.mode || "now");
    increment(stats.byLocation, entry.location || "all");
  } else {
    stats.unmatched += 1;
    const term = normalizeUnmatchedTerm(entry.unmatchedText);
    if (term) increment(stats.unmatchedTerms, term);
  }

  await kv.put(key, JSON.stringify(stats));
  return stats;
}

export async function formatUsageReport(kv, options = {}) {
  if (!kv) {
    return "Usage tracking is not configured yet.";
  }

  const timeZone = options.timeZone || "America/New_York";
  const now = options.now || new Date();
  const currentWeek = isoWeekKey(now, timeZone);
  const previousWeek = previousIsoWeekKey(currentWeek);
  const [current, previous] = await Promise.all([
    readWeekStats(kv, currentWeek),
    readWeekStats(kv, previousWeek),
  ]);

  return [
    `Usage for ${currentWeek}`,
    `Matched requests: ${current.matched}`,
    `Unmatched requests: ${current.unmatched}`,
    `Requests by mode: ${formatCounts(current.byMode)}`,
    `Locations requested: ${formatCounts(current.byLocation)}`,
    `Unmatched terms: ${formatCounts(current.unmatchedTerms)}`,
    "",
    `Previous week (${previousWeek}): ${previous.matched} matched, ${previous.unmatched} unmatched`,
  ].join("\n");
}

export async function readWeekStats(kv, week) {
  const raw = await kv.get(usageKey(week));
  if (!raw) return emptyWeekStats(week);
  try {
    return normalizeWeekStats(JSON.parse(raw), week);
  } catch {
    return emptyWeekStats(week);
  }
}

export function usageEntryFromIntent(intent, text) {
  if (!intent?.recognized) {
    return {
      status: "unmatched",
      unmatchedText: text,
    };
  }

  if (intent.unknownLocation) {
    return {
      status: "unmatched",
      unmatchedText: intent.locationQuery || text,
    };
  }

  return {
    status: "matched",
    mode: intent.requestedTime ? "time" : intent.scheduleDay?.keyword || "now",
    location: intent.locationQuery || "all",
  };
}

export function isoWeekKey(date = new Date(), timeZone = "America/New_York") {
  const parts = localDateParts(date, timeZone);
  const localDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const day = localDate.getUTCDay() || 7;
  localDate.setUTCDate(localDate.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(localDate.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((localDate - yearStart) / 86400000 + 1) / 7);
  return `${localDate.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function previousIsoWeekKey(weekKey) {
  const match = String(weekKey).match(/^(\d{4})-W(\d{2})$/);
  if (!match) return weekKey;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week > 1) return `${year}-W${String(week - 1).padStart(2, "0")}`;
  const lastWeek = weeksInIsoYear(year - 1);
  return `${year - 1}-W${String(lastWeek).padStart(2, "0")}`;
}

function weeksInIsoYear(year) {
  const dec28 = new Date(Date.UTC(year, 11, 28));
  return Number(isoWeekKey(dec28, "UTC").slice(-2));
}

function localDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function normalizeWeekStats(value, week) {
  return {
    week,
    total: Number(value?.total || 0),
    matched: Number(value?.matched || 0),
    unmatched: Number(value?.unmatched || 0),
    byMode: normalizeCounts(value?.byMode),
    byLocation: normalizeCounts(value?.byLocation),
    unmatchedTerms: normalizeCounts(value?.unmatchedTerms),
    createdAt: value?.createdAt || new Date().toISOString(),
    updatedAt: value?.updatedAt || value?.createdAt || new Date().toISOString(),
  };
}

function emptyWeekStats(week) {
  const now = new Date().toISOString();
  return {
    week,
    total: 0,
    matched: 0,
    unmatched: 0,
    byMode: {},
    byLocation: {},
    unmatchedTerms: {},
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeCounts(value) {
  const counts = {};
  for (const [key, count] of Object.entries(value || {})) {
    if (!key) continue;
    counts[key] = Number(count || 0);
  }
  return counts;
}

function increment(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

function normalizeUnmatchedTerm(text) {
  const normalized = normalizeText(text);
  if (!normalized) return "";
  return normalized.slice(0, MAX_UNMATCHED_TERM_LENGTH);
}

function formatCounts(counts) {
  const items = Object.entries(counts || {})
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_TOP_ITEMS);

  if (!items.length) return "none";
  return items.map(([name, count]) => `${name} ${count}`).join(", ");
}

function usageKey(week) {
  return `usage:week:${week}`;
}
