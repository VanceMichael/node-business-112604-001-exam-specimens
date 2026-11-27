#!/usr/bin/env node
// 将 data/records.json 中的合成输入按数组顺序映射到正在运行的业务 HTTP 服务。
// 用法：先 npm start，再运行 npm run replay-records。
import { readFile } from 'node:fs/promises';

const base = (process.env.SERVICE_BASE_URL || 'http://127.0.0.1:4100').replace(/\/$/, '');
const recordsFile = new URL('../data/records.json', import.meta.url);
const data = JSON.parse(await readFile(recordsFile, 'utf8'));

async function call(method, route, token, body) {
  const response = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: response.status, body: json };
}

async function waitHealth() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const r = await call('GET', '/health');
      if (r.status === 200) return;
    } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`业务服务不可用：${base}/health；请先运行 npm start`);
}

const itemId = (orderId, testId) => `${orderId}--${testId}`;
const consentId = (orderId, testId) => `consent-${orderId}-${testId}`;
const summary = [];
function note(recordId, action, response) {
  summary.push({ recordId, action, status: response.status, code: response.body?.code || null });
}

await waitHealth();

for (const record of data.records) {
  const p = record.payload || {};
  switch (record.kind) {
    case 'packageOrder': {
      const order = {
        orderId: p.orderId,
        personId: p.personId,
        items: (p.items || []).map(i => ({ itemId: itemId(p.orderId, i.testId), testId: i.testId, amountMinor: i.amountMinor }))
      };
      let r = await call('POST', '/api/orders', 'frontdesk-a', order);
      if (r.status === 409) r = await call('GET', `/api/orders/${p.orderId}`, 'frontdesk-a');
      note(record.recordId, 'packageOrder', r);
      break;
    }
    case 'addTest': {
      const r = await call('POST', `/api/orders/${p.orderId}/items`, 'frontdesk-a', {
        itemId: itemId(p.orderId, p.testId),
        testId: p.testId,
        amountMinor: p.amountMinor ?? 3000,
        requestedSampleId: p.sampleId
      });
      note(record.recordId, 'addTest.quote', r);
      break;
    }
    case 'consent': {
      const orderId = p.orderId || 'order-a';
      const id = consentId(orderId, p.testId);
      const order = await call('GET', `/api/orders/${orderId}`, 'frontdesk-a');
      const item = order.body.items?.find(i => i.testId === p.testId);
      const r = await call('POST', '/api/consents', p.personId, {
        consentId: id,
        orderItemId: item?.id || itemId(orderId, p.testId),
        agreedAmountMinor: item?.quotedAmountMinor ?? p.amountMinor ?? (p.testId === 'test-b' ? 3000 : 2000),
        allowRemainingSample: p.allowRemainingSample !== false,
        allowReconfirm: true
      });
      note(record.recordId, 'consent', r);
      break;
    }
    case 'sample': {
      // tube-a 的完整采集事实已由服务从 data/catalog.json 种子化。
      const r = await call('GET', `/api/samples/${p.sampleId}`, 'inspector-a');
      note(record.recordId, 'sample.catalog-seed', r);
      break;
    }
    case 'aliquot': {
      const existing = await call('GET', `/api/samples/${p.sampleId}`, 'inspector-a');
      if (existing.status === 200) {
        note(record.recordId, 'aliquot.already-exists', existing);
        break;
      }
      const orderId = p.orderId || 'order-a';
      const r = await call('POST', `/api/samples/${p.parentSampleId}/aliquots`, 'collector-a', {
        sampleId: p.sampleId,
        orderItemId: itemId(orderId, p.testId || 'test-b'),
        actualMl: p.ml,
        testId: p.testId
      });
      note(record.recordId, 'aliquot', r);
      break;
    }
    case 'commissionAccepted': {
      const orderId = p.orderId || 'order-a';
      await call('POST', `/api/samples/${p.sampleId}/usability`, 'inspector-a', {
        testId: p.testId,
        usable: true,
        applicableConditionsConfirmed: true,
        at: '2026-11-26T09:20:00+08:00'
      });
      let r = await call('POST', '/api/commissions', 'frontdesk-a', {
        commissionId: p.commissionId,
        orderItemId: itemId(orderId, p.testId),
        sampleId: p.sampleId,
        destination: 'external',
        labId: 'lab-a',
        requestId: p.requestId,
        at: '2026-11-26T09:30:00+08:00'
      });
      note(record.recordId, 'commission.create-or-dispatch', r);
      r = await call('POST', `/external/commissions/${p.commissionId}/receipt`, 'lab-a', {
        status: p.status || 'received',
        commissionId: p.commissionId,
        sampleId: p.sampleId,
        testId: p.testId,
        occurredAt: p.occurredAt || '2026-11-26T09:40:00+08:00'
      });
      note(record.recordId, 'commissionAccepted.receipt', r);
      break;
    }
    case 'consentWithdraw': {
      const orderId = p.orderId || 'order-a';
      const r = await call('POST', `/api/consents/${consentId(orderId, p.testId)}/withdraw`, p.personId, { reason: 'records.json 输入的撤回事实' });
      note(record.recordId, 'consentWithdraw', r);
      break;
    }
    case 'labFact': {
      const r = await call('POST', `/external/commissions/${p.commissionId}/receipt`, 'lab-a', p);
      note(record.recordId, `labFact.${p.status}`, r);
      break;
    }
    case 'qualityHold': {
      const r = await call('POST', '/api/quality/issues', p.reviewer || 'quality-a', {
        issueId: `qi-${p.sampleId}`,
        sampleId: p.sampleId,
        kind: 'contamination',
        reason: p.reason
      });
      note(record.recordId, 'qualityHold', r);
      break;
    }
    default:
      summary.push({ recordId: record.recordId, action: 'ignored-unknown-kind' });
  }
}

console.log(JSON.stringify({ replayed: data.records.length, base, summary }, null, 2));
const failed = summary.filter(x => x.status >= 500);
if (failed.length) process.exit(1);
