// Minimal MCP client for Streamable HTTP (spec 2025-11-25): initialize, notifications/initialized, tools/list, tools/call.
// The console uses it to call the live Fixwise /mcp endpoint over HTTP exactly as Alexa+ or any other MCP host would.
export const CLIENT_PROTOCOL = '2025-11-25';

export class McpHttpClient {
  constructor({ url, token, fetchImpl = globalThis.fetch, timeoutMs = 4000 }) { Object.assign(this, { url, token, fetchImpl, timeoutMs, id: 0, ready: false }); }
  async rpc(method, params, { notify = false } = {}) {
    const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id: ++this.id }) };
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const r = await this.fetchImpl(this.url, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: `Bearer ${this.token}`, ...(this.ready ? { 'mcp-protocol-version': CLIENT_PROTOCOL } : {}) }, body: JSON.stringify(body) });
      if (notify) return null;
      if (!r.ok) throw Object.assign(new Error(`mcp_http_${r.status}`), { status: r.status });
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
      return j.result;
    } finally { clearTimeout(t); }
  }
  async connect() {
    if (this.ready) return this;
    const init = await this.rpc('initialize', { protocolVersion: CLIENT_PROTOCOL, capabilities: {}, clientInfo: { name: 'fixwise-console', version: '1.0.0' } });
    this.ready = true; this.serverInfo = init.serverInfo;
    await this.rpc('notifications/initialized', undefined, { notify: true });
    return this;
  }
  async listTools() { await this.connect(); return (await this.rpc('tools/list', {})).tools; }
  async callTool(name, args) { await this.connect(); return this.rpc('tools/call', { name, arguments: args || {} }); }
}
