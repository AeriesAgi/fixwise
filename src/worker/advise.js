// Advisor: a short "what to ask the plumber / what to check" note for an issue.
// On AWS it runs as a Strands agent on Bedrock AgentCore (agents/fixwise_agent), with a direct Bedrock Converse
// fallback, and finally this deterministic note. The voice path never waits for it.
export function localAdvice(i) {
  const t = (i.home?.code || '') + ' ' + (i.case?.code || '');
  const tips = [];
  if (t.includes('GEYSER')) tips.push('Ask the plumber to confirm the geyser\'s age and whether the leak is from the valve or the tank; a tank leak usually means replacement, which insurers often cover.');
  if (t.includes('PIPE')) tips.push('Take a photo of the leak before the plumber arrives; it helps with insurance.');
  if (t.includes('ELEC')) tips.push('Note which circuit trips and when. Ask for a certificate of compliance if wiring is replaced.');
  if (t.includes('ROOF')) tips.push('Move valuables away from the wet ceiling and put a bucket under any bulge.');
  if (t.includes('STREETLIGHT')) tips.push('Neighbours reporting the same pole helps; the municipality links duplicates to one case.');
  if (!tips.length) tips.push('Keep your reference handy and ask me any time for an update.');
  return { text: tips.join(' '), spoken: tips[0], source: 'deterministic', at: new Date().toISOString() };
}
