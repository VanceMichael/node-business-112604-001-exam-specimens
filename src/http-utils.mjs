export class HttpError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function sendJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

export function sendError(res, error) {
  if (!(error instanceof HttpError)) console.error('[unhandled]', error);
  if (error instanceof HttpError) {
    return sendJson(res, error.status, {
      error: error.message,
      code: error.code,
      ...(error.details ? { details: error.details } : {})
    });
  }
  const status = error instanceof SyntaxError ? 400 : 500;
  return sendJson(res, status, {
    error: error instanceof SyntaxError ? 'JSON 请求格式无效' : (error?.message || '服务处理失败'),
    code: error instanceof SyntaxError ? 'INVALID_JSON' : 'INTERNAL_ERROR'
  });
}

export async function readBody(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 2_000_000) throw new HttpError(413, 'BODY_TOO_LARGE', '请求体过大');
  }
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new HttpError(400, 'INVALID_BODY', '请求体必须是 JSON 对象');
    }
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new SyntaxError('invalid JSON');
  }
}

export function requireString(value, field, max = 120) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(422, 'FIELD_REQUIRED', `${field} 必须是非空字符串`, { field });
  }
  const text = value.trim();
  if (text.length > max) throw new HttpError(422, 'FIELD_TOO_LONG', `${field} 过长`, { field, max });
  return text;
}

export function optionalString(value, field, max = 500) {
  if (value === undefined || value === null || value === '') return undefined;
  return requireString(value, field, max);
}

export function requireAmount(value, field = 'amountMinor') {
  if (!Number.isInteger(value) || value < 0 || value > 10_000_000_000) {
    throw new HttpError(422, 'INVALID_AMOUNT', `${field} 必须是不超过 10000000000 的非负整数（分）`, { field });
  }
  return value;
}
