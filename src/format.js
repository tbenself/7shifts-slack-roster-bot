export function formatRosterResponse(roster, options = {}) {
  const {
    timeZone = "America/New_York",
    nameFormat = "first_last_initial",
    requestedLocation,
    now = new Date(),
  } = options;

  const asOf = formatTime(now, timeZone);
  const scope = requestedLocation ? ` at ${requestedLocation}` : "";

  if (!roster.groups.length) {
    return `No one is scheduled as working right now${scope}. Checked at ${asOf}.`;
  }

  const lines = [`*Who's working right now${scope}* (${asOf})`];
  for (const group of roster.groups) {
    lines.push(`\n*${group.locationName}* (${group.shifts.length})`);
    for (const shift of group.shifts) {
      const person = formatPersonName(shift.user, nameFormat);
      const detail = formatShiftDetail(shift);
      const until = shift.end ? ` until ${formatTime(new Date(shift.end), timeZone)}` : "";
      lines.push(`• ${person}${detail}${until}`);
    }
  }
  return lines.join("\n");
}

export function formatScheduleResponse(roster, options = {}) {
  const {
    timeZone = "America/New_York",
    nameFormat = "first_last_initial",
    requestedLocation,
    scheduleLabel = "today",
    scheduleDate = new Date(),
  } = options;

  const date = formatDate(scheduleDate, timeZone);
  const scope = requestedLocation ? ` at ${requestedLocation}` : "";

  if (!roster.groups.length) {
    return `No scheduled shifts found for ${scheduleLabel}${scope} (${date}).`;
  }

  const lines = [`*Full schedule for ${scheduleLabel}${scope}* (${date})`];
  for (const group of roster.groups) {
    lines.push(`\n*${group.locationName}* (${group.shifts.length})`);
    for (const shift of group.shifts) {
      const person = formatPersonName(shift.user, nameFormat);
      const detail = formatShiftDetail(shift);
      const start = shift.start ? formatTime(new Date(shift.start), timeZone) : "?";
      const end = shift.end ? formatTime(new Date(shift.end), timeZone) : "?";
      lines.push(`• ${start}-${end} - ${person}${detail}`);
    }
  }
  return lines.join("\n");
}

export function formatUnknownLocation(locationQuery, locationNames = []) {
  const options = locationNames.slice(0, 8).join(", ");
  if (!options) {
    return `I do not recognize "${locationQuery}" as a 7shifts location yet. Try "who's working" for all locations.`;
  }
  return `I do not recognize "${locationQuery}" yet. Try one of: ${options}.`;
}

function formatPersonName(user, nameFormat) {
  if (!user) return "Unknown employee";
  const first = user.first_name || user.firstName || "";
  const last = user.last_name || user.lastName || "";
  if (nameFormat === "full") return [first, last].filter(Boolean).join(" ") || "Unknown employee";
  if (nameFormat === "first") return first || [first, last].filter(Boolean).join(" ") || "Unknown employee";
  const lastInitial = last ? ` ${last[0].toUpperCase()}.` : "";
  return `${first}${lastInitial}`.trim() || "Unknown employee";
}

function formatShiftDetail(shift) {
  const role = cleanLabel(shift.role?.name);
  const area = findAreaLabel(shift, role);
  const labels = [role, area].filter(Boolean);
  return labels.length ? ` - ${labels.join(" / ")}` : "";
}

function findAreaLabel(shift, roleName) {
  const rawShift = shift.shift || {};
  const sources = [shift.department, rawShift, shift.role, shift.user];
  const labels = [];
  for (const source of sources) {
    labels.push(...areaLabelsFrom(source));
  }

  const normalizedRole = normalizeLabel(roleName);
  return labels.find((label) => label && normalizeLabel(label) !== normalizedRole) || "";
}

function areaLabelsFrom(source = {}) {
  return [
    labelFrom(source),
    labelFrom(source.area),
    labelFrom(source.area_name),
    labelFrom(source.section),
    labelFrom(source.section_name),
    labelFrom(source.station),
    labelFrom(source.station_name),
    labelFrom(source.department),
    labelFrom(source.department_name),
    labelFrom(source.shift_department),
    labelFrom(source.shift_department_name),
    labelFrom(source.job),
    labelFrom(source.job_name),
    labelFrom(source.job_type),
    labelFrom(source.job_type_name),
  ].filter(Boolean);
}

function labelFrom(value) {
  if (!value) return "";
  if (typeof value === "string") return cleanLabel(value);
  if (typeof value !== "object") return "";
  return cleanLabel(value.name || value.title || value.label || value.department_name || value.job_name);
}

function cleanLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeLabel(value) {
  return cleanLabel(value).toLowerCase();
}

function formatTime(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(date);
}

function formatDate(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(date);
}
