export class PeerClient {
  constructor({ baseUrl = process.env.PEER_BASE_URL || 'http://127.0.0.1:4300', key = process.env.PEER_KEY || 'local-synthetic-peer', fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.key = key;
    this.fetch = fetchImpl;
  }

  headers(extra = {}) {
    return { 'content-type': 'application/json', 'x-peer-key': this.key, ...extra };
  }

  async operation(name, body) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/operations/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body)
      });
    } catch (cause) {
      const error = new Error(`无法得到${name}联调端响应：${cause?.message || cause}`);
      error.code = 'PEER_NO_HTTP_RESPONSE';
      error.cause = cause;
      error.acceptedUnknown = true;
      throw error;
    }
    const text = await response.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!response.ok) {
      const error = new Error(json.error || `联调端${name}返回 ${response.status}`);
      error.code = json.code || 'PEER_REJECTED';
      error.status = response.status;
      error.body = json;
      throw error;
    }
    return json;
  }

  async request(requestId) {
    const response = await this.fetch(`${this.baseUrl}/requests/${encodeURIComponent(requestId)}`, {
      headers: { 'x-peer-key': this.key }
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`查询联调流水失败：${response.status}`);
    return response.json();
  }
}
