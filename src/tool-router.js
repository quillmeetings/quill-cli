const ROUTES = {
  listMeetings: [
    "meetings_list",
    "list_meetings",
    "meeting_list",
    "get_meetings",
    "search_meetings",
  ],
  getMeeting: [
    "meeting_get",
    "get_meeting",
    "meeting_view",
    "get_meeting_details",
  ],
  getTranscript: [
    "transcript_get",
    "get_transcript",
    "meeting_transcript",
    "get_meeting_transcript",
  ],
  getNotes: [
    "get_minutes",
    "notes_get",
    "get_notes",
    "meeting_notes",
    "get_meeting_notes",
    "summary_get",
    "get_summary",
  ],
  search: [
    "search",
    "search_meetings",
    "search_transcripts",
    "meetings_search",
  ],
  listContacts: ["list_contacts", "contacts_list"],
  getContact: ["get_contact", "contact_get"],
  listThreads: ["list_threads", "threads_list"],
  getThread: ["get_thread", "thread_get"],
  listEvents: ["list_events", "events_list"],
  getEvent: ["get_event", "event_get"],
  listTemplates: ["list_templates", "templates_list"],
  getTemplate: ["get_template", "template_get"],
  createNote: ["create_note", "note_create", "create_meeting_note"],
};

export function findTool(tools, routeName) {
  const candidates = ROUTES[routeName] || [];
  const normalizedTools = tools.map((tool) => ({
    ...tool,
    normalizedName: normalize(tool.name),
    searchable: normalize(`${tool.name} ${tool.description || ""}`),
  }));

  for (const candidate of candidates) {
    const normalized = normalize(candidate);
    const exact = normalizedTools.find((tool) => tool.normalizedName === normalized);
    if (exact) return exact;
  }

  const words = routeName.replace(/[A-Z]/g, (match) => ` ${match.toLowerCase()}`).trim().split(/\s+/);
  return normalizedTools.find((tool) => words.every((word) => tool.searchable.includes(word)));
}

// True when the tool's schema declares an offset-style paging parameter, so a
// next_offset hint in the output is actually actionable on a follow-up call.
export function toolSupportsOffset(tool) {
  const properties = tool?.inputSchema?.properties || {};
  return ["offset", "skip"].some((key) => Object.hasOwn(properties, key));
}

export function buildArgs(tool, values) {
  const schema = tool.inputSchema || {};
  const properties = schema.properties || {};
  const args = {};

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    const targetKey = pickProperty(properties, key) || key;
    args[targetKey] = value;
  }

  return args;
}

function pickProperty(properties, key) {
  if (Object.hasOwn(properties, key)) return key;
  const aliases = {
    id: ["meeting_id", "meetingId", "document_id", "documentId", "id"],
    query: ["query", "q", "search", "text"],
    limit: ["limit", "count", "max", "page_size", "pageSize"],
    offset: ["offset", "skip"],
    since: ["since", "start", "from", "after", "start_date", "startDate"],
    until: ["until", "end", "to", "before", "end_date", "endDate"],
    includeMeetings: ["include_meetings", "includeMeetings"],
    meetingsLimit: ["meetings_limit", "meetingsLimit"],
    kind: ["kind", "type"],
    includeDisabled: ["include_disabled", "includeDisabled"],
    meetingId: ["meeting_id", "meetingId", "id"],
    prompt: ["prompt"],
    instruction: ["instruction"],
    templateId: ["template_id", "templateId"],
    includePrivateNotes: ["include_private_notes", "includePrivateNotes"],
    data: ["data"],
  };
  return aliases[key]?.find((alias) => Object.hasOwn(properties, alias));
}

function normalize(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
