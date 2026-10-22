// Fast deterministic router for the simulated Alexa+ console. Nova Lite (planner.js) is the primary planner; this runs
// when Bedrock is off, slow or failing, and always decides yes/no on a pending booking (a model never confirms a purchase).
const ORD = { first: 1, one: 1, '1': 1, second: 2, two: 2, '2': 2, third: 3, three: 3, '3': 3, cheapest: 'cheapest', fastest: 'fastest' };
const has = (t, ...r) => r.some((x) => x.test(t));

export function route(utterance, dialog = {}) {
  const t = ' ' + String(utterance).toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ') + ' ';
  if (dialog.pendingApproval) {
    if (has(t, /\b(yes|yeah|yep|sure|go ahead|book it|do it|confirm|please do)\b/)) return { tool: 'fixwise_book_repair', args: { approval_id: dialog.pendingApproval, confirm: true } };
    if (has(t, /\b(no|nope|don't|do not|not now|wait|hold off)\b/)) return { tool: 'fixwise_book_repair', args: { approval_id: dialog.pendingApproval, confirm: false } };
  }
  if (dialog.awaitingArea && !has(t, /\b(book|compare|quotes?|status|news|cancel|remember|leak|broken|burst|fixed|open)\b/) && t.trim().split(' ').length <= 6) {
    const a = t.trim().replace(/^(it'?s |it is |we'?re |we are |the |in |on |at )+/g, '').replace(/\b\w/g, (c) => c.toUpperCase());
    if (a.length >= 3) return { tool: 'fixwise_remember', args: { area: a.slice(0, 80) } };
  }
  if (has(t, /\b(weather|forecast|play (some )?music|a song|joke|news headlines|recipe|what time is it|traffic report)\b/)) return { outOfScope: true };
  if (has(t, /book (it )?anyway/)) return { tool: 'fixwise_book_repair', args: { rank: dialog.lastRank || 1, over_budget_ok: true } };
  const book = /\bbook\b(?: (?:the|number|option))? ?(first|second|third|one|two|three|1|2|3|cheapest|fastest)?(?: one)?(?: with ([a-z ]+?))? $/.exec(t) || (/\bbook\b/.test(t) && !/cancel/.test(t) ? [] : null);
  if (book) {
    const pick = ORD[book[1]]; const args = {};
    if (typeof pick === 'number') args.rank = pick; else if (pick) args.pick = pick;
    if (book[2]) args.supplier = book[2].trim();
    const ih = issueHint(t); if (ih.issue) args.issue = ih.issue;
    return { tool: 'fixwise_book_repair', args };
  }
  if (has(t, /cancel (the |my )?(booking|plumber|electrician|appointment)/)) return { tool: 'fixwise_cancel_booking', args: {} };
  if (has(t, /\b(compare|quotes?|options|prices?|how much)\b/)) return { tool: 'fixwise_compare_quotes', args: {} };
  if (has(t, /\b(any news|status|update|progress|how's|how is|is the .* fixed|what's happening)\b/)) return { tool: 'fixwise_check_status', args: issueHint(t) };
  if (has(t, /\b(what's open|what is open|outstanding|open issues|list)\b/)) return { tool: 'fixwise_list_issues', args: {} };
  if (has(t, /\b(what have you done|activity|audit|history)\b/)) return { tool: 'fixwise_activity', args: {} };
  if (has(t, /\b(it's fixed|is fixed now|all sorted|sorted now|mark .* fixed)\b/)) return { tool: 'fixwise_close_issue', args: issueHint(t) };
  if (has(t, /\b(disconnect|unlink)\b/)) return { tool: 'fixwise_disconnect', args: {} };
  const rem = remember(t); if (rem) return { tool: 'fixwise_remember', args: rem };
  if (has(t, /\b(where is|where's|what do you remember|remind me)\b/)) return { tool: 'fixwise_recall', args: { query: utterance.slice(0, 200) } };
  if (t.trim().length < 3 || has(t, /^ (hi|hello|hey|help|what can you do) $/)) return { help: true };
  return { tool: 'fixwise_report_problem', args: { description: String(utterance).slice(0, 1000) } };
}

function issueHint(t) { const m = /\b(geyser|pipe|leak|street ?light|pothole|power|roof|drain|gate|water|fridge|freezer|washing machine|dishwasher|oven|stove|tap|appliance)\b/.exec(t); return m ? { issue: m[1].replace(' ', '') === 'streetlight' ? 'street' : m[1] } : {}; }
export function rememberArgs(utterance) { return remember(' ' + String(utterance).toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ') + ' '); }
function remember(t) {
  const a = {};
  const b = /(?:budget|limit|spend|keep it under|no more than)[^0-9]*([0-9][0-9 ,]*)/.exec(t); if (b) a.budget_cap_rand = Number(b[1].replace(/[ ,]/g, ''));
  const w = /\b(?:prefer|only|visits?)\b.*?\b(mornings?|afternoons?|evenings?|weekends?|weekdays?)\b/.exec(t); if (w) a.time_window = w[1].endsWith('s') ? w[1] : w[1] + 's';
  const ar = /\b(?:i live in|we live in|we're in|we are in|my suburb is|our area is)\s+([a-z ]{3,40}?)\s*$/.exec(t); if (ar) a.area = ar[1].replace(/\b\w/g, (c) => c.toUpperCase());
  const av = /\b(?:don't use|never use|avoid)\s+([a-z ]{3,40}?)\s*$/.exec(t); if (av) a.avoid_supplier = av[1].trim();
  const n = /\bremember (?:that )?(.{4,300})$/.exec(t); if (n && !Object.keys(a).length) a.note = n[1].trim();
  return Object.keys(a).length ? a : null;
}
