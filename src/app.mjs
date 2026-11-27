import { principalFor, requireAuth, requireRoles, requireCenter, assertOwnPerson } from './auth.mjs';
import { HttpError, sendJson, sendError, readBody, requireString, optionalString, requireAmount } from './http-utils.mjs';
import {
  newId, findOr404, testOr404, personOr404, evaluateSampleForTest,
  volumeView, descendantSampleIds, activeQualityHold, resultQualityBlock,
  latestAssessment, applicableAssessment, activeConsentForItem, activeAllocationForItem,
  blockingCommissionForItem, itemCommissions, orderOverview, labelStatus
} from './domain-helpers.mjs';
import { parseMl, formatMl } from './volume.mjs';

const PEER_KEY = process.env.PEER_KEY || 'local-synthetic-peer';

function idempotent(state, body, prefix) {
  if (!body.requestId) return null;
  const key = String(body.requestId);
  const fingerprint = JSON.stringify(body);
  if (state.idempotency[key]) {
    if (state.idempotency[key].fingerprint !== fingerprint) {
      throw new HttpError(409, 'REQUEST_ID_CONFLICT', 'requestId 已用于不同请求');
    }
    return state.idempotency[key].result;
  }
  return { key, fingerprint };
}

function saveIdempotency(state, ide, result) {
  if (ide) state.idempotency[ide.key] = { fingerprint: ide.fingerprint, result, at: new Date().toISOString() };
}

function addAudit(state, actorId, action, entityType, entityId, detail = {}) {
  state.audit.push({ id: newId(state, 'audit', 'audit'), at: new Date().toISOString(), actorId, action, entityType, entityId, ...detail });
}

function scopeOrderForPrincipal(principal, order) {
  if (!order) return;
  if (principal.roles.includes('externalLab')) throw new HttpError(403, 'EXTERNAL_ORDER_FORBIDDEN', '外送检验身份不能读取中心订单全量资料');
  assertOwnPerson(principal, order.personId);
}

function paymentAmountForItem(item) {
  return item.paidAmountMinor ?? item.amountMinor ?? item.quotedAmountMinor ?? 0;
}

async function callPeerQuietly(peer, operation, payload) {
  if (!peer) return { skipped: true };
  return peer.operation(operation, payload);
}

export function createHandler({ store, catalog, peer }) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://service.local');
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const principal = principalFor(req, catalog);
    const ctx = { req, res, url, segments, principal, store, catalog, peer, _body: undefined };
    ctx.getBody = async () => {
      if (ctx._body === undefined) ctx._body = await readBody(req);
      return ctx._body;
    };
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-api-key, x-peer-key');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    try {
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
        return sendJson(res, 200, { ok: true, service: 'exam-specimen-service', time: new Date().toISOString() });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/api')) {
        return sendJson(res, 200, {
          name: '体检加项同意、标本占用、检验委托与报告交付服务',
          entry: {
            health: 'GET /health',
            guide: 'docs/HTTP服务使用说明.md',
            catalog: 'GET /api/catalog',
            orders: 'POST /api/orders / GET /api/orders / GET /api/orders/:id',
            addItems: 'POST /api/orders/:id/items',
            consents: 'POST /api/consents / POST /api/consents/:id/withdraw',
            samples: 'POST /api/samples / POST /api/samples/:id/aliquots / POST /api/samples/:id/usability / GET /api/samples/:id/trace',
            occupy: 'POST /api/order-items/:id/occupy',
            handoffs: 'POST /api/handoffs',
            commissions: 'POST /api/commissions / POST /api/commissions/:id/cancel / POST /api/commissions/:id/reconcile',
            external: 'GET /external/commissions / POST /external/results / POST /external/commissions/:lookup/receipt',
            payments: 'POST /api/payments / POST /api/payments/intents / POST /api/payments/receipts',
            refunds: 'POST /api/refunds / POST /api/refunds/:id/decision / POST /api/refunds/:id/reconcile',
            quality: 'POST /api/quality/issues / POST /api/quality/issues/:id/reviews / GET /api/quality/issues/:id/impact',
            results: 'POST /api/results / POST /api/deliveries',
            overview: 'GET /api/my/overview / GET /api/people/:personId/overview'
          },
          syntheticTokens: ['frontdesk-a', 'collector-a', 'inspector-a', 'quality-a', 'doctor-a', 'admin-a', 'person-a', 'person-b', 'lab-a', 'payment-gateway']
        });
      }
      if (url.pathname.startsWith('/external/')) return await handleExternal(ctx);
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'NOT_FOUND', '路径不存在；真实入口见 GET /');
      if (req.method === 'GET' && segments[1] === 'me') {
        requireAuth(principal);
        return sendJson(res, 200, principal);
      }
      if (req.method === 'POST' && segments[1] === 'auth' && segments[2] === 'session' && segments.length === 3) {
        const body = await ctx.getBody();
        const actorId = body.actorId || body.token || body.personId;
        const knownActor = catalog.actors?.some(a => a.id === actorId);
        const knownPerson = catalog.people.some(p => p.id === actorId);
        if (!knownActor && !knownPerson && !['payment-gateway', 'frontdesk-a', 'inspector-a', 'doctor-a', 'admin-a'].includes(actorId)) {
          throw new HttpError(404, 'UNKNOWN_SYNTHETIC_ACTOR', '合成身份不存在');
        }
        return sendJson(res, 201, { token: actorId, authorizationHeader: `Bearer ${actorId}`, principal: principalFor({ headers: { authorization: `Bearer ${actorId}` } }, catalog) });
      }
      if (req.method === 'GET' && segments[1] === 'catalog') {
        requireAuth(principal);
        if (principal.roles.includes('externalLab')) throw new HttpError(403, 'EXTERNAL_CATALOG_FORBIDDEN', '外送方只能查看已委托项目');
        return sendJson(res, 200, catalog);
      }
      return await handleApi(ctx);
    } catch (error) {
      return sendError(res, error);
    }
  };
}

async function handleApi(ctx) {
  const { req, res, url, segments, principal, store, catalog, peer } = ctx;
  const method = req.method;
  const body = await ctx.getBody();
  const s = store.state;

  // ---------- 订单与加项 ----------
  if (method === 'POST' && segments[1] === 'orders' && segments.length === 2) {
    requireAuth(principal);
    if (principal.roles.includes('subject')) body.personId = principal.personId;
    requireRoles(principal, 'frontdesk', 'admin', 'subject');
    const result = await store.mutate(state => {
      const personId = requireString(body.personId, 'personId');
      personOr404(catalog, personId);
      let rawItems = Array.isArray(body.items) ? body.items : [];
      if (body.packageId && rawItems.length === 0) {
        const pkg = catalog.packages?.find(p => p.id === body.packageId);
        if (!pkg) throw new HttpError(404, 'PACKAGE_NOT_FOUND', `套餐不在目录：${body.packageId}`);
        rawItems = pkg.items;
      }
      if (!Array.isArray(rawItems)) throw new HttpError(422, 'INVALID_ITEMS', 'items 必须是数组');
      const orderId = newId(state, 'order', 'order', body.orderId);
      if (state.orders.some(o => o.id === orderId)) throw new HttpError(409, 'ORDER_EXISTS', 'orderId 已存在');
      const nowIso = new Date().toISOString();
      const order = {
        id: orderId,
        personId,
        packageId: body.packageId || null,
        status: rawItems.length ? 'open' : 'empty_open_for_addons',
        currency: 'CNY',
        totalAmountMinor: 0,
        note: optionalString(body.note, 'note'),
        createdAt: nowIso,
        createdBy: principal.actorId
      };
      state.orders.push(order);
      let total = 0;
      for (const input of rawItems) {
        const test = testOr404(catalog, input.testId);
        const amountMinor = requireAmount(input.amountMinor, 'items[].amountMinor');
        total += amountMinor;
        const item = {
          id: newId(state, 'item', 'item', input.itemId),
          orderId,
          personId,
          testId: test.id,
          kind: input.kind === 'addon' ? 'addon' : 'package',
          amountMinor,
          quotedAmountMinor: amountMinor,
          priceQuote: { amountMinor, currency: 'CNY', quotedAt: nowIso, source: 'order-time-itemized' },
          status: 'approved',
          activeConsentId: null,
          packageAuthorized: true,
          incompleteReason: null,
          createdAt: nowIso
        };
        state.items.push(item);
      }
      order.totalAmountMinor = total;
      order.status = 'open';
      addAudit(state, principal.actorId, 'order.create', 'order', orderId, { personId, itemCount: rawItems.length });
      return { order, items: state.items.filter(i => i.orderId === orderId) };
    });
    return sendJson(res, 201, result);
  }

  if (method === 'GET' && segments[1] === 'orders' && segments.length === 2) {
    requireAuth(principal);
    let orders = s.orders;
    if (principal.roles.includes('subject')) orders = orders.filter(o => o.personId === principal.personId);
    else requireCenter(principal);
    const detailed = orders.map(o => ({ ...o, items: s.items.filter(i => i.orderId === o.id) }));
    return sendJson(res, 200, detailed);
  }

  const orderIdParam = segments[1] === 'orders' && segments[2] ? segments[2] : null;
  if (orderIdParam && method === 'GET' && segments.length === 3) {
    const order = findOr404(s.orders, orderIdParam, '订单');
    scopeOrderForPrincipal(principal, order);
    return sendJson(res, 200, {
      ...order,
      items: s.items.filter(i => i.orderId === order.id).map(i => ({
        ...i,
        consent: activeConsentForItem(s, i.id),
        allocation: activeAllocationForItem(s, i.id),
        commissions: itemCommissions(s, i.id)
      })),
      payments: s.payments.filter(p => p.orderId === order.id),
      refunds: s.refunds.filter(r => r.orderId === order.id)
    });
  }

  if (orderIdParam && method === 'POST' && segments[3] === 'items' && segments.length === 4) {
    requireRoles(principal, 'frontdesk', 'admin', 'doctor');
    const result = await store.mutate(state => {
      const order = findOr404(state.orders, orderIdParam, '订单');
      const test = testOr404(catalog, body.testId);
      const amountMinor = requireAmount(body.amountMinor, 'amountMinor');
      const nowIso = new Date().toISOString();
      const item = {
        id: newId(state, 'item', 'addon', body.itemId),
        orderId: order.id,
        personId: order.personId,
        testId: test.id,
        kind: 'addon',
        amountMinor,
        quotedAmountMinor: amountMinor,
        priceQuote: { amountMinor, currency: 'CNY', quotedAt: nowIso, quotedBy: principal.actorId },
        status: 'pending_consent',
        activeConsentId: null,
        packageAuthorized: false,
        doctorSuggestion: body.doctorId ? { doctorId: requireString(body.doctorId, 'doctorId'), note: optionalString(body.suggestionNote, 'suggestionNote'), at: nowIso } : null,
        incompleteReason: '等待受检者本人确认项目、价格和标本使用范围；医生建议不构成同意',
        createdAt: nowIso
      };
      state.items.push(item);
      addAudit(state, principal.actorId, 'addon.quote', 'orderItem', item.id, { orderId: order.id, testId: test.id });
      return item;
    });
    return sendJson(res, 201, result);
  }

  if (method === 'POST' && segments[1] === 'order-items' && segments[3] === 'doctor-suggestion' && segments.length === 5) {
    requireRoles(principal, 'doctor', 'frontdesk', 'admin');
    const itemId = segments[2];
    const result = await store.mutate(state => {
      const item = findOr404(state.items, itemId, '订单项目');
      item.doctorSuggestion = { doctorId: requireString(body.doctorId || principal.actorId, 'doctorId'), note: requireString(body.note, 'note'), at: new Date().toISOString() };
      addAudit(state, principal.actorId, 'suggestion.recorded_not_consent', 'orderItem', item.id);
      return item;
    });
    return sendJson(res, 200, result);
  }

  if (method === 'POST' && segments[1] === 'consents' && segments.length === 2) {
    requireRoles(principal, 'subject', 'admin');
    if (principal.roles.includes('subject')) body.personId = principal.personId;
    const result = await store.mutate(state => createConsent(state, catalog, body, principal));
    return sendJson(res, 201, result);
  }

  if (method === 'POST' && segments[1] === 'consents' && segments[3] === 'withdraw' && segments.length === 4) {
    const consentId = segments[2];
    const result = await store.mutate(state => {
      const consent = findOr404(state.consents, consentId, '同意记录');
      assertOwnPerson(principal, consent.personId);
      if (consent.status !== 'active') throw new HttpError(409, 'CONSENT_NOT_ACTIVE', '该同意已不是有效状态');
      consent.status = 'withdrawn';
      consent.withdrawnAt = body.at || new Date().toISOString();
      consent.withdrawReason = optionalString(body.reason, 'reason');
      const item = findOr404(state.items, consent.orderItemId, '订单项目');
      if (item.activeConsentId === consent.id) item.activeConsentId = null;
      const hasRunning = !!blockingCommissionForItem(state, item.id);
      if (!hasRunning && !state.results.some(r => r.orderItemId === item.id)) {
        item.status = 'consent_withdrawn';
        item.incompleteReason = '受检者已撤回本项同意；其他项目的有效同意不受影响';
      } else {
        item.consentWithdrawnButExecutionPending = true;
        item.incompleteReason = '同意已撤回，但已有检验委托；能否取消和退款取决于外送方是否已开检';
      }
      addAudit(state, principal.actorId, 'consent.withdraw', 'consent', consent.id, { orderItemId: item.id, hasRunning });
      return { consent, item, blockingCommission: blockingCommissionForItem(state, item.id) };
    });
    return sendJson(res, 200, result);
  }

  if (method === 'POST' && segments[1] === 'order-items' && segments[3] === 'occupy' && segments.length === 4) {
    requireCenter(principal);
    const itemId = segments[2];
    const outcome = await store.mutate(state => occupyItem(state, catalog, itemId, body, principal));
    if (outcome.error) throw new HttpError(outcome.status || 409, outcome.code, outcome.error, outcome.details);
    return sendJson(res, 201, outcome);
  }

  if (method === 'POST' && segments[1] === 'order-items' && segments[3] === 'recollection-decision' && segments.length === 4) {
    const itemId = segments[2];
    const result = await store.mutate(state => {
      const item = findOr404(state.items, itemId, '订单项目');
      assertOwnPerson(principal, item.personId);
      const willing = body.willing === true;
      item.recollectionDecision = { willing, reason: optionalString(body.reason, 'reason'), at: body.at || new Date().toISOString(), by: principal.actorId };
      if (!willing) {
        item.status = 'recollection_refused';
        item.incompleteReason = `受检者拒绝补采：${body.reason || '未说明'}；其他有效结果仍可查询和交付`;
      }
      addAudit(state, principal.actorId, 'recollection.decision', 'orderItem', item.id, { willing });
      return item;
    });
    return sendJson(res, 200, result);
  }

  // __SAMPLE_ROUTES__
  return await handleSampleRoutes(ctx);
}

function createConsent(state, catalog, body, principal) {
  const item = findOr404(state.items, requireString(body.orderItemId, 'orderItemId'), '订单项目');
  const personId = principal.personId || requireString(body.personId, 'personId');
  assertOwnPerson(principal, item.personId);
  if (personId !== item.personId) throw new HttpError(403, 'PERSON_MISMATCH', '只能确认本人的加项');
  if (item.status !== 'pending_consent' && !body.allowReconfirm) {
    throw new HttpError(409, 'ITEM_NOT_AWAITING_CONSENT', `项目当前状态为${item.status}，不能重复确认`);
  }
  const agreedAmountMinor = requireAmount(body.agreedAmountMinor ?? body.amountMinor, 'agreedAmountMinor');
  if (agreedAmountMinor !== item.quotedAmountMinor) {
    throw new HttpError(409, 'QUOTE_CHANGED', '确认价格必须与下单/加项时报价一致；不得在办理时改价', { quotedAmountMinor: item.quotedAmountMinor, agreedAmountMinor });
  }
  const allowRemainingSample = body.allowRemainingSample !== false;
  const allowedSampleIds = Array.isArray(body.allowedSampleIds) ? body.allowedSampleIds.map(String) : null;
  if (allowedSampleIds && !allowRemainingSample) throw new HttpError(422, 'INVALID_SCOPE', '已限定标本时必须允许使用剩余标本');
  const nowIso = body.confirmedAt || new Date().toISOString();
  const previousVersions = state.consents.filter(c => c.orderItemId === item.id).length;
  const consent = {
    id: newId(state, 'consent', 'consent', body.consentId),
    orderItemId: item.id,
    orderId: item.orderId,
    personId: item.personId,
    testId: item.testId,
    version: previousVersions + 1,
    status: 'active',
    agreedAmountMinor,
    scope: {
      useRemainingSample: allowRemainingSample,
      allowedSampleIds,
      requireNewSample: body.requireNewSample === true || allowRemainingSample === false,
      allowAliquot: body.allowAliquot !== false,
      text: optionalString(body.scopeText || body.sampleUseScope, 'scopeText') || (allowRemainingSample ? '可在同意范围内使用现有标本剩余量' : '不使用现有剩余标本，需重新采样')
    },
    confirmedAt: nowIso,
    confirmedBy: principal.actorId,
    source: 'subject_confirmation'
  };
  state.consents.push(consent);
  item.activeConsentId = consent.id;
  item.status = 'approved';
  item.incompleteReason = '已获准，等待足够且适用的标本';
  addAudit(state, principal.actorId, 'consent.grant', 'consent', consent.id, { orderItemId: item.id, amountMinor: agreedAmountMinor });

  let occupation = null;
  if (body.occupySampleId) {
    const outcome = occupyItem(state, catalog, item.id, { sampleId: body.occupySampleId, amountMl: body.amountMl }, principal);
    occupation = outcome;
  }
  return { consent, item, occupation };
}

function occupyItem(state, catalog, itemId, body, principal) {
  const item = findOr404(state.items, itemId, '订单项目');
  const sampleId = requireString(body.sampleId, 'sampleId');
  const sample = findOr404(state.samples, sampleId, '标本');
  const test = testOr404(catalog, item.testId);
  if (sample.personId !== item.personId) throw new HttpError(403, 'SAMPLE_PERSON_MISMATCH', '不能占用另一位受检者的标本');
  const consent = activeConsentForItem(state, item.id);
  const packageAuthorized = item.kind === 'package' && item.packageAuthorized === true;
  if (!consent && !packageAuthorized) throw new HttpError(409, 'CONSENT_REQUIRED', '加项必须先由受检者本人确认');
  if (consent && !consent.scope.useRemainingSample) throw new HttpError(409, 'NEW_SAMPLE_REQUIRED', '同意范围不包含现有剩余标本，必须重新采样');
  if (consent?.scope.allowedSampleIds?.length && !consent.scope.allowedSampleIds.includes(sample.id)) {
    throw new HttpError(403, 'SAMPLE_OUTSIDE_CONSENT', '该标本不在受检者同意的标本使用范围内');
  }
  const hold = activeQualityHold(state, sample.id);
  if (hold) throw new HttpError(409, 'QUALITY_HOLD', `标本链路存在质量暂停：${hold.issue.reason}`, hold);

  const existing = activeAllocationForItem(state, item.id);
  if (existing) {
    if (existing.sampleId === sample.id) return { allocation: existing, volume: volumeView(state, sample.id), idempotent: true };
    throw new HttpError(409, 'ITEM_ALREADY_ALLOCATED', '该项目已占用另一标本；不能项目间借用尚未采到的量');
  }
  const amountMl = body.amountMl || test.minMl;
  if (parseMl(amountMl) < parseMl(test.minMl)) {
    throw new HttpError(422, 'BELOW_MIN_VOLUME', `占用量${amountMl}ml低于最低用量${test.minMl}ml`);
  }
  const volume = volumeView(state, sample.id);
  if (parseMl(volume.availableMl) < parseMl(amountMl)) {
    item.status = 'waiting_specimen';
    item.incompleteReason = `剩余量不足：需要${amountMl}ml，${sample.id}当前可占用${volume.availableMl}ml；不能借用未采集量`;
    return {
      error: item.incompleteReason,
      code: 'INSUFFICIENT_SPECIMEN',
      status: 409,
      details: { requiredMl: amountMl, availableMl: volume.availableMl, volume },
      item
    };
  }
  const allocation = {
    id: newId(state, 'allocation', 'alloc', body.allocationId),
    orderItemId: item.id,
    orderId: item.orderId,
    personId: item.personId,
    testId: item.testId,
    sampleId: sample.id,
    amountMl,
    status: 'reserved',
    released: false,
    usabilityConfirmed: latestAssessment(state, sample.id, item.testId)?.usable === true,
    createdAt: body.at || new Date().toISOString(),
    createdBy: principal.actorId
  };
  state.allocations.push(allocation);
  item.status = 'reserved';
  item.sampleId = sample.id;
  item.allocationId = allocation.id;
  item.incompleteReason = null;
  addAudit(state, principal.actorId, 'specimen.occupy', 'allocation', allocation.id, { sampleId, amountMl });
  return { allocation, volume: volumeView(state, sample.id) };
}

async function handleSampleRoutes(ctx) {
  const { req, res, url, segments, principal, store, catalog } = ctx;
  const method = req.method;
  const body = await ctx.getBody();
  const s = store.state;

  if (method === 'POST' && segments[1] === 'samples' && segments.length === 2) {
    requireRoles(principal, 'collector', 'frontdesk', 'admin');
    const result = await store.mutate(state => {
      const personId = requireString(body.personId, 'personId');
      personOr404(catalog, personId);
      let sampleType = body.sampleType || body.type;
      let container = body.container;
      if (body.testId) {
        const test = testOr404(catalog, body.testId);
        sampleType ||= test.sampleType;
        container ||= test.container;
      }
      sampleType = requireString(sampleType, 'sampleType');
      container = requireString(container, 'container');
      const actualMl = formatMl(parseMl(requireString(body.actualMl || body.ml, 'actualMl')));
      const collectedAt = body.collectedAt || body.at || new Date().toISOString();
      if (Number.isNaN(new Date(collectedAt).getTime())) throw new HttpError(422, 'INVALID_TIME', 'collectedAt 不是有效时间');
      const sample = {
        id: newId(state, 'sample', 'tube', body.sampleId),
        personId,
        sampleType,
        container,
        actualMl,
        collectedAt: new Date(collectedAt).toISOString(),
        conditions: Array.isArray(body.conditions) ? body.conditions.map(String) : [],
        collectorId: principal.actorId === 'frontdesk-a' && body.collectorId ? body.collectorId : principal.actorId,
        collectionNote: optionalString(body.note, 'note'),
        parentSampleId: null,
        rootSampleId: null,
        status: 'collected_pending_usability',
        currentHolderId: principal.actorId,
        custodyLocation: '采样员处',
        createdAt: new Date().toISOString()
      };
      sample.rootSampleId = sample.id;
      state.samples.push(sample);
      state.custodyEvents.push({ id: newId(state, 'custody', 'custody'), sampleId: sample.id, at: sample.collectedAt, type: 'collected', toHolderId: sample.collectorId, location: sample.custodyLocation, actorId: principal.actorId, facts: { container, actualMl, conditions: sample.conditions } });
      addAudit(state, principal.actorId, 'sample.collect', 'sample', sample.id);
      const checks = catalog.tests.filter(t => t.sampleType === sampleType).map(t => ({ testId: t.id, ...evaluateSampleForTest(catalog, sample, t) }));
      return { sample, catalogChecks: checks, volume: volumeView(state, sample.id) };
    });
    return sendJson(res, 201, result);
  }

  if (method === 'GET' && segments[1] === 'samples' && segments.length === 2) {
    requireAuth(principal);
    let samples = s.samples;
    if (principal.roles.includes('subject')) samples = samples.filter(x => x.personId === principal.personId);
    else if (!principal.roles.some(r => ['frontdesk', 'collector', 'inspector', 'quality', 'admin'].includes(r))) throw new HttpError(403, 'FORBIDDEN', '无权读取标本');
    return sendJson(res, 200, samples.map(x => ({ ...x, volume: volumeView(s, x.id) })));
  }

  if (segments[1] === 'samples' && segments[2]) {
    const sample = findOr404(s.samples, segments[2], '标本');
    assertOwnPerson(principal, sample.personId);
    if (method === 'GET' && segments.length === 3) {
      return sendJson(res, 200, { ...sample, volume: volumeView(s, sample.id), descendants: descendantSampleIds(s, sample.id) });
    }
    if (method === 'GET' && segments[3] === 'trace' && segments.length === 4) {
      return sendJson(res, 200, buildTrace(s, sample.id));
    }
    if (method === 'POST' && segments[3] === 'aliquots' && segments.length === 4) {
      requireRoles(principal, 'collector', 'inspector', 'frontdesk', 'admin');
      const result = await store.mutate(state => createAliquot(state, catalog, sample.id, body, principal));
      return sendJson(res, 201, result);
    }
    if (method === 'POST' && segments[3] === 'usability' && segments.length === 4) {
      requireRoles(principal, 'inspector', 'admin');
      const result = await store.mutate(state => recordUsability(state, catalog, sample.id, body, principal));
      return sendJson(res, 200, result);
    }
  }

  if (method === 'POST' && segments[1] === 'handoffs' && segments.length === 2) {
    requireRoles(principal, 'collector', 'inspector', 'frontdesk', 'admin');
    const result = await store.mutate(state => {
      const ids = Array.isArray(body.sampleIds) ? body.sampleIds : [body.sampleId];
      if (!ids.length || ids.some(x => !x)) throw new HttpError(422, 'SAMPLE_REQUIRED', '需要 sampleId 或 sampleIds');
      const toHolderId = requireString(body.toHolderId || body.to, 'toHolderId');
      const events = [];
      for (const id of ids) {
        const sample = findOr404(state.samples, id, '标本');
        sample.currentHolderId = toHolderId;
        sample.custodyLocation = body.location || (toHolderId === 'lab-a' ? '外送检验方' : `交接至${toHolderId}`);
        if (toHolderId === 'inspector-a') sample.status = 'with_inspector';
        state.custodyEvents.push({ id: newId(state, 'custody', 'custody'), sampleId: id, at: body.at || new Date().toISOString(), type: 'handoff', fromHolderId: principal.actorId, toHolderId, location: sample.custodyLocation, note: optionalString(body.note, 'note'), actorId: principal.actorId });
        events.push({ sampleId: id, currentHolderId: toHolderId, location: sample.custodyLocation });
      }
      addAudit(state, principal.actorId, 'handoff', 'sample', ids.join(','), { toHolderId });
      return { handoffs: events };
    });
    return sendJson(res, 201, result);
  }

  if (method === 'GET' && ['people', 'persons', 'subjects'].includes(segments[1]) && segments[3] === 'overview' && segments.length === 4) {
    const personId = segments[2];
    assertOwnPerson(principal, personId);
    personOr404(catalog, personId);
    return sendJson(res, 200, orderOverview(s, catalog, personId));
  }
  if (method === 'GET' && segments[1] === 'my' && segments[2] === 'overview' && segments.length === 3) {
    requireRoles(principal, 'subject');
    return sendJson(res, 200, orderOverview(s, catalog, principal.personId));
  }

  // __COMMISSION_ROUTES__
  return await handleCommissionRoutes(ctx);
}

function createAliquot(state, catalog, parentId, body, principal) {
  const parent = findOr404(state.samples, parentId, '原管标本');
  const actualMl = formatMl(parseMl(requireString(body.actualMl || body.ml, 'actualMl')));
  const itemId = body.orderItemId;
  let allocation = itemId ? activeAllocationForItem(state, itemId) : null;
  if (body.allocationId) allocation = state.allocations.find(a => a.id === body.allocationId && !a.released) || allocation;
  if (allocation && allocation.sampleId !== parentId) throw new HttpError(409, 'ALLOCATION_SAMPLE_MISMATCH', '占用记录不在该原管上');
  const test = allocation ? testOr404(catalog, allocation.testId) : (body.testId ? testOr404(catalog, body.testId) : null);
  if (test && parseMl(actualMl) < parseMl(test.minMl)) throw new HttpError(422, 'ALIQUOT_BELOW_MIN', `子管实际量${actualMl}ml低于${test.minMl}ml`);
  const view = volumeView(state, parentId);
  const linkedHold = allocation && allocation.sampleId === parentId ? parseMl(allocation.amountMl) : 0n;
  const maxAllowed = parseMl(view.availableMl) + linkedHold;
  if (parseMl(actualMl) > maxAllowed) {
    throw new HttpError(409, 'ALIQUOT_VOLUME_EXCEEDED', `分装量超过原管可分出的量；当前可分上限${formatMl(maxAllowed)}ml`, { availableMl: view.availableMl, linkedHoldMl: allocation?.amountMl || '0.0' });
  }
  const container = body.container || parent.container;
  if (test) {
    const allowed = test.allowedContainers || (Array.isArray(test.allowedContainers) ? test.allowedContainers : test.container ? [test.container] : []);
    if (allowed.length && !allowed.includes(container)) throw new HttpError(422, 'CONTAINER_NOT_ALLOWED', '子管容器不在目录允许范围');
  }
  const child = {
    id: newId(state, 'sample', 'child', body.sampleId),
    personId: parent.personId,
    sampleType: parent.sampleType,
    container,
    actualMl,
    collectedAt: parent.collectedAt,
    conditions: [...parent.conditions],
    collectorId: principal.actorId,
    parentSampleId: parent.id,
    rootSampleId: parent.rootSampleId || parent.id,
    sourceSampleId: parent.id,
    status: 'aliquoted',
    currentHolderId: principal.actorId,
    custodyLocation: '分装后子管',
    createdAt: body.at || new Date().toISOString()
  };
  state.samples.push(child);
  if (allocation) {
    allocation.sampleId = child.id;
    allocation.sourceSampleId = parent.id;
    allocation.aliquotSampleId = child.id;
    allocation.status = 'aliquoted';
    const item = state.items.find(i => i.id === allocation.orderItemId);
    if (item) { item.sampleId = child.id; item.status = 'aliquoted'; }
  }
  state.custodyEvents.push({ id: newId(state, 'custody', 'custody'), sampleId: child.id, at: child.createdAt, type: 'aliquot_created', fromHolderId: parent.currentHolderId, toHolderId: principal.actorId, location: child.custodyLocation, actorId: principal.actorId, facts: { parentSampleId: parent.id, actualMl } });
  addAudit(state, principal.actorId, 'sample.aliquot', 'sample', child.id, { parentSampleId: parent.id, actualMl });
  return { child, parentTrace: volumeView(state, parent.id), childVolume: volumeView(state, child.id), allocation };
}

function recordUsability(state, catalog, sampleId, body, principal) {
  const sample = findOr404(state.samples, sampleId, '标本');
  const decisions = Array.isArray(body.decisions) ? body.decisions : [body];
  const saved = [];
  for (const decision of decisions) {
    const test = testOr404(catalog, decision.testId);
    const at = decision.at || body.at || new Date().toISOString();
    const evaluation = evaluateSampleForTest(catalog, sample, test, new Date(at));
    const usable = decision.usable === true;
    if (usable) {
      if (evaluation.errors.length) {
        throw new HttpError(422, 'USABILITY_FACTS_FAIL_CATALOG', '客观条件不满足，不能确认可用于该项目；请登记 unusable 事实', { evaluation });
      }
      if ((test.conditions || []).length && decision.applicableConditionsConfirmed !== true && !decision.conditionsMet) {
        throw new HttpError(422, 'CONDITION_CONFIRMATION_REQUIRED', '检验人员必须明确确认目录要求的采集条件', { requiredConditions: test.conditions });
      }
    } else if (!decision.reason && !optionalString(decision.reason, 'reason')) {
      throw new HttpError(422, 'REASON_REQUIRED', '登记不适用事实时必须说明不能用于哪些项目及原因');
    }
    const assessment = {
      id: newId(state, 'assessment', 'assess'),
      sampleId,
      testId: test.id,
      usable,
      reason: decision.reason || null,
      errors: evaluation.errors,
      expiresAt: evaluation.expiresAt,
      confirmedBy: principal.actorId,
      confirmedAt: new Date(at).toISOString(),
      createdAt: new Date().toISOString()
    };
    state.assessments.push(assessment);
    saved.push(assessment);
    if (!usable) {
      for (const allocation of state.allocations.filter(a => a.sampleId === sampleId && a.testId === test.id && !a.released)) {
        allocation.released = true;
        allocation.status = 'released_unusable';
        allocation.releaseReason = decision.reason;
        const item = state.items.find(i => i.id === allocation.orderItemId);
        if (item) {
          item.status = 'waiting_specimen';
          item.incompleteReason = `检验人员确认标本${sampleId}不能用于${test.id}：${decision.reason}`;
        }
      }
    }
    addAudit(state, principal.actorId, usable ? 'usability.confirm' : 'usability.reject', 'sample', sampleId, { testId: test.id });
  }
  return { assessments: saved };
}

function buildTrace(state, sampleId) {
  const root = findOr404(state.samples, sampleId, '标本');
  const ids = new Set([root.id, ...descendantSampleIds(state, root.id)]);
  let parent = root;
  while (parent.parentSampleId) {
    ids.add(parent.parentSampleId);
    parent = state.samples.find(x => x.id === parent.parentSampleId);
  }
  const sampleIds = [...ids];
  const samples = state.samples.filter(x => sampleIds.includes(x.id));
  const allocations = state.allocations.filter(a => sampleIds.includes(a.sampleId) || sampleIds.includes(a.sourceSampleId));
  const commissions = state.commissions.filter(c => sampleIds.includes(c.sampleId));
  const resultIds = new Set(state.results.filter(r => sampleIds.includes(r.sampleId)).map(r => r.id));
  const orderItemIds = new Set([...allocations.map(a => a.orderItemId), ...commissions.map(c => c.orderItemId)]);
  const results = state.results.filter(r => resultIds.has(r.id));
  const deliveries = state.deliveries.filter(d => resultIds.has(d.resultId));
  const issue = activeQualityHold(state, root.id)?.issue || state.qualityIssues.find(q => sampleIds.includes(q.sampleId));
  return {
    rootSampleId: root.rootSampleId || root.id,
    queriedSampleId: sampleId,
    lineageSampleIds: sampleIds,
    samples: samples.map(x => ({ ...x, volume: volumeView(state, x.id) })),
    custodyEvents: state.custodyEvents.filter(e => sampleIds.includes(e.sampleId)).sort((a, b) => String(a.at).localeCompare(String(b.at))),
    allocations,
    commissions,
    orderItems: state.items.filter(i => orderItemIds.has(i.id)),
    results,
    deliveries,
    notifications: state.notifications.filter(n => deliveries.some(d => d.id === n.deliveryId) || results.some(r => r.id === n.resultId)),
    qualityIssue: issue || null,
    currentWhereabouts: samples.map(x => ({ sampleId: x.id, holder: x.currentHolderId, location: x.custodyLocation, status: x.status }))
  };
}

async function handleCommissionRoutes(ctx) {
  const { req, res, segments, principal, store, catalog, peer } = ctx;
  const method = req.method;
  const body = await ctx.getBody();

  if (method === 'GET' && segments[1] === 'commissions' && segments.length === 2) {
    requireAuth(principal);
    let commissions = store.state.commissions;
    if (principal.roles.includes('subject')) commissions = commissions.filter(c => c.personId === principal.personId);
    else requireCenter(principal);
    if (ctx.url.searchParams.get('orderItemId')) commissions = commissions.filter(c => c.orderItemId === ctx.url.searchParams.get('orderItemId'));
    if (ctx.url.searchParams.get('status')) commissions = commissions.filter(c => c.status === ctx.url.searchParams.get('status'));
    return sendJson(res, 200, commissions);
  }

  if (method === 'GET' && segments[1] === 'commissions' && segments[2] && segments.length === 3) {
    requireAuth(principal);
    const commission = findOr404(store.state.commissions, segments[2], '委托');
    if (principal.roles.includes('subject')) assertOwnPerson(principal, commission.personId);
    else requireCenter(principal);
    return sendJson(res, 200, commission);
  }

  if (method === 'POST' && segments[1] === 'commissions' && segments.length === 2) {
    requireRoles(principal, 'frontdesk', 'inspector', 'admin');
    const created = await store.mutate(state => createCommissionInState(state, catalog, body, principal));
    if (created.idempotent) return sendJson(res, 200, { commission: created.commission, idempotent: true });
    let peerResponse = null;
    if (created.commission.destination === 'external') {
      try {
        peerResponse = await callPeerQuietly(peer, 'commission', created.peerPayload);
        const fact = peerResponse?.result || peerResponse || { status: 'accepted' };
        await store.mutate(state => applyCommissionPeerResult(state, created.commission.id, fact, peerResponse));
      } catch (error) {
        if (error.acceptedUnknown) {
          await store.mutate(state => {
            const c = findOr404(state.commissions, created.commission.id, '委托');
            c.status = 'dispatch_unknown';
            c.dispatchError = error.message;
            const sample = state.samples.find(x => x.id === c.sampleId);
            if (sample) { sample.status = 'external_dispatch_unknown'; sample.currentHolderId = 'external-receiver-unknown'; sample.custodyLocation = '外送接收端可能已收件；HTTP 响应未返回，必须查原流水，不能声称仍在本院或另送一管'; }
            state.custodyEvents.push({ id: newId(state, 'custody', 'custody'), sampleId: c.sampleId, at: new Date().toISOString(), type: 'dispatch_response_unknown', location: sample?.custodyLocation, actorId: 'system', facts: { outboundRequestId: c.outboundRequestId } });
          });
          const commission = store.state.commissions.find(c => c.id === created.commission.id);
          return sendJson(res, 202, { commission, reconcile: `POST /api/commissions/${commission.id}/reconcile`, warning: error.message });
        }
        await store.mutate(state => {
          const c = findOr404(state.commissions, created.commission.id, '委托');
          c.status = 'dispatch_failed';
          c.dispatchError = error.message;
        });
        throw error;
      }
    } else {
      await store.mutate(state => applyCommissionFact(state, created.commission.id, { status: 'received', occurredAt: new Date().toISOString() }, 'internal-auto-received'));
    }
    const commission = store.state.commissions.find(c => c.id === created.commission.id);
    return sendJson(res, 201, { commission, peerResponse });
  }

  if (method === 'POST' && segments[1] === 'commissions' && segments[3] === 'reconcile' && segments.length === 4) {
    requireRoles(principal, 'frontdesk', 'inspector', 'admin');
    const commissionId = segments[2];
    const commission = findOr404(store.state.commissions, commissionId, '委托');
    if (!commission.outboundRequestId) throw new HttpError(422, 'NO_OUTBOUND_REQUEST', '内部委托无需外送流水核对');
    const peerRecord = await peer.request(commission.outboundRequestId);
    if (!peerRecord) throw new HttpError(404, 'PEER_REQUEST_NOT_FOUND', '外送联调端没有原流水；在查明前仍不得另送同项目');
    const fact = peerRecord.result || {};
    const updated = await store.mutate(state => applyCommissionPeerResult(state, commissionId, fact, peerRecord));
    return sendJson(res, 200, { commission: updated, peerRecord });
  }

  if (method === 'POST' && segments[1] === 'commissions' && segments[3] === 'cancel' && segments.length === 4) {
    requireRoles(principal, 'frontdesk', 'inspector', 'admin');
    const commissionId = segments[2];
    const prepared = await store.mutate(state => {
      const c = findOr404(state.commissions, commissionId, '委托');
      if (['cancelled'].includes(c.status)) throw new HttpError(409, 'ALREADY_CANCELLED', '委托已取消');
      c.cancelRequestId = body.cancelRequestId || body.requestId || c.cancelRequestId || `cancel-${c.outboundRequestId || c.id}`;
      c.cancelReason = optionalString(body.reason, 'reason');
      return {
        commission: c,
        peerPayload: c.destination === 'external' ? {
          requestId: c.cancelRequestId,
          operation: 'cancel',
          commissionId: c.externalCommissionId || c.id,
          centralCommissionId: c.id,
          sampleId: c.sampleId,
          testId: c.testId
        } : null
      };
    });

    let cancelFact = { status: 'cancelled', cancelledAt: body.at || new Date().toISOString() };
    let peerRecord = null;
    if (prepared.peerPayload) {
      try {
        peerRecord = await callPeerQuietly(peer, 'cancel', prepared.peerPayload);
        cancelFact = peerRecord.result || peerRecord;
      } catch (error) {
        if (error.acceptedUnknown) {
          const c = await store.mutate(state => {
            const item = findOr404(state.commissions, commissionId, '委托');
            item.cancelStatus = 'unknown';
            item.cancelError = error.message;
            return item;
          });
          return sendJson(res, 202, { commission: c, warning: '取消请求响应未知，必须核对原取消流水', cancelRequestId: c.cancelRequestId });
        }
        throw error;
      }
    }

    const outcome = await store.mutate(state => applyCancelFact(state, commissionId, cancelFact, principal));
    let refund = null;
    if (outcome.cancelOutcome === 'cancelled') {
      const item = findOr404(store.state.items, outcome.commission.orderItemId, '项目');
      if (item.paymentId && paymentAmountForItem(item) > 0 && !store.state.refunds.some(r => r.orderItemId === item.id && ['refunded', 'approved', 'processing'].includes(r.status))) {
        refund = await store.mutate(state => createRefundInState(state, { orderItemId: item.id, reason: '委托取消成功，未执行项目退款', automatic: true, knownChargeMinor: outcome.commission.cancelChargeMinor || 0 }, principal, true));
      }
    }
    let peerRefund = null;
    if (refund?.status === 'approved' && refund.outboundRequestId) {
      try {
        peerRefund = await callPeerQuietly(peer, 'refund', refund.peerPayload);
        const fact = peerRefund.result || peerRefund;
        if (fact.status === 'refunded' || fact.status === 'succeeded') {
          await store.mutate(state => markRefundFromPeer(state, refund.id, fact));
        }
      } catch (error) {
        refund.channelError = error.message;
      }
      refund = store.state.refunds.find(r => r.id === refund.id);
    }
    return sendJson(res, 200, { ...outcome, refund, peerRefund });
  }

  // __PAYMENT_QUALITY_ROUTES__
  return await handlePaymentQualityRoutes(ctx);
}

function createCommissionInState(state, catalog, body, principal) {
  const item = findOr404(state.items, requireString(body.orderItemId, 'orderItemId'), '订单项目');
  if (body.requestId) {
    const sameOutbound = state.commissions.find(c => c.outboundRequestId === body.requestId);
    if (sameOutbound) {
      if (sameOutbound.orderItemId !== item.id || sameOutbound.testId !== item.testId) {
        throw new HttpError(409, 'REQUEST_ID_CONFLICT', 'requestId 已用于不同委托内容');
      }
      return { idempotent: true, commission: sameOutbound };
    }
  }
  if (item.kind === 'addon') {
    const consent = activeConsentForItem(state, item.id);
    if (!consent) throw new HttpError(403, 'CONSENT_WITHDRAWN_OR_MISSING', '加项没有有效本人同意，不能建立检验委托');
  }
  const blocking = blockingCommissionForItem(state, item.id);
  if (blocking) {
    throw new HttpError(409, 'COMMISSION_IN_FLIGHT', '该项目已有未结清委托；外送无响应时必须核对原委托，不能另送一管重复检验', { commission: blocking });
  }
  let allocation = activeAllocationForItem(state, item.id);
  if (body.sampleId && (!allocation || allocation.sampleId !== body.sampleId)) {
    if (allocation && body.retest !== true) {
      throw new HttpError(409, 'REALLOCATION_REQUIRES_RETEST', '项目已有当前标本占用；换新管必须明确 retest=true，并保留旧委托/结果');
    }
    if (allocation && body.retest === true) {
      allocation.supersededByRetest = true;
      allocation.supersededAt = new Date().toISOString();
      allocation.supersedeReason = body.retestReason || '重新采样';
    }
    const outcome = occupyItem(state, catalog, item.id, { sampleId: body.sampleId, amountMl: body.amountMl }, principal);
    if (outcome.error) throw new HttpError(outcome.status || 409, outcome.code, outcome.error, outcome.details);
    allocation = outcome.allocation;
  }
  if (!allocation && body.sampleId) {
    const outcome = occupyItem(state, catalog, item.id, { sampleId: body.sampleId, amountMl: body.amountMl }, principal);
    if (outcome.error) throw new HttpError(outcome.status || 409, outcome.code, outcome.error, outcome.details);
    allocation = outcome.allocation;
  }
  if (!allocation) throw new HttpError(422, 'SPECIMEN_NOT_ALLOCATED', '项目尚未占用标本；请先 occupy 或在委托时提供已获同意的 sampleId');
  const sample = findOr404(state.samples, allocation.sampleId, '标本');
  const test = testOr404(catalog, item.testId);
  const assessment = applicableAssessment(state, sample.id, item.testId);
  if (assessment?.usable === false) throw new HttpError(409, 'SPECIMEN_USABILITY_REJECTED', `检验人员已确认该标本/来源管不能用于本项目：${assessment.reason}`);
  if (assessment?.usable !== true) throw new HttpError(422, 'USABILITY_CONFIRMATION_REQUIRED', '检验人员尚未确认该标本或其来源管适用于本项目');
  const evaluation = evaluateSampleForTest(catalog, sample, test, new Date(body.at || Date.now()));
  if (!evaluation.eligible) throw new HttpError(422, 'SPECIMEN_CONDITIONS_NOT_MET', '标本当前不满足目录适用条件，需登记不适用或重新采样', { evaluation });
  const hold = activeQualityHold(state, sample.id);
  if (hold) throw new HttpError(409, 'QUALITY_HOLD', `标本链路有未解除质量暂停：${hold.issue.reason}`);

  const destination = body.destination === 'internal' ? 'internal' : 'external';
  const labId = destination === 'external' ? (body.labId || 'lab-a') : 'lab-internal';
  if (destination === 'external' && !catalog.actors?.some(a => a.id === labId && (a.role === 'externalLab' || a.roles?.includes('externalLab')))) {
    throw new HttpError(422, 'UNKNOWN_EXTERNAL_LAB', `外送机构未登记：${labId}`);
  }
  const requestId = body.requestId || `comm-req-${newId(state, 'outbound', 'out')}`;
  const commission = {
    id: newId(state, 'commission', 'comm', body.commissionId),
    outboundRequestId: destination === 'external' ? requestId : null,
    orderItemId: item.id,
    orderId: item.orderId,
    personId: item.personId,
    testId: item.testId,
    sampleId: sample.id,
    allocationId: allocation.id,
    destination,
    labId,
    externalCommissionId: body.externalCommissionId || null,
    revision: 0,
    status: destination === 'external' ? 'dispatch_pending' : 'received',
    cancelOutcome: null,
    createdAt: new Date().toISOString(),
    createdBy: principal.actorId,
    events: [{ at: new Date().toISOString(), type: 'created', by: principal.actorId }],
    facts: []
  };
  state.commissions.push(commission);
  allocation.status = 'commissioned';
  item.status = 'commissioned';
  item.incompleteReason = null;
  sample.status = destination === 'external' ? 'external_dispatch_pending' : 'with_internal_lab';
  sample.currentHolderId = labId;
  sample.custodyLocation = destination === 'external' ? '已交接外送；接收结果以原委托流水为准' : '院内检验';
  state.custodyEvents.push({ id: newId(state, 'custody', 'custody'), sampleId: sample.id, at: new Date().toISOString(), type: 'commission_dispatch', toHolderId: labId, location: sample.custodyLocation, actorId: principal.actorId, facts: { commissionId: commission.id, outboundRequestId: commission.outboundRequestId } });
  addAudit(state, principal.actorId, 'commission.create', 'commission', commission.id, { destination, sampleId: sample.id });
  return {
    commission,
    peerPayload: {
      requestId,
      orderId: commission.orderId,
      commissionId: commission.id,
      testId: commission.testId,
      sampleId: commission.sampleId,
      personId: commission.personId
    }
  };
}

function applyCommissionPeerResult(state, commissionId, peerResult, peerRecord) {
  const fact = { ...(peerResult || {}) };
  if (peerRecord?.acceptedAt && !fact.acceptedAt) fact.peerAcceptedAt = peerRecord.acceptedAt;
  return applyCommissionFact(state, commissionId, fact, 'peer-reconcile');
}

function applyCommissionFact(state, commissionId, fact, source = 'external') {
  const commission = findOr404(state.commissions, commissionId, '委托');
  if (fact.commissionId && String(fact.commissionId).startsWith('lab') || fact.externalCommissionId) {
    commission.externalCommissionId = fact.externalCommissionId || fact.commissionId;
  }
  if (fact.commissionId && !commission.externalCommissionId && fact.commissionId !== commission.id) commission.externalCommissionId = fact.commissionId;
  const rawStatus = fact.status || fact.commissionStatus;
  const map = { accepted: 'sent', pending: 'sent', sent: 'sent', received: 'received', receive: 'received', testing: 'testing', started: 'testing', completed: 'completed', done: 'completed', cancelled: 'cancelled', alreadyTesting: 'testing' };
  const status = map[rawStatus] || rawStatus;
  const occurredAt = fact.occurredAt || fact.at || fact.testingAt || fact.completedAt || new Date().toISOString();
  commission.facts.push({ ...fact, status: rawStatus, normalizedStatus: status, source, occurredAt, recordedAt: new Date().toISOString() });
  commission.events.push({ at: new Date().toISOString(), type: `fact_${status}`, source, occurredAt, fact });
  if (['sent', 'received', 'testing', 'completed', 'cancelled'].includes(status)) commission.status = status;
  const sample = state.samples.find(x => x.id === commission.sampleId);
  const item = state.items.find(x => x.id === commission.orderItemId);
  const allocation = state.allocations.find(a => a.id === commission.allocationId);
  if (status === 'received') {
    if (sample) { sample.status = 'external_received'; sample.currentHolderId = commission.labId; sample.custodyLocation = '外送接收端已实际接收'; }
    if (item) item.status = 'received';
    if (allocation) allocation.status = 'received';
  }
  if (status === 'testing') {
    if (sample) { sample.status = 'external_testing'; sample.custodyLocation = '外送方已开检'; }
    if (item) { item.status = 'testing'; item.actualTestingAt = occurredAt; item.incompleteReason = null; }
    if (allocation) allocation.status = 'testing';
  }
  if (status === 'completed') {
    if (item) item.status = 'completed_awaiting_result';
    if (allocation) allocation.status = 'completed';
  }
  if (status === 'cancelled') {
    commission.cancelOutcome = commission.cancelOutcome || 'cancelled';
  }
  return commission;
}

function releaseAllocationUnused(allocation, at, reason) {
  if (!allocation || allocation.released) return allocation;
  const wasAliquoted = allocation.status === 'aliquoted' || !!allocation.aliquotSampleId;
  allocation.released = true;
  allocation.status = wasAliquoted ? 'canceled_aliquot_retained' : 'released_cancelled';
  allocation.releasedAt = at;
  allocation.releaseReason = reason;
  allocation.volumeRestoredToParent = !wasAliquoted;
  if (wasAliquoted) allocation.note = '已分装子管不得通过取消恢复回原管；子管来源和实际量保留';
  return allocation;
}

function applyCancelFact(state, commissionId, fact, principal) {
  const commission = findOr404(state.commissions, commissionId, '委托');
  const status = fact.status || fact.cancelStatus;
  const at = fact.occurredAt || fact.cancelledAt || fact.testingAt || new Date().toISOString();
  commission.facts.push({ ...fact, source: 'cancel', recordedAt: new Date().toISOString() });
  if (status === 'alreadyTesting' || status === 'already_testing') {
    commission.status = 'testing';
    commission.cancelOutcome = 'already_testing';
    commission.testingAt = fact.testingAt || at;
    commission.feeConsequence = {
      refundAllowed: false,
      reason: '外送方已经开检，委托无法撤回；已实际执行部分不能按迟到撤回全额冲销',
      externalChargeMinor: Number(fact.chargeMinor || fact.nonRefundableMinor || 0) || null
    };
    const item = state.items.find(i => i.id === commission.orderItemId);
    if (item) {
      item.status = 'testing';
      item.incompleteReason = '对方已开检，无法撤回；费用按已执行/取消费规则核定';
      item.refundResponsibility = { refundAllowed: false, liableParty: 'subject_or_order_contract', reason: 'late_withdrawal_after_testing_started' };
    }
    addAudit(state, principal.actorId, 'commission.cancel_rejected_testing', 'commission', commission.id);
    return { commission, cancelOutcome: 'already_testing' };
  }
  if (status === 'cancelled' || status === 'cancelled_before_testing') {
    commission.status = 'cancelled';
    commission.cancelOutcome = 'cancelled';
    commission.cancelledAt = at;
    commission.cancelChargeMinor = Number(fact.chargeMinor ?? fact.cancellationFeeMinor ?? 0) || 0;
    const allocation = state.allocations.find(a => a.id === commission.allocationId && !a.released);
    const consumedMlText = fact.consumedMl || fact.usedMl || '0.0';
    if (parseMl(consumedMlText) > 0n) {
      const consumedSample = state.samples.find(x => x.id === (allocation?.sampleId || commission.sampleId));
      if (consumedSample) {
        const nextConsumed = parseMl(consumedSample.consumedMl || '0.0') + parseMl(consumedMlText);
        consumedSample.consumedMl = formatMl(nextConsumed);
      }
      if (allocation) allocation.consumedMl = formatMl(parseMl(consumedMlText));
    }
    if (allocation) releaseAllocationUnused(allocation, at, '委托取消成功；已消耗量不恢复');
    const item = state.items.find(i => i.id === commission.orderItemId);
    if (item) {
      item.status = 'canceled';
      item.incompleteReason = '委托在开检前取消成功；未执行项目按原支付渠道退款';
      item.canceledAt = at;
    }
    addAudit(state, principal.actorId, 'commission.cancelled', 'commission', commission.id);
    return { commission, cancelOutcome: 'cancelled' };
  }
  commission.cancelStatus = status || 'unknown';
  return { commission, cancelOutcome: status || 'unknown' };
}

async function handlePaymentQualityRoutes(ctx) {
  const { req, res, url, segments, principal, store, catalog, peer } = ctx;
  const method = req.method;
  const body = await ctx.getBody();

  // ---------- 支付下单/意向与支付回执 ----------
  if (method === 'POST' && segments[1] === 'payments' && segments.length === 2) {
    requireRoles(principal, 'subject', 'frontdesk', 'admin');
    if (principal.roles.includes('subject')) body.personId = principal.personId;
    const intent = await store.mutate(state => createPaymentIntentInState(state, body, principal));
    let peerResponse = null;
    let payment = null;
    if (body.skipPeer !== true) {
      const requestId = intent.outboundRequestId;
      try {
        peerResponse = await callPeerQuietly(peer, 'pay', {
          requestId,
          orderId: intent.orderId,
          amountMinor: intent.amountMinor,
          currency: intent.currency,
          orderItemIds: intent.orderItemIds
        });
        const fact = peerResponse.result || peerResponse;
        const providerPaymentId = fact.paymentId || fact.providerPaymentId || body.providerPaymentId;
        if (providerPaymentId && body.autoRecordReceipt !== false) {
          payment = await store.mutate(state => recordPaymentReceipt(state, {
            providerPaymentId,
            orderId: intent.orderId,
            orderItemIds: intent.orderItemIds,
            amountMinor: fact.amountMinor ?? intent.amountMinor,
            paidAt: fact.occurredAt || fact.paidAt || new Date().toISOString(),
            status: 'paid',
            channel: 'synthetic-peer'
          }, { actorId: 'payment-gateway', roles: ['paymentGateway'] }));
          intent.status = 'paid';
        }
      } catch (error) {
        intent.channelError = error.message;
        await store.mutate(() => {});
        return sendJson(res, 202, { paymentIntent: store.state.paymentIntents.find(x => x.id === intent.id), warning: '支付渠道响应未知；请以支付回执/原流水核对，不要重复扣款', error: error.message });
      }
    }
    return sendJson(res, 201, { paymentIntent: intent, payment, peerResponse });
  }

  if (method === 'POST' && segments[1] === 'payments' && segments[2] === 'intents' && segments.length === 3) {
    requireRoles(principal, 'subject', 'frontdesk', 'admin');
    if (principal.roles.includes('subject')) body.personId = principal.personId;
    const intent = await store.mutate(state => createPaymentIntentInState(state, body, principal));
    return sendJson(res, 201, intent);
  }

  const paymentReceiptRoute = method === 'POST' && segments.length === 3 && (
    (segments[1] === 'payments' && ['receipts', 'receipt'].includes(segments[2])) ||
    (segments[1] === 'payment' && ['receipts', 'receipt', 'webhook'].includes(segments[2]))
  );
  if (paymentReceiptRoute) {
    requireRoles(principal, 'paymentGateway', 'admin');
    const payment = await store.mutate(state => recordPaymentReceipt(state, body, principal));
    return sendJson(res, 201, payment);
  }

  if (method === 'POST' && segments[1] === 'refunds' && segments.length === 2) {
    if (principal.roles.includes('paymentGateway')) throw new HttpError(403, 'PAYMENT_GATEWAY_SCOPE', '支付回执身份不能替受检者发起退项');
    requireRoles(principal, 'subject', 'frontdesk', 'admin');
    const result = await store.mutate(state => createRefundInState(state, body, principal, body.automatic === true));
    let peerResponse = null;
    if (result.status === 'approved' && result.outboundRequestId && !body.skipPeer) {
      try {
        peerResponse = await callPeerQuietly(peer, 'refund', result.peerPayload);
        const fact = peerResponse.result || peerResponse;
        if (fact.status === 'refunded' || fact.status === 'succeeded') {
          const updated = await store.mutate(state => markRefundFromPeer(state, result.id, fact));
          return sendJson(res, 201, { refund: updated, peerResponse });
        }
      } catch (error) {
        result.channelError = error.message;
      }
    }
    return sendJson(res, 201, { refund: store.state.refunds.find(r => r.id === result.id), peerResponse });
  }

  if (method === 'POST' && segments[1] === 'refunds' && segments[2] === 'receipts' && segments.length === 3) {
    requireRoles(principal, 'paymentGateway', 'admin');
    const refund = await store.mutate(state => {
      const lookup = body.refundId || body.centralRefundId || body.outboundRequestId;
      const refundRecord = state.refunds.find(r => r.id === lookup || r.outboundRequestId === lookup || r.providerRefundId === body.providerRefundId);
      if (!refundRecord) throw new HttpError(404, 'REFUND_NOT_FOUND', '找不到对应退款责任记录');
      return markRefundFromPeer(state, refundRecord.id, body);
    });
    return sendJson(res, 200, refund);
  }

  if (segments[1] === 'refunds' && segments[2] && segments[3] === 'decision' && method === 'POST' && segments.length === 4) {
    requireRoles(principal, 'frontdesk', 'admin');
    const refund = await store.mutate(state => {
      const record = findOr404(state.refunds, segments[2], '退款');
      if (record.status === 'refunded') throw new HttpError(409, 'REFUND_ALREADY_DONE', '退款已完成');
      if (body.approve === false) {
        record.status = 'denied';
        record.decision = { approved: false, reason: requireString(body.reason, 'reason'), by: principal.actorId, at: new Date().toISOString() };
        return record;
      }
      const amountMinor = requireAmount(body.refundAmountMinor ?? body.amountMinor ?? record.responsibleRefundMinor, 'refundAmountMinor');
      if (amountMinor > record.paidAmountMinor) throw new HttpError(422, 'REFUND_EXCEEDS_PAID', '退款不能超过该项目按下单时分摊的已付金额');
      record.responsibleRefundMinor = amountMinor;
      record.retainedMinor = record.paidAmountMinor - amountMinor;
      record.status = 'approved';
      record.outboundRequestId = record.outboundRequestId || `refund-req-${newId(state, 'refundOut', 'rfo')}`;
      record.peerPayload = { requestId: record.outboundRequestId, refundId: record.id, paymentId: record.originalPaymentId, amountMinor, orderId: record.orderId, orderItemId: record.orderItemId };
      record.decision = { approved: true, amountMinor, executedChargeMinor: body.executedChargeMinor ?? record.retainedMinor, reason: optionalString(body.reason, 'reason'), by: principal.actorId, at: new Date().toISOString() };
      return record;
    });
    let peerResponse = null;
    if (refund.status === 'approved' && !body.skipPeer) {
      peerResponse = await callPeerQuietly(peer, 'refund', refund.peerPayload);
      const fact = peerResponse.result || peerResponse;
      if (fact.status === 'refunded' || fact.status === 'succeeded') {
        const updated = await store.mutate(state => markRefundFromPeer(state, refund.id, fact));
        return sendJson(res, 200, { refund: updated, peerResponse });
      }
    }
    return sendJson(res, 200, { refund: store.state.refunds.find(r => r.id === refund.id), peerResponse });
  }

  if (segments[1] === 'refunds' && segments[2] && segments[3] === 'reconcile' && method === 'POST' && segments.length === 4) {
    requireRoles(principal, 'frontdesk', 'admin');
    const id = segments[2];
    const refund = findOr404(store.state.refunds, id, '退款');
    if (!refund.outboundRequestId) throw new HttpError(422, 'NO_REFUND_REQUEST', '退款尚未提交支付渠道');
    const peerRecord = await peer.request(refund.outboundRequestId);
    if (!peerRecord) throw new HttpError(404, 'PEER_REFUND_NOT_FOUND', '支付渠道没有原退款流水');
    const updated = await store.mutate(state => markRefundFromPeer(state, id, peerRecord.result || peerRecord));
    return sendJson(res, 200, { refund: updated, peerRecord });
  }

  if (method === 'GET' && segments[1] === 'refunds' && segments.length === 2) {
    requireAuth(principal);
    let refunds = store.state.refunds;
    if (principal.roles.includes('subject')) refunds = refunds.filter(r => r.personId === principal.personId);
    else requireCenter(principal);
    return sendJson(res, 200, refunds);
  }

  // ---------- 质量暂停、复核与影响定位 ----------
  if (method === 'GET' && segments[1] === 'quality' && segments[2] === 'issues' && segments.length === 3) {
    requireRoles(principal, 'quality', 'frontdesk', 'inspector', 'admin');
    return sendJson(res, 200, store.state.qualityIssues);
  }

  if (method === 'POST' && segments[1] === 'quality' && segments[2] === 'issues' && segments.length === 3) {
    requireRoles(principal, 'quality', 'admin');
    if (principal.roles.includes('collector')) throw new HttpError(403, 'COLLECTOR_QUALITY_FORBIDDEN', '采样员角色不得批准或登记质量结论，职责必须分离');
    const issue = await store.mutate(state => createQualityIssue(state, body, principal));
    return sendJson(res, 201, issue);
  }

  if (segments[1] === 'quality' && segments[2] === 'issues' && segments[4] === 'impact' && method === 'GET' && segments.length === 5) {
    requireRoles(principal, 'quality', 'frontdesk', 'inspector', 'admin');
    return sendJson(res, 200, buildQualityImpact(store.state, segments[3]));
  }

  if (segments[1] === 'quality' && segments[2] === 'issues' && segments[4] === 'reviews' && method === 'POST' && segments.length === 5) {
    requireRoles(principal, 'quality', 'admin');
    if (principal.roles.includes('collector')) throw new HttpError(403, 'COLLECTOR_QUALITY_FORBIDDEN', '采样员不得批准自己的或本岗相关质量结论');
    const review = await store.mutate(state => createQualityReview(state, segments[3], body, principal));
    return sendJson(res, 201, review);
  }

  // ---------- 结果与交付 ----------
  if (method === 'POST' && segments[1] === 'results' && segments.length === 2) {
    requireRoles(principal, 'inspector', 'frontdesk', 'quality', 'admin');
    const result = await store.mutate(state => recordResult(state, catalog, body, principal, 'center'));
    return sendJson(res, 201, result);
  }

  if (method === 'POST' && segments[1] === 'deliveries' && segments.length === 2) {
    requireRoles(principal, 'frontdesk', 'inspector', 'quality', 'admin');
    const delivery = await store.mutate(state => createDelivery(state, body, principal));
    return sendJson(res, 201, delivery);
  }

  if (method === 'GET' && segments[1] === 'deliveries' && segments.length === 2) {
    requireAuth(principal);
    let deliveries = store.state.deliveries;
    if (principal.roles.includes('subject')) deliveries = deliveries.filter(d => d.personId === principal.personId);
    else requireCenter(principal);
    return sendJson(res, 200, deliveries);
  }

  if (method === 'GET' && segments[1] === 'notifications' && segments.length === 2) {
    requireAuth(principal);
    let notifications = store.state.notifications;
    if (principal.roles.includes('subject')) notifications = notifications.filter(n => n.recipientPersonId === principal.personId);
    else requireCenter(principal);
    return sendJson(res, 200, notifications);
  }

  if (method === 'GET' && segments[1] === 'reports' && segments.length === 2) {
    requireRoles(principal, 'subject', 'frontdesk', 'quality', 'admin');
    const personId = principal.personId || url.searchParams.get('personId');
    if (!personId) throw new HttpError(422, 'PERSON_REQUIRED', '中心人员查询报告需要 ?personId=');
    assertOwnPerson(principal, personId);
    const reports = store.state.deliveries.filter(d => d.personId === personId).map(d => ({
      delivery: d,
      result: store.state.results.find(r => r.id === d.resultId),
      item: store.state.items.find(i => i.id === d.orderItemId)
    }));
    return sendJson(res, 200, { personId, reports });
  }

  return sendJson(res, 404, { error: 'API 路径不存在', code: 'NOT_FOUND' });
}

function createPaymentIntentInState(state, body, principal) {
  const order = findOr404(state.orders, requireString(body.orderId, 'orderId'), '订单');
  assertOwnPerson(principal, order.personId);
  let items = state.items.filter(i => i.orderId === order.id && i.paymentStatus !== 'paid');
  if (Array.isArray(body.orderItemIds)) items = items.filter(i => body.orderItemIds.includes(i.id));
  if (body.payAllApproved !== true && !Array.isArray(body.orderItemIds)) {
    throw new HttpError(422, 'ITEM_SELECTION_REQUIRED', '请提供 orderItemIds，或显式 payAllApproved=true');
  }
  items = items.filter(i => !['pending_consent', 'canceled', 'refunded', 'consent_withdrawn'].includes(i.status));
  if (!items.length) throw new HttpError(409, 'NO_PAYABLE_ITEMS', '没有可支付项目；待同意加项不能付款');
  const quoteSnapshot = items.map(i => ({ orderItemId: i.id, testId: i.testId, amountMinor: i.amountMinor, quoteAmountMinor: i.quotedAmountMinor }));
  const amountMinor = quoteSnapshot.reduce((sum, x) => sum + x.amountMinor, 0);
  const id = newId(state, 'paymentIntent', 'payint', body.intentId);
  const record = {
    id,
    outboundRequestId: body.requestId || `pay-req-${id}`,
    orderId: order.id,
    personId: order.personId,
    orderItemIds: items.map(i => i.id),
    amountMinor,
    currency: 'CNY',
    quoteSnapshot,
    status: 'created',
    createdAt: new Date().toISOString(),
    createdBy: principal.actorId
  };
  state.paymentIntents.push(record);
  return record;
}

function recordPaymentReceipt(state, body, principal) {
  const order = findOr404(state.orders, requireString(body.orderId, 'orderId'), '订单');
  const providerPaymentId = requireString(body.providerPaymentId || body.paymentId, 'providerPaymentId');
  const duplicate = state.payments.find(p => p.providerPaymentId === providerPaymentId);
  if (duplicate) return duplicate;
  const amountMinor = requireAmount(body.amountMinor, 'amountMinor');
  if (body.currency && body.currency !== 'CNY') throw new HttpError(422, 'CURRENCY_UNSUPPORTED', '本合成服务仅记录 CNY 分');
  let items = state.items.filter(i => i.orderId === order.id && !['pending_consent', 'canceled', 'refunded', 'consent_withdrawn'].includes(i.status));
  if (Array.isArray(body.orderItemIds)) items = items.filter(i => body.orderItemIds.includes(i.id));
  if (!items.length) throw new HttpError(422, 'NO_PAID_ITEMS', '支付回执没有对应可入账项目');
  const snapshot = items.map(i => ({ orderItemId: i.id, testId: i.testId, amountMinor: i.amountMinor, quotedAmountMinor: i.quotedAmountMinor }));
  const expected = snapshot.reduce((sum, x) => sum + x.amountMinor, 0);
  if (amountMinor !== expected && body.amountMatchesQuote !== false) {
    throw new HttpError(409, 'PAYMENT_AMOUNT_MISMATCH', '回执金额与按下单时逐项确认的金额不一致', { expectedMinor: expected, receivedMinor: amountMinor });
  }
  const payment = {
    id: newId(state, 'payment', 'pay'),
    providerPaymentId,
    orderId: order.id,
    personId: order.personId,
    orderItemIds: items.map(i => i.id),
    amountMinor,
    currency: body.currency || 'CNY',
    status: body.status || 'paid',
    paidAt: body.paidAt || body.occurredAt || new Date().toISOString(),
    receivedBy: principal.actorId,
    quoteSnapshot: snapshot,
    channel: body.channel || 'synthetic-peer'
  };
  state.payments.push(payment);
  for (const item of items) {
    item.paymentStatus = 'paid';
    item.paymentId = payment.id;
    item.providerPaymentId = providerPaymentId;
    item.paidAmountMinor = item.amountMinor;
    item.acceptedQuoteSnapshot = snapshot.find(x => x.orderItemId === item.id);
  }
  order.paymentStatus = 'paid';
  addAudit(state, principal.actorId, 'payment.receipt', 'payment', payment.id, { orderId: order.id, amountMinor });
  return payment;
}

function createRefundInState(state, body, principal, automatic = false) {
  const item = findOr404(state.items, requireString(body.orderItemId, 'orderItemId'), '订单项目');
  assertOwnPerson(principal, item.personId);
  const existing = state.refunds.find(r => r.orderItemId === item.id && ['requested', 'approved', 'processing', 'refunded'].includes(r.status));
  if (existing) return existing;
  if (['delivered'].includes(item.status) && !body.qualityRefund) {
    throw new HttpError(409, 'ITEM_COMPLETED_DELIVERED', '已完成并交付的项目不能按“未完成项目”退项；质量异议请走质量复核/更正');
  }
  const paidAmountMinor = item.paidAmountMinor || 0;
  const knownChargeMinor = Number.isInteger(body.knownChargeMinor) ? body.knownChargeMinor : 0;
  if (knownChargeMinor < 0 || knownChargeMinor > paidAmountMinor) throw new HttpError(422, 'INVALID_CHARGE_AMOUNT', '已发生费用必须介于0和项目已付分摊金额之间');
  const commission = [...itemCommissions(state, item.id)].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  const hasResult = state.results.some(r => r.orderItemId === item.id);
  const startedTesting = ['testing', 'completed', 'completed_awaiting_result', 'resulted'].includes(commission?.status) || commission?.cancelOutcome === 'already_testing';
  const cancelled = commission?.status === 'cancelled' && commission?.cancelOutcome === 'cancelled';
  const unexecuted = !hasResult && !startedTesting;
  let status = 'requested';
  let responsibleRefundMinor = paidAmountMinor;
  let retainedMinor = 0;
  let liability = 'subject';
  let reason = body.reason || '受检者对未完成项目申请退项';
  if (paidAmountMinor === 0) {
    status = 'no_money_due';
    responsibleRefundMinor = 0;
  } else if ((cancelled || !commission) && unexecuted) {
    status = 'approved';
    retainedMinor = knownChargeMinor;
    responsibleRefundMinor = paidAmountMinor - knownChargeMinor;
    reason = knownChargeMinor > 0
      ? '取消成功但有已登记消耗/费用，按原报价扣除实际费用后退回剩余金额'
      : '未执行且取消成功/尚未委托，全额退回原支付渠道';
  } else if (startedTesting || hasResult) {
    status = 'pending_review';
    responsibleRefundMinor = 0;
    retainedMinor = paidAmountMinor;
    liability = 'pending_executed_charge_review';
    reason = '已有开检/执行事实，不能按迟到撤回全额冲销；需按实际费用核定';
  }
  const refund = {
    id: newId(state, 'refund', 'ref'),
    orderId: item.orderId,
    orderItemId: item.id,
    personId: item.personId,
    originalPaymentId: item.paymentId || null,
    originalProviderPaymentId: item.providerPaymentId || null,
    paidAmountMinor,
    requestedRefundMinor: paidAmountMinor,
    responsibleRefundMinor,
    retainedMinor,
    currency: 'CNY',
    status,
    automatic,
    responsibility: { liableParty: liability, reason, quoteAmountMinor: item.amountMinor, orderTimeAllocationPreserved: true },
    reason: body.reason || reason,
    requestedBy: principal.actorId,
    requestedAt: new Date().toISOString(),
    outboundRequestId: status === 'approved' && responsibleRefundMinor > 0 ? `refund-req-${newId(state, 'refundOut', 'rfo')}` : null,
    peerPayload: null
  };
  if (refund.outboundRequestId) {
    refund.peerPayload = { requestId: refund.outboundRequestId, refundId: refund.id, paymentId: refund.originalProviderPaymentId || refund.originalPaymentId, amountMinor: responsibleRefundMinor, orderId: refund.orderId, orderItemId: refund.orderItemId };
  }
  state.refunds.push(refund);
  if (status === 'approved' || status === 'no_money_due') {
    item.refundStatus = status;
    const allocation = activeAllocationForItem(state, item.id);
    if (allocation && (!commission || commission.status === 'cancelled')) {
      releaseAllocationUnused(allocation, new Date().toISOString(), '未执行项目退项/取消');
    }
    item.status = 'canceled';
    item.incompleteReason = '未执行项目已取消并核定退款；已分装量保留谱系，不恢复回原管' ;
  }
  addAudit(state, principal.actorId, 'refund.request', 'refund', refund.id, { status, responsibleRefundMinor });
  return refund;
}

function markRefundFromPeer(state, refundId, fact) {
  const refund = findOr404(state.refunds, refundId, '退款');
  if (fact.requestId && !refund.outboundRequestId) refund.outboundRequestId = fact.requestId;
  refund.providerRefundId = fact.refundId || fact.providerRefundId || refund.providerRefundId;
  refund.channelPaymentId = fact.paymentId || refund.channelPaymentId || refund.originalProviderPaymentId;
  if (fact.amountMinor !== undefined) {
    const amount = requireAmount(fact.amountMinor, 'fact.amountMinor');
    if (amount > refund.paidAmountMinor) throw new HttpError(422, 'REFUND_AMOUNT_TOO_HIGH', '渠道退款金额超过原项目分摊金额');
    refund.responsibleRefundMinor = amount;
  }
  const status = fact.status || 'refunded';
  if (['refunded', 'succeeded', 'success'].includes(status)) {
    refund.status = 'refunded';
    refund.refundedAt = fact.occurredAt || fact.refundedAt || new Date().toISOString();
    const item = state.items.find(i => i.id === refund.orderItemId);
    if (item) { item.refundStatus = 'refunded'; item.status = 'refunded'; item.refundedAmountMinor = refund.responsibleRefundMinor; }
  } else {
    refund.status = status;
  }
  return refund;
}

function assertQualitySegregation(principal, sample) {
  if (principal.roles.includes('collector')) throw new HttpError(403, 'COLLECTOR_QUALITY_FORBIDDEN', '采样员不能批准自己的或本岗位质量结论');
  if (sample?.collectorId === principal.actorId) throw new HttpError(403, 'SELF_QUALITY_REVIEW_FORBIDDEN', '不能批准本人采集标本的质量结论，请另派质量人员');
}

function createQualityIssue(state, body, principal) {
  const sample = findOr404(state.samples, requireString(body.sampleId, 'sampleId'), '标本');
  assertQualitySegregation(principal, sample);
  const kind = body.kind === 'identity_pending' ? 'identity_pending' : 'contamination';
  const issue = {
    id: newId(state, 'issue', 'qi', body.issueId),
    sampleId: sample.id,
    kind,
    reason: requireString(body.reason, 'reason'),
    status: 'open',
    reportedBy: principal.actorId,
    reportedAt: body.reportedAt || new Date().toISOString(),
    holdDelivery: body.holdDelivery !== false,
    impact: null
  };
  state.qualityIssues.push(issue);
  issue.impact = buildQualityImpact(state, issue.id);
  for (const result of state.results.filter(r => issue.impact.resultIds.includes(r.id))) {
    const block = resultQualityBlock(state, result);
    if (block) { result.deliveryStatus = 'held_quality'; result.qualityHoldReason = issue.reason; }
  }
  addAudit(state, principal.actorId, 'quality.hold', 'qualityIssue', issue.id, { sampleId: sample.id });
  return issue;
}

function buildQualityImpact(state, issueId) {
  const issue = findOr404(state.qualityIssues, issueId, '质量事项');
  const root = state.samples.find(s => s.id === issue.sampleId);
  if (!root) throw new HttpError(404, 'SAMPLE_NOT_FOUND', '质量事项关联标本不存在');
  const sampleIds = [root.id, ...descendantSampleIds(state, root.id)];
  const allocations = state.allocations.filter(a => sampleIds.includes(a.sampleId) || sampleIds.includes(a.sourceSampleId));
  const commissionIds = new Set(state.commissions.filter(c => sampleIds.includes(c.sampleId)).map(c => c.id));
  const itemIds = new Set([...allocations.map(a => a.orderItemId), ...state.commissions.filter(c => sampleIds.includes(c.sampleId)).map(c => c.orderItemId)]);
  const results = state.results.filter(r => sampleIds.includes(r.sampleId) || commissionIds.has(r.commissionId));
  const resultIds = results.map(r => r.id);
  const deliveries = state.deliveries.filter(d => resultIds.includes(d.resultId));
  const personIds = [...new Set(state.items.filter(i => itemIds.has(i.id)).map(i => i.personId))];
  return {
    issueId: issue.id,
    rootSampleId: root.id,
    sampleIds,
    allocationIds: allocations.map(a => a.id),
    commissionIds: [...commissionIds],
    orderItemIds: [...itemIds],
    personIds,
    resultIds,
    deliveryIds: deliveries.map(d => d.id),
    deliveredFacts: deliveries,
    note: '影响范围按原管→子管谱系和委托/结果外键计算；不会按姓名或项目名停掉另一位受检者'
  };
}

function createQualityReview(state, issueId, body, principal) {
  const issue = findOr404(state.qualityIssues, issueId, '质量事项');
  const sample = state.samples.find(s => s.id === issue.sampleId);
  assertQualitySegregation(principal, sample);
  const review = {
    id: newId(state, 'review', 'qr', body.reviewId),
    issueId,
    type: 'exemption',
    decision: body.decision || 'release_result',
    resultId: body.resultId || null,
    orderItemId: body.orderItemId || null,
    scope: body.scope || body.validScope || 'independent_valid',
    note: requireString(body.note, 'note'),
    reviewerId: principal.actorId,
    reviewedAt: body.reviewedAt || new Date().toISOString(),
    status: 'effective'
  };
  state.qualityReviews.push(review);
  if (review.decision === 'release_result') {
    let result = review.resultId ? state.results.find(r => r.id === review.resultId) : null;
    if (!result && review.orderItemId) result = state.results.find(r => r.orderItemId === review.orderItemId);
    if (!result) throw new HttpError(404, 'RESULT_NOT_FOUND_FOR_RELEASE', '放行独立有效项目时必须提供已存在 resultId 或有结果的 orderItemId');
    review.resultId = result.id;
    result.deliveryStatus = 'released_by_quality_review';
    result.qualityExemptionReviewId = review.id;
  } else if (review.decision === 'close') {
    issue.status = 'closed';
    issue.closedAt = review.reviewedAt;
    issue.closeReviewId = review.id;
  }
  addAudit(state, principal.actorId, 'quality.review', 'qualityReview', review.id, { issueId, decision: review.decision });
  return review;
}

function recordResult(state, catalog, body, principal, source) {
  const lookup = requireString(body.commissionId || body.requestId || body.outboundRequestId, 'commissionId');
  const commission = state.commissions.find(c => c.id === lookup || c.outboundRequestId === lookup || c.externalCommissionId === lookup);
  if (!commission) throw new HttpError(404, 'COMMISSION_NOT_FOUND', '结果必须对应已有检验委托');
  if (source === 'external' && commission.labId !== principal.labId) {
    throw new HttpError(403, 'COMMISSION_LAB_SCOPE_DENIED', '外送方不能提交其他机构的委托结果');
  }
  const testId = requireString(body.testId, 'testId');
  const sampleId = requireString(body.sampleId, 'sampleId');
  if (testId !== commission.testId) throw new HttpError(409, 'TEST_MISMATCH', '结果的 testId 与委托项目不一致');
  if (sampleId !== commission.sampleId) {
    throw new HttpError(409, 'SAMPLE_MISMATCH_NO_CORRECTION', '结果 sampleId 与委托/子管不一致；重新采样必须建立新委托和新版本链，不能伪装成旧标本更正');
  }
  testOr404(catalog, testId);
  const existing = state.results.filter(r => r.commissionId === commission.id).sort((a, b) => a.revision - b.revision);
  const revision = Number.isInteger(body.revision) ? body.revision : existing.length + 1;
  if (revision < 1) throw new HttpError(422, 'INVALID_REVISION', 'revision 必须从 1 开始');
  const sameRevision = existing.find(r => r.revision === revision);
  if (sameRevision) {
    const fingerprint = JSON.stringify({ values: body.values, conclusion: body.conclusion, status: body.status });
    if (sameRevision.fingerprint === fingerprint) return sameRevision;
    throw new HttpError(409, 'REVISION_CONFLICT', '同一委托项目的 revision 已存在且内容不同');
  }
  if (revision !== existing.length + 1) throw new HttpError(409, 'REVISION_GAP', `revision 必须递增；下一版为 ${existing.length + 1}`);
  if (revision > 1 && !body.invalidatesScope && !body.correctionNote) {
    throw new HttpError(422, 'CORRECTION_SCOPE_REQUIRED', '更正版必须说明失效范围');
  }
  const result = {
    id: newId(state, 'result', 'res', body.resultId),
    commissionId: commission.id,
    externalCommissionId: commission.externalCommissionId,
    orderId: commission.orderId,
    orderItemId: commission.orderItemId,
    personId: commission.personId,
    testId,
    sampleId,
    revision,
    status: body.status || (body.invalidated === true ? 'corrected_invalid' : 'final'),
    values: body.values || [],
    conclusion: body.conclusion || null,
    invalidatesScope: body.invalidatesScope || null,
    correctionNote: body.correctionNote || null,
    issuedAt: body.issuedAt || body.occurredAt || new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    receivedBy: principal.actorId,
    source,
    fingerprint: JSON.stringify({ values: body.values, conclusion: body.conclusion, status: body.status })
  };
  state.results.push(result);
  commission.revision = revision;
  applyCommissionFact(state, commission.id, { status: 'completed', completedAt: result.issuedAt }, 'result');
  const item = state.items.find(i => i.id === commission.orderItemId);
  if (item) { item.status = 'resulted'; item.incompleteReason = null; }
  const block = resultQualityBlock(state, result);
  result.deliveryStatus = block ? 'held_quality' : 'available';
  if (block) result.qualityHold = { issueId: block.issue.id, reason: block.issue.reason, viaSampleId: block.viaSampleId };
  if (revision > 1) {
    const priorResultIds = existing.map(r => r.id);
    const priorDeliveries = state.deliveries.filter(d => priorResultIds.includes(d.resultId) || d.orderItemId === result.orderItemId);
    const recipients = new Map();
    for (const d of priorDeliveries) recipients.set(d.recipientKey || d.recipientId || d.id, d);
    for (const delivery of recipients.values()) {
      state.notifications.push({
        id: newId(state, 'notification', 'note'),
        type: 'correction_notice',
        resultId: result.id,
        correctedResultIds: priorResultIds,
        deliveryId: delivery.id,
        recipientPersonId: delivery.personId,
        recipientId: delivery.recipientId,
        recipient: delivery.recipient,
        channel: delivery.channel || 'in-app',
        title: `检验结果更正（${testId} 第${revision}版）`,
        message: body.invalidatesScope ? `原已发出结果的以下范围失效：${body.invalidatesScope}。${body.correctionNote || ''}` : '已发出结果有更正，请以新版本为准。',
        invalidationScope: body.invalidatesScope,
        status: 'recorded_for_actual_recipient',
        createdAt: new Date().toISOString()
      });
    }
  }
  addAudit(state, principal.actorId, 'result.record', 'result', result.id, { commissionId: commission.id, revision, sampleId });
  return result;
}

function createDelivery(state, body, principal) {
  const result = findOr404(state.results, requireString(body.resultId, 'resultId'), '结果');
  const block = resultQualityBlock(state, result);
  if (block) {
    throw new HttpError(409, 'QUALITY_HOLD_DELIVERY_BLOCKED', `质量暂停阻止交付：${block.issue.reason}；独立有效结果需质量复核放行`, { issueId: block.issue.id });
  }
  const item = findOr404(state.items, result.orderItemId, '订单项目');
  const recipientPersonId = body.recipientPersonId || item.personId;
  const delivery = {
    id: newId(state, 'delivery', 'del', body.deliveryId),
    resultId: result.id,
    resultRevision: result.revision,
    orderId: result.orderId,
    orderItemId: result.orderItemId,
    personId: item.personId,
    recipientPersonId,
    recipientId: body.recipientId || recipientPersonId,
    recipientKey: body.recipientKey || body.recipientId || recipientPersonId,
    recipient: body.recipient || { type: 'subject', personId: recipientPersonId },
    channel: body.channel || 'in-app-report',
    deliveredAt: body.deliveredAt || new Date().toISOString(),
    deliveredBy: principal.actorId,
    invalidationScopeAtDelivery: result.invalidatesScope
  };
  state.deliveries.push(delivery);
  result.deliveryStatus = 'delivered';
  result.lastDeliveryId = delivery.id;
  item.status = 'delivered';
  item.deliveredAt = delivery.deliveredAt;
  addAudit(state, principal.actorId, 'report.deliver', 'delivery', delivery.id, { resultId: result.id, revision: result.revision });
  return delivery;
}

async function handleExternal(ctx) {
  const { req, res, segments, principal, store, catalog } = ctx;
  const method = req.method;
  const body = await ctx.getBody();
  requireRoles(principal, 'externalLab');
  const labId = principal.labId;

  if (method === 'GET' && segments[0] === 'external' && segments[1] === 'commissions' && segments.length === 2) {
    let commissions = store.state.commissions.filter(c => c.destination === 'external' && c.labId === labId);
    const testId = ctx.url.searchParams.get('testId');
    const sampleId = ctx.url.searchParams.get('sampleId');
    const orderId = ctx.url.searchParams.get('orderId');
    if (testId) commissions = commissions.filter(c => c.testId === testId);
    if (sampleId) commissions = commissions.filter(c => c.sampleId === sampleId);
    if (orderId) commissions = commissions.filter(c => c.orderId === orderId);
    if ((testId || sampleId || orderId) && commissions.length === 0) {
      throw new HttpError(403, 'EXTERNAL_SCOPE_NOT_COMMISSIONED', '外送方不能读取未委托给本机构的项目、订单或标本');
    }
    return sendJson(res, 200, commissions);
  }

  if (method === 'GET' && segments[0] === 'external' && segments[1] === 'results' && segments.length === 2) {
    const commissionId = ctx.url.searchParams.get('commissionId');
    let results = store.state.results.filter(r => store.state.commissions.some(c => c.id === r.commissionId && c.labId === labId));
    if (commissionId) {
      const commission = store.state.commissions.find(c => c.id === commissionId || c.externalCommissionId === commissionId || c.outboundRequestId === commissionId);
      if (!commission || commission.labId !== labId) throw new HttpError(403, 'EXTERNAL_RESULT_SCOPE_DENIED', '不能读取未委托给本机构的结果');
      results = results.filter(r => r.commissionId === commission.id);
    }
    return sendJson(res, 200, results);
  }

  if (method === 'GET' && segments[0] === 'external' && segments[1] === 'tests' && segments[2] && segments.length === 3) {
    const testId = segments[2];
    const commissions = store.state.commissions.filter(c => c.labId === labId && c.testId === testId);
    if (!commissions.length) throw new HttpError(403, 'EXTERNAL_TEST_NOT_COMMISSIONED', '外送方不能读取未委托给本机构的项目');
    return sendJson(res, 200, { test: testOr404(catalog, testId), commissions });
  }

  if (method === 'GET' && segments[0] === 'external' && segments[1] === 'orders' && segments[2] && segments.length === 3) {
    const orderId = segments[2];
    const order = store.state.orders.find(o => o.id === orderId);
    const commissions = store.state.commissions.filter(c => c.labId === labId && c.orderId === orderId);
    if (!commissions.length) throw new HttpError(403, 'EXTERNAL_ORDER_NOT_COMMISSIONED', '该订单没有委托给本外送机构的项目，不能读取未委托项目');
    const itemIds = new Set(commissions.map(c => c.orderItemId));
    return sendJson(res, 200, {
      orderId,
      commissionedOnly: true,
      items: store.state.items.filter(i => itemIds.has(i.id)),
      commissions
    });
  }

  if (segments[0] === 'external' && segments[1] === 'commissions' && segments[2]) {
    const lookup = segments[2];
    const commission = store.state.commissions.find(c => (c.id === lookup || c.externalCommissionId === lookup || c.outboundRequestId === lookup) && c.labId === labId);
    if (!commission) throw new HttpError(403, 'EXTERNAL_COMMISSION_NOT_FOUND', '委托不存在或未委托给本机构');
    if (method === 'GET' && segments.length === 3) return sendJson(res, 200, commission);
    if (method === 'POST' && segments[3] === 'receipt' && segments.length === 4) {
      const updated = await store.mutate(state => applyCommissionFact(state, commission.id, body, `external:${labId}`));
      return sendJson(res, 200, updated);
    }
  }

  if (method === 'POST' && segments[0] === 'external' && segments[1] === 'results' && segments.length === 2) {
    const result = await store.mutate(state => recordResult(state, catalog, body, principal, 'external'));
    return sendJson(res, 201, result);
  }

  return sendJson(res, 404, { error: '外送接口路径不存在', code: 'EXTERNAL_NOT_FOUND' });
}


