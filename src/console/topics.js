// Short spoken name for a case, used for context-aware "Any news on the …?" chips.
const RULES = [[/geyser/i, 'geyser'], [/street ?light/i, 'street light'], [/power|electric|outage|load.?shed/i, 'power'], [/pothole|road/i, 'pothole'],
  [/water|burst main|no water|sewer|sewage/i, 'water'], [/tap|pipe|leak|drain|toilet/i, 'leak'], [/refuse|rubbish|bin|waste/i, 'refuse collection']];
export function topicOf(issue) {
  const t = [issue?.title, issue?.category, issue?.home?.title, issue?.case?.title, issue?.summary].filter(Boolean).join(" ");
  for (const [re, name] of RULES) if (re.test(t)) return name;
  return null;
}
// Remember topics of cases that exist in this conversation, most recent first.
export function noteTopics(dialog, sc) {
  const list = [sc?.issue, ...(Array.isArray(sc?.issues) ? sc.issues : [])].filter((x) => x && x.id);
  for (const i of list.reverse()) { const n = topicOf(i); if (n) dialog.topics = [n, ...(dialog.topics || []).filter((x) => x !== n)].slice(0, 4); }
}
// Rewrite chips: "Any news on the X?" only for a case that exists; otherwise point at the latest real case, or drop it.
export function contextChips(chips, topics = []) {
  const out = [];
  for (const c of chips) {
    const m = /^Any news on the (.+)\?$/.exec(c);
    if (!m) { out.push(c); continue; }
    const pick = topics.includes(m[1]) ? m[1] : topics[0];
    if (pick && !out.includes(`Any news on the ${pick}?`)) out.push(`Any news on the ${pick}?`);
  }
  return out;
}
