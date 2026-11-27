import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { once } from 'node:events';

const projectRoot = new URL('..', import.meta.url).pathname;

async function startProcess(command, args, env, cwd = projectRoot) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(`[spawn:${args[0] || command}] ${chunk}`); });
  const failed = new Promise((_, reject) => child.once('exit', code => reject(new Error(`进程提前退出：${code}\n${stderr}`))));
  const line = await Promise.race([once(lines, 'line').then(([value]) => value), failed]);
  const info = JSON.parse(line);
  return {
    child, info, stderr: () => stderr,
    async stop() {
      if (child.exitCode !== null) return;
      const ended = once(child, 'exit');
      child.kill('SIGTERM');
      await ended;
      lines.close();
    }
  };
}

async function startPeer(statePath) {
  const p = await startProcess(process.execPath, ['support/peer.mjs'], { PEER_STATE: statePath, PEER_PORT: '0', PEER_HOST: '127.0.0.1' });
  return { ...p, base: `http://127.0.0.1:${p.info.port}` };
}
async function startService(statePath, peerBase) {
  const p = await startProcess(process.execPath, ['server.mjs'], {
    SERVICE_STATE: statePath, PORT: '0', HOST: '127.0.0.1', PEER_BASE_URL: peerBase
  });
  return { ...p, base: `http://127.0.0.1:${p.info.port}` };
}

function auth(token) {
  return { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}
async function api(base, method, route, token, body) {
  const response = await fetch(base + route, {
    method,
    headers: auth(token),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: response.status, body: json };
}
async function peerAdmin(peer, method, route, body) {
  const response = await fetch(peer.base + route, {
    method,
    headers: { 'content-type': 'application/json', 'x-peer-key': 'local-synthetic-peer' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}
const now = () => new Date().toISOString();

test('业务全链路：余量争用、撤回遇开检、原管质量影响与重启追溯', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'exam-business-'));
  const peerState = path.join(dir, 'peer.json');
  const serviceState = path.join(dir, 'service.json');
  let peer = await startPeer(peerState);
  let service = await startService(serviceState, peer.base);
  try {
    // 权限：采样员不能建立质量暂停结论。
    const forbiddenQuality = await api(service.base, 'POST', '/api/quality/issues', 'collector-a', { sampleId: 'tube-x', reason: '尝试自批' });
    assert.equal(forbiddenQuality.status, 403);

    // ---------- 两名人员并发占用 4ml 标本：2ml 与 3ml 只能成一个 ----------
    let r = await api(service.base, 'POST', '/api/orders', 'frontdesk-a', { orderId: 'order-race', personId: 'person-b', items: [] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await api(service.base, 'POST', '/api/orders/order-race/items', 'frontdesk-a', { itemId: 'race-item-a', testId: 'test-a', amountMinor: 2000 });
    assert.equal(r.status, 201);
    r = await api(service.base, 'POST', '/api/orders/order-race/items', 'frontdesk-a', { itemId: 'race-item-b', testId: 'test-b', amountMinor: 3000 });
    assert.equal(r.status, 201);
    for (const itemId of ['race-item-a', 'race-item-b']) {
      r = await api(service.base, 'POST', '/api/consents', 'person-b', { orderItemId: itemId, agreedAmountMinor: itemId.endsWith('a') ? 2000 : 3000, allowRemainingSample: true });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }
    r = await api(service.base, 'POST', '/api/samples', 'collector-a', {
      sampleId: 'tube-race', personId: 'person-b', sampleType: 'blood', container: 'tube-red',
      actualMl: '4.0', collectedAt: now(), conditions: ['fasting']
    });
    assert.equal(r.status, 201);
    r = await api(service.base, 'POST', '/api/samples/tube-race/usability', 'inspector-a', {
      decisions: [
        { testId: 'test-a', usable: true, applicableConditionsConfirmed: true },
        { testId: 'test-b', usable: true }
      ]
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [occupyA, occupyB] = await Promise.all([
      api(service.base, 'POST', '/api/order-items/race-item-a/occupy', 'frontdesk-a', { sampleId: 'tube-race' }),
      api(service.base, 'POST', '/api/order-items/race-item-b/occupy', 'frontdesk-a', { sampleId: 'tube-race' })
    ]);
    const codes = [occupyA.status, occupyB.status].sort();
    assert.deepEqual(codes, [201, 409]);
    const loser = occupyA.status === 409 ? occupyA : occupyB;
    const winner = occupyA.status === 201 ? occupyA : occupyB;
    assert.equal(loser.body.code, 'INSUFFICIENT_SPECIMEN');
    assert.ok(/不能借用/.test(loser.body.error));
    const raceVolume = (await api(service.base, 'GET', '/api/samples/tube-race', 'frontdesk-a')).body.volume;
    assert.equal(raceVolume.availableMl, winner.body.allocation.testId === 'test-a' ? '2.0' : '1.0');
    const overviewB = await api(service.base, 'GET', '/api/my/overview', 'person-b');
    assert.ok(overviewB.body.groups.waitingSpecimen.some(x => x.code === undefined && /race-item-/.test(x.id) && x.status === 'waiting_specimen'));

    // 外送方不能读取未委托订单。
    const externalForbidden = await api(service.base, 'GET', '/external/orders/order-race', 'lab-a');
    assert.equal(externalForbidden.status, 403);
    const centerOrderForbidden = await api(service.base, 'GET', '/api/orders/order-race', 'lab-a');
    assert.equal(centerOrderForbidden.status, 403);

    // ---------- 开检前取消：释放未用占用量并退款 ----------
    r = await api(service.base, 'POST', '/api/orders', 'frontdesk-a', {
      orderId: 'order-cancel', personId: 'person-b',
      items: [{ itemId: 'cancel-item-b', testId: 'test-b', amountMinor: 3000 }]
    });
    assert.equal(r.status, 201);
    r = await api(service.base, 'POST', '/api/payments/receipts', 'payment-gateway', {
      providerPaymentId: 'pay-cancel-1', orderId: 'order-cancel', amountMinor: 3000, paidAt: now()
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await api(service.base, 'POST', '/api/samples', 'collector-a', { sampleId: 'tube-cancel', personId: 'person-b', sampleType: 'blood', container: 'tube-red', actualMl: '6.0', collectedAt: now(), conditions: [] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await api(service.base, 'POST', '/api/samples/tube-cancel/usability', 'inspector-a', { testId: 'test-b', usable: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api(service.base, 'POST', '/api/order-items/cancel-item-b/occupy', 'frontdesk-a', { sampleId: 'tube-cancel' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await peerAdmin(peer, 'PUT', '/admin/plans/comm-cancel-1', { mode: 'normal', result: { status: 'received', commissionId: 'ext-cancel-1', sampleId: 'tube-cancel', testId: 'test-b' } });
    r = await api(service.base, 'POST', '/api/commissions', 'frontdesk-a', { orderItemId: 'cancel-item-b', requestId: 'comm-cancel-1' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.commission.status, 'received');
    await peerAdmin(peer, 'PUT', '/admin/plans/cancel-cancel-1', { mode: 'normal', result: { status: 'cancelled', cancelledAt: now() } });
    r = await api(service.base, 'POST', '/api/commissions/' + r.body.commission.id + '/cancel', 'frontdesk-a', { cancelRequestId: 'cancel-cancel-1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.cancelOutcome, 'cancelled');
    assert.equal(r.body.refund.status, 'approved');
    const cancelRefundId = r.body.refund.id;
    await peerAdmin(peer, 'PUT', `/admin/results/${r.body.refund.outboundRequestId}`, { status: 'refunded', refundId: 'rp-cancel-1', paymentId: 'pay-cancel-1', amountMinor: 3000, occurredAt: now() });
    r = await api(service.base, 'POST', `/api/refunds/${cancelRefundId}/reconcile`, 'frontdesk-a');
    assert.equal(r.body.refund.status, 'refunded');
    assert.equal(r.body.refund.responsibleRefundMinor, 3000);
    assert.equal((await api(service.base, 'GET', '/api/samples/tube-cancel', 'frontdesk-a')).body.volume.availableMl, '6.0');

    // ---------- 已分装后取消：子管保留，量不恢复回原管 ----------
    await api(service.base, 'POST', '/api/orders', 'frontdesk-a', { orderId: 'order-aliquot-cancel', personId: 'person-b', items: [{ itemId: 'aliquot-cancel-item', testId: 'test-a', amountMinor: 2000 }] });
    await api(service.base, 'POST', '/api/payments/receipts', 'payment-gateway', { providerPaymentId: 'pay-aliquot-cancel', orderId: 'order-aliquot-cancel', amountMinor: 2000 });
    await api(service.base, 'POST', '/api/samples', 'collector-a', { sampleId: 'tube-aliquot-cancel', personId: 'person-b', sampleType: 'blood', container: 'tube-red', actualMl: '10.0', collectedAt: now(), conditions: ['fasting'] });
    await api(service.base, 'POST', '/api/samples/tube-aliquot-cancel/usability', 'inspector-a', { testId: 'test-a', usable: true, applicableConditionsConfirmed: true });
    await api(service.base, 'POST', '/api/order-items/aliquot-cancel-item/occupy', 'frontdesk-a', { sampleId: 'tube-aliquot-cancel' });
    r = await api(service.base, 'POST', '/api/samples/tube-aliquot-cancel/aliquots', 'collector-a', { sampleId: 'child-aliquot-cancel', orderItemId: 'aliquot-cancel-item', actualMl: '2.0' });
    assert.equal(r.status, 201);
    await peerAdmin(peer, 'PUT', '/admin/plans/comm-aliquot-cancel', { result: { status: 'received', commissionId: 'ext-aliquot-cancel' } });
    r = await api(service.base, 'POST', '/api/commissions', 'frontdesk-a', { orderItemId: 'aliquot-cancel-item', requestId: 'comm-aliquot-cancel' });
    const aliquotCommissionId = r.body.commission.id;
    await peerAdmin(peer, 'PUT', '/admin/plans/cancel-aliquot-cancel', { mode: 'normal', result: { status: 'cancelled' } });
    r = await api(service.base, 'POST', `/api/commissions/${aliquotCommissionId}/cancel`, 'frontdesk-a', { cancelRequestId: 'cancel-aliquot-cancel' });
    assert.equal(r.body.cancelOutcome, 'cancelled');
    const aliquotParent = (await api(service.base, 'GET', '/api/samples/tube-aliquot-cancel', 'frontdesk-a')).body.volume;
    assert.equal(aliquotParent.aliquotedMl, '2.0');
    assert.equal(aliquotParent.availableMl, '8.0');

    // ---------- 套餐优惠按下单时分摊，退一项不重开其余项目价格 ----------
    r = await api(service.base, 'POST', '/api/orders', 'frontdesk-a', { orderId: 'order-pkg', personId: 'person-b', packageId: 'pkg-ab-split' });
    assert.equal(r.status, 201);
    const pkgItems = r.body.items;
    const pkgB = pkgItems.find(i => i.testId === 'test-b');
    await api(service.base, 'POST', '/api/payments/receipts', 'payment-gateway', { providerPaymentId: 'pay-pkg-4500', orderId: 'order-pkg', amountMinor: 4500 });
    r = await api(service.base, 'POST', '/api/refunds', 'person-b', { orderItemId: pkgB.id, reason: '未做B项，申请退项' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.refund.responsibleRefundMinor, 2500);
    const pkgOrder = (await api(service.base, 'GET', '/api/orders/order-pkg', 'person-b')).body;
    assert.equal(pkgOrder.items.find(i => i.testId === 'test-a').amountMinor, 2000);
    assert.equal(pkgOrder.totalAmountMinor, 4500);

    // ---------- 质量主场景：甲的 A 已交付，B 外送断连/核对/开检/结果 ----------
    r = await api(service.base, 'POST', '/api/orders', 'frontdesk-a', { orderId: 'order-quality', personId: 'person-a', items: [{ itemId: 'q-item-a', testId: 'test-a', amountMinor: 2000 }] });
    assert.equal(r.status, 201);
    r = await api(service.base, 'POST', '/api/orders/order-quality/items', 'frontdesk-a', { itemId: 'q-item-b', testId: 'test-b', amountMinor: 3000, doctorId: 'doctor-a', suggestionNote: '医生建议加B，但仍需本人同意' });
    assert.equal(r.status, 201);
    r = await api(service.base, 'POST', '/api/consents', 'person-a', { consentId: 'consent-q-b', orderItemId: 'q-item-b', agreedAmountMinor: 3000, allowRemainingSample: true, allowedSampleIds: ['tube-quality'] });
    assert.equal(r.status, 201);
    await api(service.base, 'POST', '/api/payments/receipts', 'payment-gateway', { providerPaymentId: 'pay-quality-5000', orderId: 'order-quality', amountMinor: 5000 });
    await api(service.base, 'POST', '/api/samples', 'collector-a', { sampleId: 'tube-quality', personId: 'person-a', sampleType: 'blood', container: 'tube-red', actualMl: '6.0', collectedAt: now(), conditions: ['fasting'] });
    r = await api(service.base, 'POST', '/api/samples/tube-quality/usability', 'inspector-a', { decisions: [{ testId: 'test-a', usable: true, applicableConditionsConfirmed: true }, { testId: 'test-b', usable: true }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await api(service.base, 'POST', '/api/order-items/q-item-a/occupy', 'frontdesk-a', { sampleId: 'tube-quality' });
    await api(service.base, 'POST', '/api/order-items/q-item-b/occupy', 'frontdesk-a', { sampleId: 'tube-quality' });
    r = await api(service.base, 'POST', '/api/samples/tube-quality/aliquots', 'collector-a', { sampleId: 'child-quality', orderItemId: 'q-item-b', actualMl: '3.0' });
    assert.equal(r.status, 201);

    r = await api(service.base, 'POST', '/api/commissions', 'frontdesk-a', { orderItemId: 'q-item-a', destination: 'internal' });
    assert.equal(r.status, 201);
    const commA = r.body.commission.id;
    r = await api(service.base, 'POST', '/api/results', 'inspector-a', { commissionId: commA, testId: 'test-a', sampleId: 'tube-quality', revision: 1, values: [{ code: 'synthetic-a', value: '5.0' }], conclusion: '合成数值，系统不作疾病判断' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const resultA1 = r.body.id;
    r = await api(service.base, 'POST', '/api/deliveries', 'frontdesk-a', { resultId: resultA1, recipientId: 'recipient-a-primary', recipient: { type: 'subject-contact', contact: '合成App/纸质收件人' } });
    assert.equal(r.status, 201);
    const deliveryA1 = r.body.id;

    // 外送接收端受理后断连。
    await peerAdmin(peer, 'PUT', '/admin/plans/comm-quality-b', { mode: 'disconnectAfterAccept', result: { status: 'received', commissionId: 'ext-quality-b', sampleId: 'child-quality', testId: 'test-b' } });
    r = await api(service.base, 'POST', '/api/commissions', 'frontdesk-a', { orderItemId: 'q-item-b', requestId: 'comm-quality-b' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.commission.status, 'dispatch_unknown');
    const commB = r.body.commission.id;
    const duplicate = await api(service.base, 'POST', '/api/commissions', 'frontdesk-a', { orderItemId: 'q-item-b', sampleId: 'child-quality', requestId: 'comm-quality-b-duplicate' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, 'COMMISSION_IN_FLIGHT');
    r = await api(service.base, 'POST', `/api/commissions/${commB}/reconcile`, 'frontdesk-a');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.commission.status, 'received');
    assert.equal(r.body.commission.externalCommissionId, 'ext-quality-b');
    await peerAdmin(peer, 'PUT', '/admin/results/comm-quality-b', { status: 'testing', commissionId: 'ext-quality-b', sampleId: 'child-quality', testId: 'test-b', occurredAt: now() });
    r = await api(service.base, 'POST', `/api/commissions/${commB}/reconcile`, 'frontdesk-a');
    assert.equal(r.body.commission.status, 'testing');

    // 撤回同意后碰到已经开检：不能按未执行全额冲销。
    r = await api(service.base, 'POST', '/api/consents/consent-q-b/withdraw', 'person-a', { reason: '本人撤回B项同意' });
    assert.equal(r.status, 200);
    const orderAfterWithdraw = (await api(service.base, 'GET', '/api/orders/order-quality', 'person-a')).body;
    assert.equal(orderAfterWithdraw.items.find(i => i.id === 'q-item-a').status, 'delivered');
    assert.equal(orderAfterWithdraw.items.find(i => i.id === 'q-item-b').activeConsentId, null);
    await peerAdmin(peer, 'PUT', '/admin/plans/cancel-quality-b', { mode: 'normal', result: { status: 'alreadyTesting', commissionId: 'ext-quality-b', chargeMinor: 3000, occurredAt: now() } });
    r = await api(service.base, 'POST', `/api/commissions/${commB}/cancel`, 'frontdesk-a', { cancelRequestId: 'cancel-quality-b' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.cancelOutcome, 'already_testing');
    assert.equal(r.body.commission.feeConsequence.refundAllowed, false);
    r = await api(service.base, 'POST', '/api/refunds', 'person-a', { orderItemId: 'q-item-b', reason: '撤回后申请未完成项目退项' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.refund.status, 'pending_review');
    assert.equal(r.body.refund.responsibleRefundMinor, 0);
    assert.equal(r.body.refund.retainedMinor, 3000);

    // 外送方回执结果。
    r = await api(service.base, 'POST', '/external/results', 'lab-a', { commissionId: 'ext-quality-b', testId: 'test-b', sampleId: 'child-quality', revision: 1, values: [{ code: 'synthetic-b', value: 'ok' }], conclusion: '合成结果' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const resultB1 = r.body.id;

    // 原管污染：定位子管、项目、结果和已交付事实，且不波及乙。
    r = await api(service.base, 'POST', '/api/quality/issues', 'quality-a', { issueId: 'qi-tube-quality', sampleId: 'tube-quality', kind: 'contamination', reason: '合成污染待核' });
    assert.equal(r.status, 201);
    r = await api(service.base, 'GET', '/api/quality/issues/qi-tube-quality/impact', 'quality-a');
    assert.equal(r.status, 200);
    const impact = r.body;
    assert.deepEqual(impact.sampleIds.sort(), ['child-quality', 'tube-quality']);
    assert.ok(impact.orderItemIds.includes('q-item-a') && impact.orderItemIds.includes('q-item-b'));
    assert.ok(impact.resultIds.includes(resultA1) && impact.resultIds.includes(resultB1));
    assert.ok(impact.deliveredFacts.some(d => d.id === deliveryA1 && d.recipientId === 'recipient-a-primary'));
    assert.deepEqual(impact.personIds, ['person-a']);
    const blockedDelivery = await api(service.base, 'POST', '/api/deliveries', 'frontdesk-a', { resultId: resultB1 });
    assert.equal(blockedDelivery.status, 409);
    assert.equal(blockedDelivery.body.code, 'QUALITY_HOLD_DELIVERY_BLOCKED');

    // 乙的同名/同项目结果不受甲原管事项影响。
    await api(service.base, 'POST', '/api/orders', 'frontdesk-a', { orderId: 'order-independent-b', personId: 'person-b', items: [{ itemId: 'independent-b-item', testId: 'test-b', amountMinor: 3000 }] });
    await api(service.base, 'POST', '/api/samples', 'collector-a', { sampleId: 'tube-independent-b', personId: 'person-b', sampleType: 'blood', container: 'tube-red', actualMl: '6.0', collectedAt: now(), conditions: [] });
    await api(service.base, 'POST', '/api/samples/tube-independent-b/usability', 'inspector-a', { testId: 'test-b', usable: true });
    await api(service.base, 'POST', '/api/order-items/independent-b-item/occupy', 'frontdesk-a', { sampleId: 'tube-independent-b' });
    r = await api(service.base, 'POST', '/api/commissions', 'frontdesk-a', { orderItemId: 'independent-b-item', destination: 'internal' });
    const commIndependentB = r.body.commission.id;
    r = await api(service.base, 'POST', '/api/results', 'inspector-a', { commissionId: commIndependentB, testId: 'test-b', sampleId: 'tube-independent-b', revision: 1, values: [], conclusion: '乙的有效结果' });
    assert.equal(r.status, 201);
    r = await api(service.base, 'POST', '/api/deliveries', 'frontdesk-a', { resultId: r.body.id });
    assert.equal(r.status, 201, '另一位受检者的同项目不应被甲的质量暂停阻止');

    // 复核后 B 独立有效，可先交付。
    r = await api(service.base, 'POST', '/api/quality/issues/qi-tube-quality/reviews', 'quality-a', { decision: 'release_result', resultId: resultB1, note: 'B子管在污染时点前已独立密封，复核有效，可先交付' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await api(service.base, 'POST', '/api/deliveries', 'frontdesk-a', { resultId: resultB1 });
    assert.equal(r.status, 201);

    // A 更正版必须通知原实际接收人并说明失效范围；原交付事实保留。
    r = await api(service.base, 'POST', '/api/results', 'inspector-a', {
      commissionId: commA, testId: 'test-a', sampleId: 'tube-quality', revision: 2,
      status: 'corrected_invalid', invalidated: true, invalidatesScope: '第1版全部数值和结论', correctionNote: '原管污染，第1版失效，建议重新采样'
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const resultA2 = r.body.id;
    const notes = await api(service.base, 'GET', '/api/notifications', 'person-a');
    const correction = notes.body.find(n => n.type === 'correction_notice' && n.resultId === resultA2);
    assert.ok(correction);
    assert.equal(correction.recipientId, 'recipient-a-primary');
    assert.match(correction.invalidationScope, /全部/);
    await api(service.base, 'POST', '/api/quality/issues/qi-tube-quality/reviews', 'quality-a', { decision: 'release_result', resultId: resultA2, note: '放行失效更正通知' });
    r = await api(service.base, 'POST', '/api/deliveries', 'frontdesk-a', { resultId: resultA2 });
    assert.equal(r.status, 201);

    // 拒绝补采后，仍能看到 B 有效结果和 A 未完成原因。
    r = await api(service.base, 'POST', '/api/order-items/q-item-a/recollection-decision', 'person-a', { willing: false, reason: '近期不补采' });
    assert.equal(r.status, 200);
    const overviewA = (await api(service.base, 'GET', '/api/my/overview', 'person-a')).body;
    assert.ok(overviewA.groups.actuallyTested.some(x => x.id === 'q-item-a'));
    assert.ok(overviewA.groups.actuallyTested.some(x => x.id === 'q-item-b'));
    assert.ok(overviewA.groups.waitingSpecimen.some(x => x.id === 'q-item-a' && x.status === 'recollection_refused'));
    const reportsA = await api(service.base, 'GET', '/api/reports', 'person-a');
    assert.ok(reportsA.body.reports.length >= 3);

    // 新样本不能伪装成旧标本的更正。
    await api(service.base, 'POST', '/api/samples', 'collector-a', { sampleId: 'tube-retest-b-new', personId: 'person-b', sampleType: 'blood', container: 'tube-red', actualMl: '6.0', collectedAt: now(), conditions: [] });
    await api(service.base, 'POST', '/api/samples/tube-retest-b-new/usability', 'inspector-a', { testId: 'test-b', usable: true });
    const mismatch = await api(service.base, 'POST', '/api/results', 'inspector-a', { commissionId: commIndependentB, testId: 'test-b', sampleId: 'tube-retest-b-new', revision: 2, values: [] });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.code, 'SAMPLE_MISMATCH_NO_CORRECTION');
    r = await api(service.base, 'POST', '/api/commissions', 'frontdesk-a', { orderItemId: 'independent-b-item', sampleId: 'tube-retest-b-new', retest: true, destination: 'internal' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const commRetest = r.body.commission.id;
    r = await api(service.base, 'POST', '/api/results', 'inspector-a', { commissionId: commRetest, testId: 'test-b', sampleId: 'tube-retest-b-new', revision: 1, values: [], conclusion: '新标本的新检验，不是旧结果更正' });
    assert.equal(r.status, 201);
    assert.equal(r.body.revision, 1);

    // 开检后撤回的 B 项退款责任保持 pending_review/全额 retained，不生成“已退款”。
    const refunds = (await api(service.base, 'GET', '/api/refunds', 'admin-a')).body;
    const qualityBRefund = refunds.find(x => x.orderItemId === 'q-item-b');
    // 尚未主动申请时，责任可在 trace/order 中体现；申请后必须进入核定而非自动全额退款。
    if (!qualityBRefund) {
      r = await api(service.base, 'POST', '/api/refunds', 'person-a', { orderItemId: 'q-item-b', reason: '退未完成报告项目' });
      assert.equal(r.status, 201);
      assert.equal(r.body.refund.status, 'pending_review');
      assert.equal(r.body.refund.responsibleRefundMinor, 0);
      assert.equal(r.body.refund.retainedMinor, 3000);
    }

    // ---------- 重启后追溯标本去向、项目状态和退款责任 ----------
    await service.stop();
    service = await startService(serviceState, peer.base);
    const trace = (await api(service.base, 'GET', '/api/samples/tube-quality/trace', 'admin-a')).body;
    assert.ok(trace.lineageSampleIds.includes('child-quality'));
    const qualityCommission = trace.commissions.find(c => c.outboundRequestId === 'comm-quality-b');
    assert.ok(qualityCommission);
    assert.ok(['completed', 'resulted'].includes(qualityCommission.status) || qualityCommission.facts.some(f => f.normalizedStatus === 'completed'));
    assert.ok(qualityCommission.facts.some(f => f.normalizedStatus === 'testing'));
    assert.ok(qualityCommission.facts.some(f => f.normalizedStatus === 'received'));
    assert.ok(trace.deliveries.some(d => d.id === deliveryA1));
    assert.ok(trace.notifications.some(n => n.type === 'correction_notice'));
    assert.ok(trace.currentWhereabouts.some(x => x.sampleId === 'child-quality' && /开检|外送/.test(x.location)));

    const canceledAfterRestart = (await api(service.base, 'GET', '/api/refunds', 'admin-a')).body.find(x => x.orderItemId === 'cancel-item-b');
    assert.equal(canceledAfterRestart.status, 'refunded');
    assert.equal(canceledAfterRestart.originalProviderPaymentId, 'pay-cancel-1');
    const orderQualityAfter = (await api(service.base, 'GET', '/api/orders/order-quality', 'admin-a')).body;
    assert.ok(orderQualityAfter.items.find(i => i.id === 'q-item-b').refundResponsibility.refundAllowed === false);
    const peerRequest = await peerAdmin(peer, 'GET', '/requests/comm-quality-b');
    assert.equal(peerRequest.status, 200);
  } finally {
    await service.stop().catch(() => {});
    await peer.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
