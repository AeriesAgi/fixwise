// Safety first: immediate steps spoken before anything else. Fixwise never replaces emergency services.
// Rule set follows CivicOps' responsible-AI rules (vendor/civicops; docs/RESPONSIBLE_AI.md in CivicOps).
const any = (t, ...k) => k.some((x) => t.includes(x));
export const EMERGENCY = 'If anyone is in danger, call 112 from a mobile, 10177 for ambulance or fire, or 10111 for police.';
export function triage(text) {
  const t = text.toLowerCase(); const steps = []; let level = 'routine';
  if (any(t, 'smell gas', 'gas leak', 'smells like gas')) { level = 'emergency'; steps.push('Do not switch anything on or off. Open doors and windows, leave the house, then call the gas emergency line or 10177 from outside.'); }
  if (any(t, 'live wire', 'exposed wire', 'sparking', 'electrocut', 'shock')) { level = 'emergency'; steps.push('Keep everyone at least 10 metres from the wire or sparking point. Do not touch anything it touches.'); }
  if (any(t, 'fire', 'smoke', 'burning smell')) { level = 'emergency'; steps.push('Get everyone out and call 10177. Do not go back inside.'); }
  if (any(t, 'geyser', 'water heater') && any(t, 'leak', 'burst', 'drip', 'flood', 'pour', 'gush', 'spray', 'overflow', 'water coming', 'water everywhere', 'dripping')) { level = level === 'emergency' ? level : 'urgent'; steps.push('Switch the geyser off at the distribution board, then close the cold-water inlet valve on top of the geyser.'); }
  if (any(t, 'burst pipe', 'pipe burst', 'water everywhere', 'flooding inside', 'ceiling leak', 'ceiling is leaking', 'water pouring', 'pouring water', 'gushing')) { level = level === 'emergency' ? level : 'urgent'; steps.push('Close the main water stopcock, usually near the meter at the boundary. Keep people away from wet electrical points.'); }
  if (any(t, 'no power', 'power is off', 'tripped', 'trip switch', 'keeps tripping')) steps.push('If only your house is off, check the earth-leakage switch on the board. If it trips again straight away, leave it off.');
  return { level, steps, emergency: level === 'emergency' ? EMERGENCY : null };
}
