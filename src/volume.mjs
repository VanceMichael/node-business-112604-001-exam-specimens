const SCALE = 1_000_000n;

export function parseMl(value) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const error = new Error('体积必须是非负十进制字符串');
    error.code = 'INVALID_ML';
    throw error;
  }
  const text = value.trim();
  const [whole, fraction = ''] = text.split('.');
  const frac = (fraction + '000000').slice(0, 6);
  return BigInt(whole) * SCALE + BigInt(frac);
}

export function formatMl(units) {
  const whole = units / SCALE;
  const frac = (units % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}.0`;
}

export function ml(value) {
  return formatMl(parseMl(value));
}

export function compareMl(a, b) {
  const x = parseMl(a);
  const y = parseMl(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
