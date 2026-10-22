// Key-value store with TTL. MemoryKV for local/dev/tests, DynamoKV for AWS (table: pk string, ttl number).
// incr() is atomic on DynamoDB (UpdateItem ADD), so counters used for rate limits and ceilings can't be raced.
// A minimal key-value surface (get/put/delete with TTL) so the same code runs on DynamoDB in Lambda and in memory for tests.
export class MemoryKV {
  constructor() { this.m = new Map(); }
  async get(k) { const e = this.m.get(k); if (!e) return null; if (e.exp && e.exp < Date.now()) { this.m.delete(k); return null; } return e.v; }
  async put(k, v, opts = {}) { this.m.set(k, { v: String(v), exp: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0 }); }
  async delete(k) { this.m.delete(k); }
  async incr(k, ttl) { const n = Number((await this.get(k)) || 0) + 1; const e = this.m.get(k); this.m.set(k, { v: String(n), exp: e?.exp || Date.now() + ttl * 1000 }); return n; }
}

export class DynamoKV {
  constructor(table, client) { this.table = table; this.client = client; }
  static async create(table) {
    const { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand, UpdateItemCommand } = await import('@aws-sdk/client-dynamodb');
    const kv = new DynamoKV(table, new DynamoDBClient({}));
    kv.cmd = { GetItemCommand, PutItemCommand, DeleteItemCommand, UpdateItemCommand };
    return kv;
  }
  async get(k) {
    const r = await this.client.send(new this.cmd.GetItemCommand({ TableName: this.table, Key: { pk: { S: k } }, ConsistentRead: true }));
    const it = r.Item; if (!it) return null;
    if (it.ttl && Number(it.ttl.N) < Math.floor(Date.now() / 1000)) return null;
    return it.v.S;
  }
  async put(k, v, opts = {}) {
    const Item = { pk: { S: k }, v: { S: String(v) } };
    if (opts.expirationTtl) Item.ttl = { N: String(Math.floor(Date.now() / 1000) + opts.expirationTtl) };
    await this.client.send(new this.cmd.PutItemCommand({ TableName: this.table, Item }));
  }
  async delete(k) { await this.client.send(new this.cmd.DeleteItemCommand({ TableName: this.table, Key: { pk: { S: k } } })); }
  // Counter item: attribute n (number). The ttl is set only on the first increment, so the window is fixed.
  async incr(k, ttl) {
    const r = await this.client.send(new this.cmd.UpdateItemCommand({ TableName: this.table, Key: { pk: { S: k } }, UpdateExpression: 'ADD n :one SET #t = if_not_exists(#t, :ttl)',
      ExpressionAttributeNames: { '#t': 'ttl' }, ExpressionAttributeValues: { ':one': { N: '1' }, ':ttl': { N: String(Math.floor(Date.now() / 1000) + ttl) } }, ReturnValues: 'UPDATED_NEW' }));
    return Number(r.Attributes.n.N);
  }
}
