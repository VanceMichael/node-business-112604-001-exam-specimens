import { randomUUID } from 'node:crypto';
import { HttpError } from './http-utils.mjs';
import { parseMl, formatMl } from './volume.mjs';

export function newId(state, key, prefix, supplied) {
  if (supplied !== undefined) {
    if (typeof supplied !== 'string' || !/^[\w.\-:]{1,100}$/.test(supplied)) {
      throw new HttpError(422, 'INVALID_ID', '编号需为 1—100 位字母、数字、下划线、点、连字符或冒号');
    }
    return supplied;
  }
  state.seq[key] = (state.seq[key] || 0) + 1;
  return `${prefix}-${state.seq[key]}-${randomUUID().slice(0, 8)}`;
}

export function findOr404(list, id, label) {
  const item = list.find(x => x.id === id);
  if (!item) throw new HttpError(404, `${label.toUpperCase()}_NOT_FOUND`, `${label}不存在：${id}`);
  return item;
}

export function testOr404(catalog, testId) {
  const test = catalog.tests.find(t => t.id === testId);
  if (!test) throw new HttpError(404, 'TEST_NOT_IN_CATALOG', `检查项目不在合成目录：${testId}`);
  return test;
}

export function personOr404(catalog, personId) {
  const person = catalog.people.find(p => p.id === personId);
  if (!person) throw new HttpError(404, 'PERSON_NOT_FOUND', `受检者不存在：${personId}`);
  return person;
}

export function allowedContainers(test) {
  if (Array.isArray(test.allowedContainers)) return test.allowedContainers;
  if (Array.isArray(test.containers)) return test.containers;
  return test.container ? [test.container] : [];
}

export function expiresAt(sample, test) {
  const hours = Number(test.maxHours ?? test.retentionHours ?? 0);
  if (!hours || !Number.isFinite(new Date(sample.collectedAt).getTime())) return null;
  return new Date(new Date(sample.collectedAt).getTime() + hours * 3_600_000).toISOString();
}

export function evaluateSampleForTest(catalog, sample, test, at = new Date()) {
  const errors = [];
  if (sample.personId && test && sample.personId !== undefined) {
    // person consistency is enforced by caller against order person.
  }
  if (sample.sampleType !== test.sampleType) {
    errors.push({ code: 'TYPE_MISMATCH', message: `标本类型应为${test.sampleType}，实际为${sample.sampleType}` });
  }
  const containers = allowedContainers(test);
  if (containers.length && !containers.includes(sample.container)) {
    errors.push({ code: 'CONTAINER_NOT_ALLOWED', message: `容器${sample.container}不允许，允许：${containers.join('、')}` });
  }
  if (parseMl(sample.actualMl) < parseMl(test.minMl)) {
    errors.push({ code: 'VOLUME_BELOW_MIN', message: `实际量${sample.actualMl}ml低于最低用量${test.minMl}ml` });
  }
  const missingConditions = (test.conditions || []).filter(c => !(sample.conditions || []).includes(c));
  if (missingConditions.length) {
    errors.push({ code: 'CONDITION_NOT_RECORDED', message: `缺少采集条件：${missingConditions.join('、')}`, missingConditions });
  }
  const expiry = expiresAt(sample, test);
  if (expiry && at && new Date(at).getTime() > new Date(expiry).getTime()) {
    errors.push({ code: 'EXPIRED', message: `已超过${test.maxHours}小时适用期限（${expiry}）`, expiresAt: expiry });
  }
  return { eligible: errors.length === 0, errors, expiresAt: expiry };
}

const ACTIVE_ALLOCATION = new Set(['reserved', 'aliquoted', 'commissioned', 'received', 'testing', 'completed', 'consumed']);

export function volumeView(state, sampleId) {
  const sample = findOr404(state.samples, sampleId, '标本');
  const total = parseMl(sample.actualMl);
  const consumed = parseMl(sample.consumedMl || '0.0');
  let aliquoted = 0n;
  for (const child of state.samples.filter(s => s.parentSampleId === sampleId)) {
    aliquoted += parseMl(child.actualMl);
  }
  let occupied = 0n;
  for (const a of state.allocations) {
    if (a.sampleId === sampleId && !a.released && ACTIVE_ALLOCATION.has(a.status)) {
      occupied += parseMl(a.amountMl);
    }
  }
  const available = total - aliquoted - occupied - consumed;
  return {
    sampleId,
    actualMl: formatMl(total),
    consumedMl: formatMl(consumed),
    aliquotedMl: formatMl(aliquoted),
    occupiedMl: formatMl(occupied),
    availableMl: formatMl(available < 0n ? 0n : available),
    negativeMl: available < 0n ? formatMl(-available) : '0.0'
  };
}

export function descendantSampleIds(state, rootId) {
  const result = [];
  const queue = [rootId];
  while (queue.length) {
    const parent = queue.shift();
    for (const child of state.samples.filter(s => s.parentSampleId === parent)) {
      result.push(child.id);
      queue.push(child.id);
    }
  }
  return result;
}

export function lineageSampleIds(state, sampleId) {
  const ids = new Set([sampleId, ...descendantSampleIds(state, sampleId)]);
  let current = state.samples.find(s => s.id === sampleId);
  while (current?.parentSampleId) {
    ids.add(current.parentSampleId);
    current = state.samples.find(s => s.id === current.parentSampleId);
  }
  return [...ids];
}

export function activeQualityHold(state, sampleId) {
  let current = state.samples.find(s => s.id === sampleId);
  const chain = [];
  while (current) {
    chain.push(current.id);
    const issue = state.qualityIssues.find(q => q.sampleId === current.id && q.status === 'open');
    if (issue) return { issue, viaSampleId: current.id, chain };
    current = current.parentSampleId ? state.samples.find(s => s.id === current.parentSampleId) : null;
  }
  return null;
}

export function resultQualityBlock(state, result) {
  const hold = activeQualityHold(state, result.sampleId);
  if (!hold) return null;
  const exempt = state.qualityReviews.some(r =>
    r.type === 'exemption' &&
    r.resultId === result.id &&
    ['release', 'release_result'].includes(r.decision) &&
    r.status === 'effective'
  );
  return exempt ? null : hold;
}

export function latestAssessment(state, sampleId, testId) {
  return state.assessments
    .filter(a => a.sampleId === sampleId && a.testId === testId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
}

export function applicableAssessment(state, sampleId, testId) {
  const candidates = [];
  let current = state.samples.find(s => s.id === sampleId);
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    candidates.push(...state.assessments.filter(a => a.sampleId === current.id && a.testId === testId));
    current = current.parentSampleId ? state.samples.find(s => s.id === current.parentSampleId) : null;
  }
  return candidates.sort((a, b) => String(b.confirmedAt || b.createdAt).localeCompare(String(a.confirmedAt || a.createdAt)))[0] || null;
}

export function activeConsentForItem(state, itemId) {
  return state.consents
    .filter(c => c.orderItemId === itemId && c.status === 'active')
    .sort((a, b) => b.version - a.version)[0] || null;
}

export function activeAllocationForItem(state, itemId) {
  return state.allocations.find(a => a.orderItemId === itemId && !a.released && !a.supersededByRetest) || null;
}

export function blockingCommissionForItem(state, itemId) {
  const blocking = new Set(['created', 'dispatch_pending', 'dispatch_unknown', 'dispatch_failed', 'sent', 'received', 'testing', 'cancel_pending']);
  return state.commissions
    .filter(c => c.orderItemId === itemId && blocking.has(c.status))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
}

export function itemCommissions(state, itemId) {
  return state.commissions.filter(c => c.orderItemId === itemId);
}

export function publicItem(state, item) {
  return { ...item };
}

const STATUS_LABELS = {
  pending_consent: '待受检者知情同意',
  approved: '已获准，待安排标本',
  waiting_specimen: '已获准，正在等足够/可用标本',
  reserved: '已获准，剩余标本量已占用',
  aliquoted: '已分装子管',
  commissioned: '已建立检验委托',
  dispatch_unknown: '外送发出结果待核实',
  sent: '已送出/待接收',
  received: '外送方已接收',
  testing: '对方已开检',
  resulted: '已有检验结果',
  delivered: '结果已交付',
  consent_withdrawn: '同意已撤回',
  canceled: '已取消',
  refund_pending: '退款处理中',
  refunded: '已退款',
  recollection_refused: '受检者拒绝补采'
};

export function labelStatus(status) {
  return STATUS_LABELS[status] || status;
}

export function orderOverview(state, catalog, personId) {
  const orders = state.orders.filter(o => o.personId === personId);
  const items = state.items.filter(i => i.personId === personId);
  const approved = [];
  const waitingSpecimen = [];
  const actuallyTested = [];
  for (const item of items) {
    const consent = activeConsentForItem(state, item.id);
    const allocation = activeAllocationForItem(state, item.id);
    const commissions = itemCommissions(state, item.id);
    const results = state.results.filter(r => r.orderItemId === item.id);
    const tested = commissions.some(c => ['testing', 'completed', 'resulted'].includes(c.status) || c.facts?.some?.(f => f.status === 'testing' || f.normalizedStatus === 'testing'))
      || results.length > 0;
    const authorized = consent?.status === 'active' || item.packageAuthorized === true;
    const terminal = ['canceled', 'consent_withdrawn', 'refunded'].includes(item.status);
    const deliveries = state.deliveries.filter(d => d.orderItemId === item.id);
    const view = {
      ...item,
      statusLabel: labelStatus(item.status),
      consent: consent ? { id: consent.id, status: consent.status, agreedAmountMinor: consent.agreedAmountMinor, scope: consent.scope } : null,
      allocation: allocation ? { id: allocation.id, sampleId: allocation.sampleId, amountMl: allocation.amountMl, status: allocation.status } : null,
      commissions: commissions.map(c => ({ id: c.id, externalCommissionId: c.externalCommissionId, sampleId: c.sampleId, status: c.status, destination: c.destination, outboundRequestId: c.outboundRequestId })),
      resultVersions: results.map(r => ({ id: r.id, revision: r.revision, sampleId: r.sampleId, status: r.status, createdAt: r.createdAt })),
      delivered: deliveries.length > 0,
      deliveryCount: deliveries.length
    };
    if (tested) actuallyTested.push(view);
    if (authorized && !terminal && (['waiting_specimen', 'recollection_refused'].includes(item.status) || (!allocation && !tested))) {
      waitingSpecimen.push(view);
    }
    if (authorized && !tested && !terminal) {
      approved.push(view);
    }
  }
  return {
    personId,
    groups: {
      approved: approved.map(x => ({ ...x, statusLabel: labelStatus(x.status) })),
      waitingSpecimen: waitingSpecimen.map(x => ({ ...x, statusLabel: labelStatus(x.status) })),
      actuallyTested: actuallyTested.map(x => ({ ...x, statusLabel: labelStatus(x.status) }))
    },
    orders: orders.map(o => ({ ...o, itemIds: items.filter(i => i.orderId === o.id).map(i => i.id) }))
  };
}
