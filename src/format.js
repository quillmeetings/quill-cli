export function printData(data, options = {}) {
  data = shapeForOutput(data, options);
  const format = options.format || "human";
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  if (format === "human" || options.human) {
    const rendered = toHuman(data);
    if (rendered) {
      process.stdout.write(`${rendered}\n`);
      return;
    }
  }

  process.stdout.write(`${toToon(data)}\n`);
}

export function shapeForOutput(data, options = {}) {
  const cloned = clone(data);
  applyFieldSelection(cloned, options);
  if (!options.full) truncateLargeStrings(cloned, Number.parseInt(options.truncate || "1200", 10));
  return cloned;
}

export function toHuman(data) {
  const result = data?.result || data;
  if (!result || typeof result !== "object") return null;

  if (result.bin && result.description) return toStatusScreen(result, data.help);
  if (result.config_path && result.mcp_bridge) return toStatusScreen({ title: "Quill setup", ...result }, data.help);
  if (result.title === "Quill doctor" && Array.isArray(result.checks)) return toDoctorScreen(result);

  for (const key of ["meetings", "events", "contacts", "templates", "threads", "notes"]) {
    if (Array.isArray(result[key])) {
      const rows = result[key].map((item) => humanizeRow(item));
      const title = `${capitalize(key)} (${result.count ?? rows.length})`;
      const help = Array.isArray(data.help) ? `\n\n${data.help.join("\n")}` : "";
      return `${title}\n${toTable(rows)}${help}`;
    }
  }

  if (typeof result.message === "string") return result.message;
  return null;
}

function toDoctorScreen(result) {
  const lines = [result.title, ""];
  for (const check of result.checks) {
    lines.push(`${check.status.padEnd(4)} ${check.name}: ${check.message}`);
    if (check.remediation) lines.push(`     ${check.remediation}`);
  }
  lines.push("");
  if (result.all_good) {
    lines.push("All good. Run `quill browse`.");
  } else {
    lines.push(`${result.issue_count} issue${result.issue_count === 1 ? "" : "s"} - start with: ${result.start_with}`);
  }
  return lines.join("\n");
}

function toStatusScreen(data, help) {
  const lines = [
    `${data.bin || data.title}`,
  ];
  if (data.description) lines.push(data.description);
  const rows = Object.entries(data)
    .filter(([key]) => !["bin", "title", "description", "next", "help"].includes(key))
    .map(([key, value]) => [humanLabel(key), formatHumanValue(value)]);

  if (rows.length > 0) {
    lines.push("");
    const width = Math.max(...rows.map(([key]) => key.length));
    lines.push(...rows.map(([key, value]) => `${key.padEnd(width)}  ${value}`));
  }

  if (data.next) lines.push("", data.next);
  else if (Array.isArray(help) && help.length > 0) lines.push("", ...help);
  return lines.join("\n");
}

export function toToon(value, indent = 0, key = null) {
  const pad = " ".repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return key ? `${pad}${key}[0]:` : `${pad}items[0]:`;
    if (value.every(isFlatObject)) {
      const fields = collectFields(value);
      const header = key ? `${key}[${value.length}]{${fields.join(",")}}:` : `items[${value.length}]{${fields.join(",")}}:`;
      const rows = value.map((item) => `${pad}  ${fields.map((field) => scalar(item[field])).join(",")}`);
      return [`${pad}${header}`, ...rows].join("\n");
    }
    const header = key ? `${pad}${key}[${value.length}]:` : `${pad}items[${value.length}]:`;
    return [header, ...value.map((item) => toToon(item, indent + 2))].join("\n");
  }

  if (isObject(value)) {
    const lines = [];
    if (key) lines.push(`${pad}${key}:`);
    for (const [childKey, childValue] of Object.entries(value)) {
      if (Array.isArray(childValue) || isObject(childValue)) {
        lines.push(toToon(childValue, key ? indent + 2 : indent, childKey));
      } else {
        lines.push(`${key ? " ".repeat(indent + 2) : pad}${childKey}: ${scalar(childValue)}`);
      }
    }
    return lines.join("\n");
  }

  return key ? `${pad}${key}: ${scalar(value)}` : `${pad}${scalar(value)}`;
}

export function structuredError(code, message, details = undefined) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return { error };
}

export function withHelp(data, commands) {
  return {
    ...data,
    help: commands,
  };
}

export function truncateText(value, limit = 1200) {
  if (typeof value !== "string" || value.length <= limit) return value;
  return `${value.slice(0, limit)}... (truncated, ${value.length} chars total; use --full to see complete text)`;
}

function collectFields(items) {
  const preferred = ["id", "title", "name", "date", "start", "duration", "status"];
  const keys = [...new Set(items.flatMap((item) => Object.keys(item)))];
  const sorted = [...preferred.filter((key) => keys.includes(key)), ...keys.filter((key) => !preferred.includes(key))];
  return sorted.slice(0, 4);
}

function isFlatObject(value) {
  return isObject(value) && Object.values(value).every((child) => !Array.isArray(child) && !isObject(child));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalar(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const normalized = value.replace(/\r?\n/g, "\\n");
    return /[,"\n]/.test(normalized) ? JSON.stringify(normalized) : normalized;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function humanizeRow(item) {
  const row = { ...item };
  for (const key of ["date", "start", "end", "started_at", "created_at"]) {
    if (row[key]) row[key] = relativeTime(row[key]);
  }
  return row;
}

function relativeTime(value) {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return value;
  const seconds = Math.round((time - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [name, size] of units) {
    if (abs >= size) {
      const amount = Math.round(abs / size);
      return seconds < 0 ? `${amount} ${name}${amount === 1 ? "" : "s"} ago` : `in ${amount} ${name}${amount === 1 ? "" : "s"}`;
    }
  }
  return seconds < 0 ? "just now" : "now";
}

function toTable(rows) {
  if (rows.length === 0) return "(none)";
  const fields = collectFields(rows);
  const widths = fields.map((field) => Math.max(field.length, ...rows.map((row) => truncateCell(row[field]).length)));
  const header = fields.map((field, index) => field.padEnd(widths[index])).join("  ");
  const divider = widths.map((width) => "-".repeat(width)).join("  ");
  const body = rows.map((row) => fields.map((field, index) => truncateCell(row[field]).padEnd(widths[index])).join("  "));
  return [header, divider, ...body].join("\n");
}

function truncateCell(value) {
  const text = value === null || value === undefined ? "" : String(value).replace(/\s+/g, " ");
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

function formatHumanValue(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  if (Array.isArray(value)) return value.join(", ");
  if (isObject(value)) return JSON.stringify(value);
  return value === null || value === undefined ? "" : String(value);
}

function humanLabel(value) {
  return String(value)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bMcp\b/g, "MCP");
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function clone(value) {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function applyFieldSelection(data, options) {
  const fields = options.fields;
  const collections = findCollections(data);
  for (const collection of collections) {
    const selected = fields || defaultFieldsFor(collection.key);
    if (!selected) continue;
    collection.items.forEach((item) => {
      for (const key of Object.keys(item)) {
        if (!selected.includes(key)) delete item[key];
      }
    });
  }
}

function findCollections(value, collections = []) {
  if (!isObject(value)) return collections;
  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child) && child.every(isFlatObject)) {
      collections.push({ key, items: child });
    } else if (isObject(child)) {
      findCollections(child, collections);
    }
  }
  return collections;
}

function defaultFieldsFor(key) {
  const fields = {
    meetings: ["id", "title", "date", "duration"],
    events: ["id", "title", "start", "end"],
    contacts: ["id", "name", "email"],
    templates: ["id", "name", "kind", "verb"],
    threads: ["id", "title", "updated_at"],
    notes: ["id", "title", "template_id", "created_at"],
    tools: ["name", "description"],
  };
  return fields[key];
}

function truncateLargeStrings(value, limit) {
  if (Array.isArray(value)) {
    value.forEach((item) => truncateLargeStrings(item, limit));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") value[key] = truncateText(child, limit);
    else truncateLargeStrings(child, limit);
  }
}
