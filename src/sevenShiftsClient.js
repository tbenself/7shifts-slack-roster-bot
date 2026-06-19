export class SevenShiftsClient {
  constructor(config, options = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl || ((input, init) => fetch(input, init));
    this.now = options.now || (() => new Date());
    this.token = null;
    this.tokenPromise = null;
    this.cache = new TimedCache();
  }

  async getCurrentRoster({ locationTarget } = {}) {
    const locations = await this.listLocations().catch(() => []);
    const locationId = resolveLocationId(locationTarget, locations);
    const locationNameFilter = locationTarget && !locationId ? String(locationTarget) : "";

    const [shifts, users, roles, departments] = await Promise.all([
      this.listCurrentShifts(locationId),
      this.listUsers(locationId),
      this.listRoles(locationId).catch(() => []),
      this.listDepartments(locationId).catch(() => []),
    ]);

    const roster = buildRoster({ shifts, users, roles, departments, locations, locationId });
    return locationNameFilter ? filterRosterByLocationName(roster, locationNameFilter) : roster;
  }

  async getScheduleRoster({ locationTarget, offsetDays = 0, timeZone = "America/New_York" } = {}) {
    const locations = await this.listLocations().catch(() => []);
    const locationId = resolveLocationId(locationTarget, locations);
    const locationNameFilter = locationTarget && !locationId ? String(locationTarget) : "";
    const range = localDayRange(this.now(), offsetDays, timeZone);

    const [shifts, users, roles, departments] = await Promise.all([
      this.listShiftsForRange(locationId, range),
      this.listUsers(locationId),
      this.listRoles(locationId).catch(() => []),
      this.listDepartments(locationId).catch(() => []),
    ]);

    const roster = buildRoster({ shifts, users, roles, departments, locations, locationId, sortMode: "time" });
    return {
      roster: locationNameFilter ? filterRosterByLocationName(roster, locationNameFilter) : roster,
      range,
    };
  }

  async listCurrentShifts(locationId) {
    const now = this.now();
    const nowMs = now.getTime();
    const lookbackStart = new Date(nowMs - 36 * 60 * 60 * 1000);
    const params = {
      limit: 500,
      "start[gte]": formatSevenShiftsDate(lookbackStart),
      "start[lte]": formatSevenShiftsDate(now),
      sort_by: "start",
      sort_dir: "asc",
    };
    if (locationId) params.location_id = locationId;

    const shifts = await this.listAll(`/company/${this.config.companyId}/shifts`, params, 500);
    return shifts
      .map((item) => unwrap(item, "shift"))
      .filter((shift) => shift && !shift.deleted && !shift.open && getUserId(shift))
      .filter((shift) => shiftHasStarted(shift, nowMs) && shiftHasNotEnded(shift, nowMs));
  }

  async listShiftsForRange(locationId, range) {
    const params = {
      limit: 500,
      "start[gte]": formatSevenShiftsDate(range.start),
      "start[lte]": formatSevenShiftsDate(range.end),
      sort_by: "start",
      sort_dir: "asc",
    };
    if (locationId) params.location_id = locationId;

    const startMs = range.start.getTime();
    const endMs = range.end.getTime();
    const shifts = await this.listAll(`/company/${this.config.companyId}/shifts`, params, 500);
    return shifts
      .map((item) => unwrap(item, "shift"))
      .filter((shift) => shift && !shift.deleted && !shift.open && getUserId(shift))
      .filter((shift) => shiftStartsInRange(shift, startMs, endMs));
  }

  async listUsers(locationId) {
    const cacheKey = locationId ? `users:${locationId}` : "users:all";
    return this.cache.get(cacheKey, 10 * 60 * 1000, async () => {
      const params = { limit: 50 };
      if (locationId) params.location_id = locationId;
      const users = await this.listAll(`/company/${this.config.companyId}/users`, params, 50);
      return users.map((item) => unwrap(item, "user")).filter(Boolean);
    });
  }

  async listLocations() {
    return this.cache.get("locations", 30 * 60 * 1000, async () => {
      const locations = await this.listAll(`/company/${this.config.companyId}/locations`, { limit: 500 }, 500);
      return locations.map((item) => unwrap(item, "location")).filter(Boolean);
    });
  }

  async listRoles(locationId) {
    const cacheKey = locationId ? `roles:${locationId}` : "roles:all";
    return this.cache.get(cacheKey, 30 * 60 * 1000, async () => {
      const params = { limit: 500 };
      if (locationId) params.location_id = locationId;
      const roles = await this.listAll(`/company/${this.config.companyId}/roles`, params, 500);
      return roles.map((item) => unwrap(item, "role")).filter(Boolean);
    });
  }

  async listDepartments(locationId) {
    const cacheKey = locationId ? `departments:${locationId}` : "departments:all";
    return this.cache.get(cacheKey, 30 * 60 * 1000, async () => {
      const params = { limit: 500 };
      if (locationId) params.location_id = locationId;
      const departments = await this.listAll(`/company/${this.config.companyId}/departments`, params, 500);
      return departments.map((item) => unwrap(item, "department")).filter(Boolean);
    });
  }

  async listAll(path, params, defaultLimit) {
    const results = [];
    let cursor;
    do {
      const page = await this.request(path, { ...params, limit: params.limit || defaultLimit, cursor });
      const data = Array.isArray(page.data) ? page.data : page.data ? [page.data] : [];
      results.push(...data);
      cursor = page.meta?.cursor?.next || null;
    } while (cursor);
    return results;
  }

  async request(path, params = {}) {
    const url = new URL(`${this.config.apiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    const token = await this.getToken();
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    };
    if (this.config.companyGuid) headers["x-company-guid"] = this.config.companyGuid;
    if (this.config.apiVersion) headers["x-api-version"] = this.config.apiVersion;

    const response = await this.fetchImpl(url, { headers });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(`7shifts ${response.status}: ${payload.message || payload.detail || "request failed"}`);
    }
    return payload;
  }

  async getToken() {
    if (this.config.accessToken) return this.config.accessToken;

    const now = Date.now();
    if (this.token && this.token.expiresAt > now + 60_000) {
      return this.token.accessToken;
    }
    if (!this.tokenPromise) {
      this.tokenPromise = this.fetchToken().finally(() => {
        this.tokenPromise = null;
      });
    }
    return this.tokenPromise;
  }

  async fetchToken() {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: this.config.scopes,
    });

    const response = await this.fetchImpl(this.config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(`7shifts OAuth ${response.status}: ${payload.error_description || payload.error || "token request failed"}`);
    }
    if (!payload.access_token) throw new Error("7shifts OAuth response did not include access_token");

    const expiresIn = Number(payload.expires_in || 3600);
    this.token = {
      accessToken: payload.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    return this.token.accessToken;
  }
}

export function buildRoster({ shifts, users, roles, departments = [], locations, locationId, sortMode = "role" }) {
  const usersById = new Map(users.map((user) => [String(user.id), user]));
  const rolesById = new Map(roles.map((role) => [String(role.id), role]));
  const departmentsById = new Map(departments.map((department) => [String(department.id), department]));
  const locationsById = new Map(locations.map((location) => [String(location.id), location]));
  const groupsByLocation = new Map();

  for (const shift of shifts) {
    const shiftLocationId = getLocationId(shift) || locationId;
    const location = locationsById.get(String(shiftLocationId));
    const locationName = location?.name || shift.location?.name || `Location ${shiftLocationId || "unknown"}`;
    if (!groupsByLocation.has(locationName)) {
      groupsByLocation.set(locationName, { locationName, shifts: [] });
    }

    groupsByLocation.get(locationName).shifts.push({
      shift,
      user: usersById.get(String(getUserId(shift))) || shift.user || null,
      role: rolesById.get(String(getRoleId(shift))) || shift.role || null,
      department: departmentsById.get(String(getDepartmentId(shift))) || shift.department || null,
      start: shift.start,
      end: shift.end,
    });
  }

  const groups = Array.from(groupsByLocation.values())
    .map((group) => ({
      ...group,
      shifts: group.shifts.sort(sortMode === "time" ? compareRosterShiftsByTime : compareRosterShifts),
    }))
    .sort((a, b) => a.locationName.localeCompare(b.locationName));

  return { groups };
}

function compareRosterShiftsByTime(a, b) {
  const start = Date.parse(a.start) - Date.parse(b.start);
  if (start !== 0) return start;
  return compareRosterShifts(a, b);
}

function compareRosterShifts(a, b) {
  const role = (a.role?.name || "").localeCompare(b.role?.name || "");
  if (role !== 0) return role;
  const aName = `${a.user?.first_name || ""} ${a.user?.last_name || ""}`;
  const bName = `${b.user?.first_name || ""} ${b.user?.last_name || ""}`;
  return aName.localeCompare(bName);
}

function resolveLocationId(target, locations) {
  if (!target) return undefined;
  if (Number.isInteger(target) || /^\d+$/.test(String(target))) return Number(target);
  const normalized = String(target).trim().toLowerCase();
  const match = locations.find((location) => String(location.name || "").trim().toLowerCase() === normalized);
  return match?.id;
}

function filterRosterByLocationName(roster, locationName) {
  const needle = normalizeName(locationName);
  return {
    groups: roster.groups.filter((group) => {
      const haystack = normalizeName(group.locationName);
      return haystack === needle || haystack.includes(needle) || needle.includes(haystack);
    }),
  };
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\bwest sixth\b/g, "")
    .replace(/\bbrewing\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatSevenShiftsDate(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function shiftHasStarted(shift, nowMs) {
  const startMs = Date.parse(shift.start);
  return Number.isFinite(startMs) && startMs <= nowMs;
}

function shiftHasNotEnded(shift, nowMs) {
  const endMs = Date.parse(shift.end);
  return Number.isFinite(endMs) && endMs >= nowMs;
}

function shiftStartsInRange(shift, startMs, endMs) {
  const shiftStartMs = Date.parse(shift.start);
  return Number.isFinite(shiftStartMs) && shiftStartMs >= startMs && shiftStartMs < endMs;
}

function localDayRange(now, offsetDays, timeZone) {
  const parts = localDateParts(now, timeZone);
  const target = addDays(parts, offsetDays, timeZone);
  const next = addDays(target, 1, timeZone);
  return {
    start: zonedDateTimeToUtc(target.year, target.month, target.day, 0, 0, 0, timeZone),
    end: zonedDateTimeToUtc(next.year, next.month, next.day, 0, 0, 0, timeZone),
  };
}

function addDays(parts, days, timeZone) {
  const noonUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return localDateParts(noonUtc, timeZone);
}

function localDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === "year").value),
    month: Number(parts.find((part) => part.type === "month").value),
    day: Number(parts.find((part) => part.type === "day").value),
  };
}

function zonedDateTimeToUtc(year, month, day, hour, minute, second, timeZone) {
  const asUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstOffset = timeZoneOffsetMs(new Date(asUtcMs), timeZone);
  const firstGuess = asUtcMs - firstOffset;
  const secondOffset = timeZoneOffsetMs(new Date(firstGuess), timeZone);
  return new Date(asUtcMs - secondOffset);
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return asUtc - date.getTime();
}

function getUserId(shift) {
  return shift.user_id || shift.users_id || shift.user?.id;
}

function getRoleId(shift) {
  return shift.role_id || shift.role?.id;
}

function getDepartmentId(shift) {
  return shift.department_id || shift.departments_id || shift.department?.id;
}

function getLocationId(shift) {
  return shift.location_id || shift.location?.id;
}

function unwrap(item, key) {
  return item?.[key] || item;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

class TimedCache {
  constructor() {
    this.values = new Map();
  }

  async get(key, ttlMs, factory) {
    const now = Date.now();
    const existing = this.values.get(key);
    if (existing && existing.expiresAt > now) return existing.value;
    const value = await factory();
    this.values.set(key, { value, expiresAt: now + ttlMs });
    return value;
  }
}
