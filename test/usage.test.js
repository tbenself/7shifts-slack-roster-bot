import test from "node:test";
import assert from "node:assert/strict";
import {
  formatUsageReport,
  isUsageAllowed,
  isUsageCommand,
  isoWeekKey,
  recordUsage,
  usageEntryFromIntent,
} from "../src/usage.js";

test("detects usage commands", () => {
  assert.equal(isUsageCommand("usage"), true);
  assert.equal(isUsageCommand("stats"), true);
  assert.equal(isUsageCommand("Downtown"), false);
});

test("allows usage stats for everyone unless user allow-list is configured", () => {
  assert.equal(isUsageAllowed("U1", new Set()), true);
  assert.equal(isUsageAllowed("U1", new Set(["U1"])), true);
  assert.equal(isUsageAllowed("U2", new Set(["U1"])), false);
});

test("records matched and unmatched weekly usage", async () => {
  const kv = new MemoryKv();
  const now = new Date("2026-06-18T16:00:00-04:00");

  await recordUsage(kv, { status: "matched", mode: "today", location: "downtown" }, { now });
  await recordUsage(kv, { status: "matched", mode: "now", location: "events" }, { now });
  await recordUsage(kv, { status: "unmatched", unmatchedText: "Dtown??" }, { now });

  const key = `usage:week:${isoWeekKey(now)}`;
  const stats = JSON.parse(await kv.get(key));

  assert.equal(stats.total, 3);
  assert.equal(stats.matched, 2);
  assert.equal(stats.unmatched, 1);
  assert.deepEqual(stats.byMode, { today: 1, now: 1 });
  assert.deepEqual(stats.byLocation, { downtown: 1, events: 1 });
  assert.deepEqual(stats.unmatchedTerms, { dtown: 1 });
});

test("formats current and previous week usage", async () => {
  const kv = new MemoryKv();
  const now = new Date("2026-06-18T16:00:00-04:00");

  await recordUsage(kv, { status: "matched", mode: "tomorrow", location: "main" }, { now });
  await recordUsage(kv, { status: "unmatched", unmatchedText: "cov haus" }, { now });

  const report = await formatUsageReport(kv, { now });

  assert.match(report, /Usage for 2026-W25/);
  assert.match(report, /Matched requests: 1/);
  assert.match(report, /Unmatched requests: 1/);
  assert.match(report, /Requests by mode: tomorrow 1/);
  assert.match(report, /Locations requested: main 1/);
  assert.match(report, /Unmatched terms: cov haus 1/);
});

test("builds usage entry from roster intent", () => {
  assert.deepEqual(usageEntryFromIntent({ recognized: false }, "hello"), {
    status: "unmatched",
    unmatchedText: "hello",
  });

  assert.deepEqual(usageEntryFromIntent({ recognized: true, unknownLocation: true, locationQuery: "mars" }, "x"), {
    status: "unmatched",
    unmatchedText: "mars",
  });

  assert.deepEqual(
    usageEntryFromIntent({
      recognized: true,
      locationQuery: "downtown",
      scheduleDay: { keyword: "today", offsetDays: 0 },
    }),
    {
      status: "matched",
      mode: "today",
      location: "downtown",
    },
  );

  assert.deepEqual(
    usageEntryFromIntent({
      recognized: true,
      locationQuery: "downtown",
      requestedTime: { hour: 14, minute: 0, label: "2:00 PM" },
    }),
    {
      status: "matched",
      mode: "time",
      location: "downtown",
    },
  );
});

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
