import test from "node:test";
import assert from "node:assert/strict";
import { buildLocationMatcher, parseRosterIntent } from "../src/intent.js";

test("recognizes who is working with no location", () => {
  const intent = parseRosterIntent("who's working right now?", new Map());
  assert.equal(intent.recognized, true);
  assert.equal(intent.locationTarget, undefined);
});

test("recognizes a bare configured location alias", () => {
  const matcher = buildLocationMatcher([], { downtown: 123 });
  const intent = parseRosterIntent("Downtown", matcher);
  assert.equal(intent.recognized, true);
  assert.equal(intent.locationTarget, 123);
  assert.equal(intent.scheduleDay, null);
});

test("recognizes a configured location alias with a schedule day", () => {
  const matcher = buildLocationMatcher([], { downtown: 123, riverside: 456 });
  const downtown = parseRosterIntent("Downtown tomorrow", matcher);
  const riverside = parseRosterIntent("who is working at riverside yesterday?", matcher);

  assert.equal(downtown.recognized, true);
  assert.equal(downtown.locationTarget, 123);
  assert.deepEqual(downtown.scheduleDay, { keyword: "tomorrow", offsetDays: 1 });
  assert.equal(riverside.recognized, true);
  assert.equal(riverside.locationTarget, 456);
  assert.deepEqual(riverside.scheduleDay, { keyword: "yesterday", offsetDays: -1 });
});

test("recognizes a configured location alias with a requested time", () => {
  const matcher = buildLocationMatcher([], { downtown: 123, riverside: 456 });
  const noon = parseRosterIntent("downtown noon", matcher);
  const afternoon = parseRosterIntent("downtown 2pm", matcher);
  const spaced = parseRosterIntent("who is working at riverside 2 pm?", matcher);
  const halfHour = parseRosterIntent("downtown 2:30pm", matcher);

  assert.equal(noon.recognized, true);
  assert.equal(noon.locationTarget, 123);
  assert.deepEqual(noon.requestedTime, { hour: 12, minute: 0, label: "noon" });
  assert.deepEqual(afternoon.requestedTime, { hour: 14, minute: 0, label: "2:00 PM" });
  assert.equal(spaced.locationTarget, 456);
  assert.deepEqual(spaced.requestedTime, { hour: 14, minute: 0, label: "2:00 PM" });
  assert.deepEqual(halfHour.requestedTime, { hour: 14, minute: 30, label: "2:30 PM" });
});

test("recognizes location inside a who is working phrase", () => {
  const matcher = buildLocationMatcher([{ id: 456, name: "Riverside Bar" }], {});
  const intent = parseRosterIntent("who is working at Riverside?", matcher);
  assert.equal(intent.recognized, true);
  assert.equal(intent.locationTarget, 456);
});

test("recognizes shorthand location aliases", () => {
  const matcher = buildLocationMatcher([], {
    downtown: "Downtown Taproom",
    dt: "Downtown Taproom",
    main: "Downtown Taproom",
    riverside: "Riverside Bar",
    river: "Riverside Bar",
    patio: "Riverside Bar",
    events: "Events Team",
    catering: "Events Team",
  });

  for (const input of ["Downtown", "DT", "Main"]) {
    assert.equal(parseRosterIntent(input, matcher).locationTarget, "Downtown Taproom");
  }

  for (const input of ["Riverside", "River", "Patio"]) {
    assert.equal(parseRosterIntent(input, matcher).locationTarget, "Riverside Bar");
  }

  for (const input of ["events", "catering"]) {
    assert.equal(parseRosterIntent(input, matcher).locationTarget, "Events Team");
  }
});

test("marks unknown location in a who is working phrase", () => {
  const matcher = buildLocationMatcher([], { main: 1 });
  const intent = parseRosterIntent("who's working at Mars", matcher);
  assert.equal(intent.recognized, true);
  assert.equal(intent.unknownLocation, true);
});

test("rejects unrelated text", () => {
  const intent = parseRosterIntent("hello there", new Map());
  assert.equal(intent.recognized, false);
});
