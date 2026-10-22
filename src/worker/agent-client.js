// Calls the Fixwise advisor agent. Preferred: Strands agent on Bedrock AgentCore Runtime (AGENT_RUNTIME_ARN).
// Fallback: Bedrock Converse (BEDROCK_MODEL_ID). Only issue facts are sent: no names, emails or tokens.
const PROMPT = 'You are Fixwise, a careful South African home-repair advisor. In at most two short sentences, tell the householder what to check or ask the supplier for this issue. Never give electrical or gas work instructions beyond switching off and staying clear. Plain text only.';
export function issueFacts(i) {
  return { summary: i.summary, home: i.home ? { job: i.home.title, bestQuote: i.home.quotes[0] && { supplier: i.home.quotes[0].supplier, totalCents: i.home.quotes[0].totalCents } } : null,
    municipal: i.case ? { title: i.case.title, department: i.case.department, priority: i.case.priority } : null, safetyLevel: i.safety.level };
}
export async function agentAdvice(env, issue) {
  const facts = issueFacts(issue);
  const ac = env.AGENT_RUNTIME_ARN ? await import('@aws-sdk/client-bedrock-agentcore').catch(() => null) : null;
  if (ac) {
    const { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } = ac;
    const c = new BedrockAgentCoreClient({});
    const r = await c.send(new InvokeAgentRuntimeCommand({ agentRuntimeArn: env.AGENT_RUNTIME_ARN, runtimeSessionId: `fixwise-${issue.id}-${'x'.repeat(24)}`.slice(0, 64),
      payload: new TextEncoder().encode(JSON.stringify({ task: 'advise', issue: facts })), contentType: 'application/json', accept: 'application/json' }));
    const text = JSON.parse(await r.response.transformToString()).advice;
    if (text) return { text: String(text).slice(0, 400), spoken: String(text).split(/(?<=\.)\s/)[0].slice(0, 200), source: 'agentcore', at: new Date().toISOString() };
  }
  if (env.BEDROCK_MODEL_ID) {
    const { BedrockRuntimeClient, ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
    const r = await new BedrockRuntimeClient({}).send(new ConverseCommand({ modelId: env.BEDROCK_MODEL_ID, system: [{ text: PROMPT }],
      messages: [{ role: 'user', content: [{ text: JSON.stringify(facts) }] }], inferenceConfig: { maxTokens: 160, temperature: 0.2 } }));
    const text = r.output?.message?.content?.map((c) => c.text).join(' ').trim();
    if (text) return { text: text.slice(0, 400), spoken: text.split(/(?<=\.)\s/)[0].slice(0, 200), source: 'bedrock', at: new Date().toISOString() };
  }
  return null;
}
