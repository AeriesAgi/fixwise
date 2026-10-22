// Tool catalogue. Descriptions are written for Alexa+ reasoning: when to call, what to say, what never to do.
const s = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const issueArg = { issue: { type: 'string', maxLength: 120, description: 'Issue id (FX-...), municipal reference (CO-...), or a few words like "geyser". Omit for the most recent open issue.' } };

export const TOOLS = [
  { name: 'fixwise_report_problem', title: 'Report a home or street problem', scope: 'fixwise.act', ui: 'ui://fixwise/issue',
    description: 'Use when the customer describes something broken at home (geyser, burst pipe or dripping tap, tripping power, roof leak, blocked drain, gate, fridge or other appliance; several at once is fine) and/or on their street (street light, pothole, water main, live wire, dumping). Gives safety steps first, logs the public part with the municipality and returns priced repair quotes for the private part. Read the safety steps out before anything else.',
    inputSchema: s({ description: { type: 'string', minLength: 3, maxLength: 1000, description: "The customer's own words." }, area: { type: 'string', maxLength: 80, description: 'Suburb or street, if said.' } }, ['description']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: 'fixwise_diagnose_photo', title: 'Diagnose a problem from a photo', scope: 'fixwise.act', ui: 'ui://fixwise/diagnosis',
    description: 'Use when the customer sends a photo of something broken (a leak, a fault, a pothole). Amazon Nova Lite looks at the photo, then Fixwise gives safety steps first, logs any municipal part and returns priced quotes, exactly like fixwise_report_problem. The image is not stored. If the photo is unclear it asks the customer to describe the problem.',
    inputSchema: s({ image_base64: { type: 'string', minLength: 200, maxLength: 2100000, description: 'The photo, base64 encoded (max 1.5 MB).' }, media_type: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp'], maxLength: 12 }, note: { type: 'string', maxLength: 300, description: 'Anything the customer said with the photo.' }, area: { type: 'string', maxLength: 80 } }, ['image_base64', 'media_type']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: 'fixwise_check_status', title: 'Check on an issue', scope: 'fixwise.read', ui: 'ui://fixwise/issue',
    description: 'Use when the customer asks for news or progress ("any news on the geyser?", "is the street light fixed?"). Works across sessions and days.',
    inputSchema: s(issueArg), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'fixwise_list_issues', title: 'List open issues', scope: 'fixwise.read', ui: 'ui://fixwise/issue',
    description: 'Use when the customer asks what is outstanding or open.', inputSchema: s({}), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'fixwise_compare_quotes', title: 'Compare repair quotes', scope: 'fixwise.read', ui: 'ui://fixwise/quotes',
    description: 'Use when the customer wants to hear or see the quotes for a repair. Shows a quote carousel on screen devices.',
    inputSchema: s(issueArg), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'fixwise_book_repair', title: 'Book a repair (asks for confirmation)', scope: 'fixwise.act', ui: 'ui://fixwise/approval',
    description: 'Two steps. Step 1: call with issue and rank or supplier; it holds the exact quote and returns approval_id and a confirmation sentence. Read that sentence and wait for a clear yes. Step 2: only after the customer says yes, call again with approval_id and confirm=true. If they say no, call with confirm=false. If the customer asked for a time ("tomorrow morning", "Saturday after 10"), pass it as time_window in step 1. Never call step 2 without an explicit yes in this conversation.',
    inputSchema: s({ ...issueArg, rank: { type: 'integer', minimum: 1, maximum: 10 }, pick: { type: 'string', enum: ['cheapest', 'fastest', 'best'], maxLength: 10 }, supplier: { type: 'string', maxLength: 80 }, approval_id: { type: 'string', maxLength: 20 }, confirm: { type: 'boolean' }, over_budget_ok: { type: 'boolean' }, time_window: { type: 'string', maxLength: 60 } }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: 'fixwise_cancel_booking', title: 'Cancel a booking', scope: 'fixwise.act',
    description: 'Use when the customer asks to cancel a booked repair. Confirm which one before calling.',
    inputSchema: s(issueArg), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } },
  { name: 'fixwise_close_issue', title: 'Mark an issue fixed', scope: 'fixwise.act',
    description: 'Use when the customer says a problem is sorted.', inputSchema: s(issueArg), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  { name: 'fixwise_remember', title: 'Remember a household preference', scope: 'fixwise.act',
    description: 'Use when the customer states a preference: a budget limit in rand, preferred visit times, their suburb, a supplier to avoid, or any note ("the stopcock is behind the garage").',
    inputSchema: s({ budget_cap_rand: { type: 'number', minimum: 0, maximum: 1000000 }, time_window: { type: 'string', maxLength: 60 }, area: { type: 'string', maxLength: 80 }, avoid_supplier: { type: 'string', maxLength: 80 }, note: { type: 'string', maxLength: 500 } }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  { name: 'fixwise_recall', title: 'Recall household notes', scope: 'fixwise.read',
    description: 'Use when the customer asks what Fixwise remembers, e.g. "where is our stopcock?".',
    inputSchema: s({ query: { type: 'string', maxLength: 200 } }), annotations: { readOnlyHint: true } },
  { name: 'fixwise_activity', title: 'Show the audit trail', scope: 'fixwise.read',
    description: 'Use when the customer asks what Fixwise has done for them. Verifies the tamper-evident chain.', inputSchema: s({}), annotations: { readOnlyHint: true } },
  { name: 'fixwise_disconnect', title: 'Disconnect Fixwise', scope: 'fixwise.act',
    description: 'Revokes this Alexa connection. Confirm with the customer first.', inputSchema: s({}), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
];

export function publicTools() {
  return TOOLS.map(({ name, title, description, inputSchema, annotations, ui }) => ({ name, title, description, inputSchema, annotations,
    ...(ui ? { _meta: { ui: { resourceUri: ui } } } : {}) }));
}

// Minimal JSON-Schema validation for our own schemas (type, required, enum-free, bounds, additionalProperties:false).
export function validateArgs(tool, args) {
  const sc = tool.inputSchema;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  for (const r of sc.required || []) if (args[r] === undefined) return `${r} is required`;
  for (const [k, v] of Object.entries(args)) {
    const p = sc.properties[k]; if (!p) return `unknown argument ${k}`;
    if (p.type === 'string') { if (typeof v !== 'string') return `${k} must be a string`; if (p.enum && !p.enum.includes(v)) return `${k} must be one of ${p.enum.join(', ')}`; if (p.maxLength && v.length > p.maxLength) return `${k} is too long`; if (p.minLength && v.trim().length < p.minLength) return `${k} is too short`; }
    if (p.type === 'integer' && !(Number.isInteger(v) && (p.minimum == null || v >= p.minimum) && (p.maximum == null || v <= p.maximum))) return `${k} must be an integer in range`;
    if (p.type === 'number' && !(typeof v === 'number' && Number.isFinite(v) && (p.minimum == null || v >= p.minimum) && (p.maximum == null || v <= p.maximum))) return `${k} must be a number in range`;
    if (p.type === 'boolean' && typeof v !== 'boolean') return `${k} must be true or false`;
  }
  return null;
}
