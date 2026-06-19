import test from "node:test";
import assert from "node:assert/strict";
import {
  formatRosterAtTimeResponse,
  formatRosterResponse,
  formatScheduleResponse,
  formatUnknownLocation,
} from "../src/format.js";

test("formats empty roster", () => {
  const text = formatRosterResponse(
    { groups: [] },
    { requestedLocation: "Downtown", now: new Date("2026-06-18T16:00:00Z"), timeZone: "America/New_York" },
  );
  assert.match(text, /No one is scheduled as working right now at Downtown/);
});

test("formats roster without exposing private user fields", () => {
  const text = formatRosterResponse(
    {
      groups: [
        {
          locationName: "Downtown Taproom",
          shifts: [
            {
              user: {
                first_name: "Ada",
                last_name: "Lovelace",
                email: "ada@example.com",
                mobile_phone: "555-555-5555",
              },
              role: { name: "Bar" },
              shift: { department: { name: "Upstairs" } },
              end: "2026-06-18T22:00:00Z",
            },
          ],
        },
      ],
    },
    { now: new Date("2026-06-18T16:00:00Z"), timeZone: "America/New_York" },
  );

  assert.match(text, /Ada L\./);
  assert.match(text, /Bar \/ Upstairs/);
  assert.doesNotMatch(text, /ada@example/);
  assert.doesNotMatch(text, /555/);
});

test("does not duplicate role when job label matches role", () => {
  const text = formatRosterResponse(
    {
      groups: [
        {
          locationName: "Main",
          shifts: [
            {
              user: { first_name: "Ada", last_name: "Lovelace" },
              role: { name: "Bar" },
              shift: { job: { name: "Bar" } },
              end: "2026-06-18T22:00:00Z",
            },
          ],
        },
      ],
    },
    { now: new Date("2026-06-18T16:00:00Z"), timeZone: "America/New_York" },
  );

  assert.match(text, /Ada L\. - Bar until/);
  assert.doesNotMatch(text, /Bar \/ Bar/);
});

test("formats enriched department after role", () => {
  const text = formatRosterResponse(
    {
      groups: [
        {
          locationName: "Riverside Bar",
          shifts: [
            {
              user: { first_name: "Jamie", last_name: "Rivera" },
              role: { name: "Bartender" },
              department: { name: "Patio" },
              end: "2026-06-19T02:30:00Z",
            },
          ],
        },
      ],
    },
    { now: new Date("2026-06-19T00:00:00Z"), timeZone: "America/New_York" },
  );

  assert.match(text, /Jamie R\. - Bartender \/ Patio until 10:30 PM EDT/);
});


test("formats a full schedule response", () => {
  const text = formatScheduleResponse(
    {
      groups: [
        {
          locationName: "Riverside Bar",
          shifts: [
            {
              user: {
                first_name: "Ada",
                last_name: "Lovelace",
                email: "ada@example.com",
              },
              role: { name: "Bar" },
              shift: { station_name: "Patio" },
              start: "2026-06-19T14:00:00Z",
              end: "2026-06-19T20:00:00Z",
            },
          ],
        },
      ],
    },
    {
      requestedLocation: "downtown",
      scheduleLabel: "tomorrow",
      scheduleDate: new Date("2026-06-19T04:00:00Z"),
      timeZone: "America/New_York",
    },
  );

  assert.match(text, /Full schedule for tomorrow at downtown/);
  assert.match(text, /Fri, Jun 19/);
  assert.match(text, /10:00 AM EDT-4:00 PM EDT - Ada L\. - Bar \/ Patio/);
  assert.doesNotMatch(text, /ada@example/);
});

test("formats a requested-time roster response", () => {
  const text = formatRosterAtTimeResponse(
    {
      groups: [
        {
          locationName: "Downtown Taproom",
          shifts: [
            {
              user: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" },
              role: { name: "Bartender" },
              department: { name: "Patio" },
              end: "2026-06-18T22:00:00Z",
            },
          ],
        },
      ],
    },
    {
      requestedLocation: "downtown",
      requestedAt: new Date("2026-06-18T18:00:00Z"),
      timeZone: "America/New_York",
    },
  );

  assert.match(text, /Who's working today at 2:00 PM EDT at downtown/);
  assert.match(text, /Ada L\. - Bartender \/ Patio until 6:00 PM EDT/);
  assert.doesNotMatch(text, /ada@example/);
});

test("unknown location help lists all public configuration options", () => {
  const text = formatUnknownLocation("downtwon", ["downtown", "riverside", "events"]);

  assert.match(text, /You do not need to type "who's working"/);
  assert.match(text, /Location options: downtown, riverside, events/);
  assert.match(text, /"downtown 2pm"/);
});
