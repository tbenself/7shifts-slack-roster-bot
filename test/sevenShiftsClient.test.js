import test from "node:test";
import assert from "node:assert/strict";
import { SevenShiftsClient, buildRoster } from "../src/sevenShiftsClient.js";

test("buildRoster groups shifts by location and enriches names", () => {
  const roster = buildRoster({
    shifts: [
      { user_id: 1, role_id: 10, department_id: 20, location_id: 100, start: "2026-06-18T14:00:00Z", end: "2026-06-18T22:00:00Z" },
    ],
    users: [{ id: 1, first_name: "Ada", last_name: "Lovelace" }],
    roles: [{ id: 10, name: "Taproom" }],
    departments: [{ id: 20, name: "Patio" }],
    locations: [{ id: 100, name: "Main" }],
  });

  assert.equal(roster.groups.length, 1);
  assert.equal(roster.groups[0].locationName, "Main");
  assert.equal(roster.groups[0].shifts[0].user.first_name, "Ada");
  assert.equal(roster.groups[0].shifts[0].role.name, "Taproom");
  assert.equal(roster.groups[0].shifts[0].department.name, "Patio");
});

test("named location target does not broaden to all locations when unresolved", async () => {
  const client = new SevenShiftsClient({
    apiBaseUrl: "https://example.invalid",
    tokenUrl: "https://example.invalid/token",
    companyId: "1",
    companyGuid: "guid",
    clientId: "client",
    clientSecret: "secret",
    scopes: "shifts:read",
  });

  client.listLocations = async () => [];
  client.listCurrentShifts = async () => [
    { user_id: 1, location: { id: 10, name: "Downtown Taproom" }, end: "2026-06-18T22:00:00Z" },
    { user_id: 2, location: { id: 11, name: "Main" }, end: "2026-06-18T22:00:00Z" },
  ];
  client.listUsers = async () => [
    { id: 1, first_name: "Ada", last_name: "Lovelace" },
    { id: 2, first_name: "Grace", last_name: "Hopper" },
  ];
  client.listRoles = async () => [];

  const roster = await client.getCurrentRoster({ locationTarget: "Downtown Taproom" });
  assert.equal(roster.groups.length, 1);
  assert.equal(roster.groups[0].locationName, "Downtown Taproom");
});

test("listCurrentShifts avoids end[gte] and filters active shifts locally", async () => {
  const requests = [];
  const client = new SevenShiftsClient(
    {
      apiBaseUrl: "https://example.invalid",
      accessToken: "token",
      companyId: "1",
      companyGuid: "guid",
    },
    {
      now: () => new Date("2026-06-18T18:00:00Z"),
      fetchImpl: async (url) => {
        requests.push(new URL(url));
        return jsonResponse({
          data: [
            { id: 1, user_id: 1, start: "2026-06-18T17:00:00Z", end: "2026-06-18T19:00:00Z", open: false, deleted: false },
            { id: 2, user_id: 2, start: "2026-06-18T12:00:00Z", end: "2026-06-18T17:00:00Z", open: false, deleted: false },
            { id: 3, user_id: 3, start: "2026-06-18T19:00:00Z", end: "2026-06-18T22:00:00Z", open: false, deleted: false },
          ],
          meta: { cursor: { next: null } },
        });
      },
    },
  );

  const shifts = await client.listCurrentShifts(100);

  assert.deepEqual(shifts.map((shift) => shift.id), [1]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get("location_id"), "100");
  assert.equal(requests[0].searchParams.get("start[lte]"), "2026-06-18T18:00:00Z");
  assert.equal(requests[0].searchParams.get("start[gte]"), "2026-06-17T06:00:00Z");
  assert.equal(requests[0].searchParams.has("end[gte]"), false);
});

test("getScheduleRoster queries a local day and sorts shifts by start time", async () => {
  const requests = [];
  const client = new SevenShiftsClient(
    {
      apiBaseUrl: "https://example.invalid",
      accessToken: "token",
      companyId: "1",
      companyGuid: "guid",
    },
    {
      now: () => new Date("2026-06-18T18:00:00Z"),
      fetchImpl: async (url) => {
        const requestUrl = new URL(url);
        requests.push(requestUrl);
        if (requestUrl.pathname.endsWith("/locations")) {
          return jsonResponse({ data: [{ id: 100, name: "Main" }], meta: { cursor: { next: null } } });
        }
        if (requestUrl.pathname.endsWith("/users")) {
          return jsonResponse({
            data: [
              { id: 1, first_name: "Ada", last_name: "Lovelace" },
              { id: 2, first_name: "Grace", last_name: "Hopper" },
            ],
            meta: { cursor: { next: null } },
          });
        }
        if (requestUrl.pathname.endsWith("/roles")) {
          return jsonResponse({ data: [{ id: 10, name: "Bar" }], meta: { cursor: { next: null } } });
        }
        if (requestUrl.pathname.endsWith("/departments")) {
          return jsonResponse({ data: [{ id: 20, name: "Patio" }], meta: { cursor: { next: null } } });
        }
        return jsonResponse({
          data: [
            { id: 1, user_id: 1, role_id: 10, department_id: 20, location_id: 100, start: "2026-06-19T16:00:00Z", end: "2026-06-19T20:00:00Z", open: false, deleted: false },
            { id: 2, user_id: 2, role_id: 10, department_id: 20, location_id: 100, start: "2026-06-19T14:00:00Z", end: "2026-06-19T18:00:00Z", open: false, deleted: false },
            { id: 3, user_id: 1, role_id: 10, department_id: 20, location_id: 100, start: "2026-06-20T04:00:00Z", end: "2026-06-20T08:00:00Z", open: false, deleted: false },
          ],
          meta: { cursor: { next: null } },
        });
      },
    },
  );

  const { roster, range } = await client.getScheduleRoster({
    locationTarget: "Main",
    offsetDays: 1,
    timeZone: "America/New_York",
  });

  const shiftRequest = requests.find((url) => url.pathname.endsWith("/shifts"));
  assert.equal(shiftRequest.searchParams.get("start[gte]"), "2026-06-19T04:00:00Z");
  assert.equal(shiftRequest.searchParams.get("start[lte]"), "2026-06-20T04:00:00Z");
  assert.equal(shiftRequest.searchParams.has("end[gte]"), false);
  assert.equal(range.start.toISOString(), "2026-06-19T04:00:00.000Z");
  assert.deepEqual(roster.groups[0].shifts.map((shift) => shift.shift.id), [2, 1]);
  assert.deepEqual(roster.groups[0].shifts.map((shift) => shift.department.name), ["Patio", "Patio"]);
});

function jsonResponse(body) {
  return {
    ok: true,
    text: async () => JSON.stringify(body),
  };
}
