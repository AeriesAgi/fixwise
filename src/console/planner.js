// Turn planner for the simulated Alexa+ console: Amazon Nova Lite on Bedrock (Converse API with tool use) picks which
// Fixwise MCP tools to call and with what arguments, the way Alexa+ reasons over an MCP server's tool catalogue.
// Safety rails stay in code, not the prompt: a booking is only confirmed by a clear yes to a pending approval.
export const DEFAULT_MODEL = 'us.amazon.nova-lite-v1:0';
const EXCLUDED = new Set(['fixwise_disconnect', 'fixwise_diagnose_photo']); // the console handles "disconnect" and photo uploads itself

const SYSTEM = `You are Alexa+ with the Fixwise add-on, for South African households. Decide which Fixwise tools to call for the customer's latest message.
Rules:
- Something broken at home or on the street: call fixwise_report_problem ONCE with the customer's full words as description (it splits compound problems itself). Put a suburb or street in area only if the customer said one.
- If the customer answers a question about where the problem is (a suburb or street), call fixwise_remember with area.
- "compare", "quotes", "how much": fixwise_compare_quotes. "book ...": fixwise_book_repair step 1 with rank, pick (cheapest/fastest) or supplier, and issue words if they named the repair (e.g. "fridge").
- NEVER set confirm or approval_id yourself; confirmations are handled outside you.
- News or progress: fixwise_check_status with issue words. Open items: fixwise_list_issues. What was done: fixwise_activity. Preferences or notes: fixwise_remember. Questions about remembered notes: fixwise_recall. "It's fixed": fixwise_close_issue. Cancel: fixwise_cancel_booking.
- When the customer asks for two things in one message, call both tools in that order. Example: "remember our budget is 2000 rand and compare the fridge quotes" -> fixwise_remember {budget_cap_rand: 2000} then fixwise_compare_quotes {issue: "fridge"}.
- A new problem description is always fixwise_report_problem, even right after quotes or a booking.
- If the message is not about home or street repairs (weather, music, jokes, shopping), do not call a tool. Reply in one short friendly sentence that Fixwise only handles home and street repairs and ask what needs fixing.
- If you genuinely cannot tell what they want, do not call a tool; ask one short clarifying question.`;

export function toBedrockTools(mcpTools) {
  return mcpTools.filter((t) => !EXCLUDED.has(t.name)).map((t) => {
    const props = { ...(t.inputSchema.properties || {}) };
    if (t.name === 'fixwise_book_repair') { delete props.approval_id; delete props.confirm; } // the model cannot confirm a booking
    return { toolSpec: { name: t.name, description: t.description.slice(0, 900), inputSchema: { json: { type: 'object', properties: props, required: t.inputSchema.required || [] } } } };
  });
}

let clientP;
async function defaultBedrock(env) {
  clientP ??= import('@aws-sdk/client-bedrock-runtime').then(({ BedrockRuntimeClient, ConverseCommand }) => {
    const c = new BedrockRuntimeClient({ region: env.BEDROCK_REGION || env.AWS_REGION || 'us-east-1', maxAttempts: 1 });
    return { converse: (input, signal) => c.send(new ConverseCommand(input), { abortSignal: signal }) };
  });
  return clientP;
}

// Returns { calls: [{name,input}], text, ms } or throws (caller falls back to the regex router).
export async function plan(env, { text, dialog, tools }) {
  const bedrock = env.BEDROCK || await defaultBedrock(env);
  const ctxNote = [dialog.awaitingScope ? `Fixwise just asked whether the neighbours are also affected by: "${dialog.awaitingScope.description}". If the customer answers, call fixwise_report_problem with that description and scope area or household.` : '', dialog.awaitingArea ? 'Fixwise just asked the customer which suburb or street the municipal problem is in.' : '',
    dialog.lastTool ? `Previous tool: ${dialog.lastTool}.` : ''].filter(Boolean).join(' ');
  const messages = [...(dialog.hist || []).slice(-4).flatMap((h) => [{ role: 'user', content: [{ text: h.u }] }, { role: 'assistant', content: [{ text: h.a || 'OK.' }] }]),
    { role: 'user', content: [{ text: (ctxNote ? `[context: ${ctxNote}]\n` : '') + text }] }];
  const ac = new AbortController(); const ms = Number(env.PLANNER_TIMEOUT_MS || 3500); const timer = setTimeout(() => ac.abort(), ms);
  const t0 = Date.now();
  try {
    const out = await bedrock.converse({ modelId: env.CONSOLE_MODEL_ID || DEFAULT_MODEL, system: [{ text: SYSTEM }], messages,
      toolConfig: { tools: toBedrockTools(tools), toolChoice: { auto: {} } }, inferenceConfig: { maxTokens: 400, temperature: 0 } }, ac.signal);
    const content = out?.output?.message?.content || [];
    const calls = content.filter((c) => c.toolUse).map((c) => ({ name: c.toolUse.name, input: c.toolUse.input || {} })).slice(0, 3);
    const said = content.filter((c) => c.text).map((c) => c.text).join(' ').replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
    return { calls, text: said, ms: Date.now() - t0, usage: out?.usage };
  } finally { clearTimeout(timer); }
}

// Code-side guard on whatever the model proposes: unknown tools dropped, confirmation fields stripped, schema enforced by the server.
// Side-effecting tools need the customer to have actually asked for that action in this turn.
const INTENT = { fixwise_book_repair: /\b(book|go with|choose|pick|take the|send)\b/i, fixwise_cancel_booking: /\bcancel\b/i, fixwise_close_issue: /\b(fixed|sorted|resolved|close|done)\b/i };
const REMEMBER_ASK = /\b(remember|budget|limit|spend|prefer|avoid|never use|don't use|do not use|i live|we live|we're in|we are in|suburb|area is|mornings?|afternoons?|evenings?|weekends?|note)\b/i;
const GENERIC = /^(the )?(street|road|outside|home|house|here|kitchen|garden|yard|my street|our street|area|suburb)$/i;
export function placeNamed(area, text) { const x = String(area).trim(); return !GENERIC.test(x) && /^[A-Z0-9]/.test(x) && String(text).includes(x); }
export function sanitize(calls, tools, text = '') {
  const names = new Set(tools.map((t) => t.name));
  const out = calls.filter((c) => names.has(c.name) && !EXCLUDED.has(c.name)).map((c) => {
    const a = { ...(c.input && typeof c.input === 'object' ? c.input : {}) };
    if (c.name === 'fixwise_book_repair') { delete a.approval_id; delete a.confirm; }
    for (const [k, v] of Object.entries(a)) if (v === null || v === '') delete a[k];
    // A place must be one the customer actually named ("Parkhurst", "Jan Smuts Avenue"), not "street" or "outside".
    if (c.name === 'fixwise_report_problem' && a.area && !placeNamed(a.area, text)) delete a.area;
    if (c.name === 'fixwise_report_problem' && a.scope && !/\b(neighbou?rs?|whole|everyone|everybody|entire|the area|just (us|me|our)|only (us|me|our)|tripped)\b/i.test(text)) delete a.scope; // the customer must say it, not the model
    if (c.name === 'fixwise_book_repair' && !a.pick && !a.supplier) { const m = /\b(cheapest|fastest|quickest)\b/i.exec(text); if (m) { a.pick = m[1].toLowerCase() === 'quickest' ? 'fastest' : m[1].toLowerCase(); delete a.rank; } }
    return { tool: c.name, args: a };
  }).filter((c) => c.tool !== 'fixwise_remember' || REMEMBER_ASK.test(text)); // the model may not re-save old preferences unasked
  if (out.some((c) => INTENT[c.tool] && !INTENT[c.tool].test(text))) return null; // model overreached: regex router decides
  // One report per turn: the server splits compound problems itself and speaks one combined answer.
  const reports = out.filter((c) => c.tool === 'fixwise_report_problem');
  if (reports.length > 1) {
    const merged = { tool: 'fixwise_report_problem', args: { description: (text.length >= 3 ? text : reports.map((r) => r.args.description).join(' and ')).slice(0, 1000), ...(reports.find((r) => r.args.area) ? { area: reports.find((r) => r.args.area).args.area } : {}) } };
    return [merged, ...out.filter((c) => c.tool !== 'fixwise_report_problem')];
  }
  return out;
}
