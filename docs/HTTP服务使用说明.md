# 体检业务 HTTP 服务真实入口与操作说明

本服务是零第三方运行依赖的 Node.js 22 HTTP 服务，承接：

1. 套餐/新受检订单与逐项报价；
2. 加项本人知情同意、价格与标本范围；
3. 采样、实际量、容器、条件和交接；
4. 检验人员确认可用性；
5. 原管/子管谱系与剩余量原子占用；
6. 院内或外送检验委托、断连核对、开检/完成事实；
7. 支付回执、取消、退款责任和原渠道退款；
8. 结果版本、质量暂停/复核放行、交付事实与更正通知；
9. 重启后的标本去向、项目状态和退款责任追溯。

## 1. 启动入口

安装/核查：

```sh
npm ci --ignore-scripts
npm run check:data
```

终端一：启动外送检验/支付渠道本地替身，默认 `127.0.0.1:4300`：

```sh
npm run peer
```

终端二：启动业务服务，默认 `http://127.0.0.1:4100`：

```sh
npm start
```

可覆盖配置：

```sh
PORT=4100 \
SERVICE_HOST=127.0.0.1 \
SERVICE_STATE=.local/service-state.json \
PEER_BASE_URL=http://127.0.0.1:4300 \
PEER_KEY=local-synthetic-peer \
npm start
```

健康检查与入口清单：

```sh
curl -s http://127.0.0.1:4100/health
curl -s http://127.0.0.1:4100/
```

业务状态是单个原子写入的 JSON 文件，默认 `.local/service-state.json`。停止并重启进程后，订单、同意、标本谱系、委托流水、结果、交付、通知和退款责任仍可查询。

如需把 `data/records.json` 中的 10 条合成输入映射到已启动的服务，可另开终端运行：

```sh
npm run replay-records
# 可覆盖 SERVICE_BASE_URL
```

该脚本是幂等读取/创建导向的重放助手；完整的争用、断连、质量影响和重启断言仍以 `npm run check:business` 为准。

一键业务贯穿检查会自行启动随机端口的联调端和业务服务、使用临时状态并在结束后清理：

```sh
npm run check:business
# 等价于运行 test/business.test.mjs
npm test
```

## 2. 合成身份与权限

本地合成环境直接把下列值作为 `Authorization: Bearer <token>`；它们不是生产密钥。

| 身份 | Bearer token | 可办理事项 |
|---|---|---|
| 前台/中心受理 | `frontdesk-a` | 建单、加项报价、支付意向、占用、交接、委托、交付、退款核定 |
| 医生 | `doctor-a` | 记录建议；医生建议不会创建本人同意 |
| 采样员 | `collector-a` | 采集、分装、交接 |
| 检验确认人员 | `inspector-a` | 确认标本对具体项目可用、登记不适用事实、录入院内结果 |
| 质量人员 | `quality-a` | 质量暂停、影响定位、复核放行/关闭 |
| 管理员 | `admin-a` | 中心管理和查询 |
| 受检者甲/乙 | `person-a` / `person-b` | 本人同意/撤回、本人总览、本人报告、本人退项 |
| 外送机构 | `lab-a` | 仅能读取/回执委托给 `lab-a` 的委托和结果 |
| 支付回执 | `payment-gateway` | 支付/退款回执，不读取业务全量资料 |

也可用 `x-api-key: <token>`。

权限要点：

- `collector-a` 调用 `POST /api/quality/issues` 会得到 `403 COLLECTOR_QUALITY_FORBIDDEN`；采集人也不能批准本人采集标本的质量结论。
- `lab-a` 读取没有委托给本机构的订单/项目时返回 `403`，例如 `GET /external/orders/order-race`。
- 受检者只能访问本人订单、标本、总览和报告。

## 3. 核心 HTTP 接口

所有请求和响应均为 JSON。时间使用 ISO 8601；体积是 ml 十进制字符串，金额 `amountMinor` 是整数分。

### 3.1 目录与身份

```http
GET /api/catalog
GET /api/me
```

### 3.2 套餐/订单和加项

建单时可直接给逐项金额，也可用目录中的 `packageId`：

```http
POST /api/orders
Authorization: Bearer frontdesk-a
Content-Type: application/json

{
  "orderId": "order-demo",
  "personId": "person-a",
  "items": [
    { "itemId": "item-a", "testId": "test-a", "amountMinor": 2000 }
  ]
}
```

套餐优惠分摊以建单时每个 item 的 `amountMinor/quotedAmountMinor/priceQuote` 为准。退款只退该项目自己的分摊额，不重新提高其他项目价格。

增加一个待确认加项：

```http
POST /api/orders/order-demo/items
Authorization: Bearer frontdesk-a

{
  "itemId": "item-b",
  "testId": "test-b",
  "amountMinor": 3000,
  "doctorId": "doctor-a",
  "suggestionNote": "医生建议，但需本人确认"
}
```

医生建议只写入 `doctorSuggestion`，项目状态仍是 `pending_consent`。

受检者本人确认项目、价格和标本范围：

```http
POST /api/consents
Authorization: Bearer person-a

{
  "consentId": "consent-b",
  "orderItemId": "item-b",
  "agreedAmountMinor": 3000,
  "allowRemainingSample": true,
  "allowedSampleIds": ["tube-demo"]
}
```

- `agreedAmountMinor` 必须等于报价。
- `allowedSampleIds` 是更严格的标本范围；省略表示允许本人同意范围内的现有剩余标本。
- `allowRemainingSample:false` 表示必须重新采样。
- 可附 `"occupySampleId":"tube-demo"` 在同一原子事务中确认并占用。

撤回某项同意：

```http
POST /api/consents/consent-b/withdraw
Authorization: Bearer person-a

{ "reason": "本人撤回本项" }
```

只影响该 `orderItemId`；其他有效同意不变。若已有外送委托，能否取消和退款取决于外送方是否已开检。

### 3.3 采样、可用性、余量和分装

采样员记录：

```http
POST /api/samples
Authorization: Bearer collector-a

{
  "sampleId": "tube-demo",
  "personId": "person-a",
  "sampleType": "blood",
  "container": "tube-red",
  "actualMl": "6.0",
  "collectedAt": "2026-11-27T08:00:00+08:00",
  "conditions": ["fasting"]
}
```

检验人员按项目确认适用条件：

```http
POST /api/samples/tube-demo/usability
Authorization: Bearer inspector-a

{
  "decisions": [
    { "testId": "test-a", "usable": true, "applicableConditionsConfirmed": true },
    { "testId": "test-b", "usable": true }
  ]
}
```

不满足条件时登记事实：

```json
{ "testId": "test-a", "usable": false, "reason": "已超过4小时适用期限/缺少空腹条件" }
```

该项目会变为 `waiting_specimen` 并写明原因；已付款不改变标本不适用的事实。

占用剩余量：

```http
POST /api/order-items/item-b/occupy
Authorization: Bearer frontdesk-a

{ "sampleId": "tube-demo" }
```

余量公式为：

```text
可占用量 = 原管实际量 - 已分出子管实际量 - 未释放占用量
```

所有“检查余量并写入占用”都在服务端串行事务中完成。两个不同加项并发占用同一剩余管时，只有实际余量足够的一个返回 `201`；另一个返回 `409 INSUFFICIENT_SPECIMEN`，项目进入 `waiting_specimen`，不会借用未采集量。

分装子管：

```http
POST /api/samples/tube-demo/aliquots
Authorization: Bearer collector-a

{
  "sampleId": "child-demo",
  "orderItemId": "item-b",
  "actualMl": "3.0"
}
```

子管保存 `parentSampleId`、`sourceSampleId`、`rootSampleId` 和实际量。取消委托不会把已分装量加回原管；谱系仍可追踪。

交接：

```http
POST /api/handoffs
Authorization: Bearer collector-a

{
  "sampleId": "tube-demo",
  "toHolderId": "inspector-a",
  "location": "交接至检验确认台"
}
```

追溯标本实际去向：

```http
GET /api/samples/tube-demo/trace
Authorization: Bearer frontdesk-a
```

返回谱系、余量、交接事件、委托/外送流水、结果、交付、通知、质量事项和当前持有人/位置。

### 3.4 检验委托与外送断连核对

院内委托：

```http
POST /api/commissions
Authorization: Bearer frontdesk-a

{ "orderItemId": "item-a", "destination": "internal" }
```

外送委托可传稳定 `requestId`，便于和联调端流水对应：

```http
POST /api/commissions
Authorization: Bearer frontdesk-a

{
  "orderItemId": "item-b",
  "destination": "external",
  "labId": "lab-a",
  "requestId": "comm-demo-b"
}
```

若联调端配置为 `disconnectAfterAccept`，本服务会持久化 `dispatch_unknown` 并返回 `202`。此时：

- 不会声称标本仍在本院；
- 不会允许为同一项目另造一管/第二个在途委托；
- 必须查原委托流水：

```http
POST /api/commissions/<commissionId>/reconcile
Authorization: Bearer frontdesk-a
```

该接口调用联调端 `GET /requests/<outboundRequestId>`，把实际 `received/testing/completed` 事实写回。

取消委托：

```http
POST /api/commissions/<commissionId>/cancel
Authorization: Bearer frontdesk-a

{ "cancelRequestId": "cancel-demo-b" }
```

联调端可在操作前配置：

```sh
curl -X PUT http://127.0.0.1:4300/admin/plans/cancel-demo-b \
  -H 'content-type: application/json' \
  -H 'x-peer-key: local-synthetic-peer' \
  -d '{"mode":"normal","result":{"status":"cancelled"}}'
```

或：

```json
{
  "mode": "normal",
  "result": { "status": "alreadyTesting", "chargeMinor": 3000 }
}
```

- `cancelled`：开检前取消成功，释放未使用占用；未分装量恢复为可占用，已分装量不回原管；已付未执行项目自动形成全额退款。
- `alreadyTesting`：委托无法撤回，记录开检事实和费用后果，不允许按迟到撤回全额冲销。

### 3.5 外送机构入口

外送机构使用 `Bearer lab-a`：

```http
GET  /external/commissions
GET  /external/commissions/<centralOrExternalOrRequestId>
POST /external/commissions/<lookup>/receipt
POST /external/results
GET  /external/orders/<orderId>
GET  /external/tests/<testId>
```

结果必须同时对应委托、`testId` 和委托时的 `sampleId`：

```json
{
  "commissionId": "ext-demo-b",
  "testId": "test-b",
  "sampleId": "child-demo",
  "revision": 1,
  "values": [{ "code": "synthetic", "value": "ok" }],
  "conclusion": "合成检验结果；中心不据此判断疾病"
}
```

`revision` 只在同一委托项目内递增。相同 revision 和相同内容可幂等重发；同版本不同内容返回 `409`。

### 3.6 支付下单、支付回执与退款责任

可先创建支付意向：

```http
POST /api/payments/intents
Authorization: Bearer person-a

{ "orderId": "order-demo", "orderItemIds": ["item-b"] }
```

也可直接调用 `POST /api/payments`；服务会保存报价快照并调用联调端 `pay` 操作。若联调结果返回 `paymentId`，该入口会顺带按支付成功入账。真实渠道异步回执仍应调用：

```http
POST /api/payments/receipts
Authorization: Bearer payment-gateway

{
  "providerPaymentId": "pay-demo-1",
  "orderId": "order-demo",
  "amountMinor": 5000,
  "paidAt": "2026-11-27T09:00:00+08:00"
}
```

回执会保存付款时的逐项报价快照。也可先创建 `POST /api/payments/intents`。

受检者对未完成项目申请退项：

```http
POST /api/refunds
Authorization: Bearer person-a

{ "orderItemId": "item-b", "reason": "项目未完成" }
```

系统区分：

- 无费用：`no_money_due`；
- 未委托/未执行且取消成功：`approved`，全额退该项目分摊金额，并向原 `providerPaymentId` 对应渠道发起退款；
- 已开检/已有执行事实：`pending_review`，记录 `responsibleRefundMinor`、`retainedMinor` 和责任原因，不能自动全额冲销；
- 中心可 `POST /api/refunds/:id/decision` 核定部分退款；
- 渠道结果可用 `POST /api/refunds/:id/reconcile` 或 `POST /api/refunds/receipts` 写回。

### 3.7 质量暂停、独立放行、交付和更正

质量人员对原管或子管登记污染/身份待核：

```http
POST /api/quality/issues
Authorization: Bearer quality-a

{
  "issueId": "qi-demo",
  "sampleId": "tube-demo",
  "kind": "contamination",
  "reason": "合成污染待核"
}
```

影响定位：

```http
GET /api/quality/issues/qi-demo/impact
Authorization: Bearer quality-a
```

影响范围按 `parentSampleId → child` 谱系、分配、委托、结果和交付外键计算，包含：

- 受影响原管和所有子管；
- 订单项目、委托和结果；
- 已经发出的交付事实及实际接收人；
- 受影响受检者。

因此不会按“同名项目”停掉另一位受检者的结果。

未放行的关联结果调用交付会返回 `409 QUALITY_HOLD_DELIVERY_BLOCKED`。复核认定某结果独立有效后可单独放行：

```http
POST /api/quality/issues/qi-demo/reviews
Authorization: Bearer quality-a

{
  "decision": "release_result",
  "resultId": "res-demo-b",
  "note": "该子管在污染前已独立密封，复核有效"
}
```

然后可以先交付这一有效项目，不必等待所有项目齐备。

交付：

```http
POST /api/deliveries
Authorization: Bearer frontdesk-a

{
  "resultId": "res-demo-a1",
  "recipientId": "recipient-a-primary",
  "channel": "in-app-report"
}
```

交付事实不可删除或覆盖。更正版使用同一委托和同一标本递增 `revision`，并必须给出 `invalidatesScope`：

```json
{
  "commissionId": "comm-demo-a",
  "testId": "test-a",
  "sampleId": "tube-demo",
  "revision": 2,
  "invalidated": true,
  "invalidatesScope": "第1版全部数值和结论",
  "correctionNote": "原管污染，第1版失效"
}
```

系统会向第 1 版的所有实际接收人生成 `correction_notice`。查询：

```http
GET /api/notifications
Authorization: Bearer person-a
```

重新采样必须创建新 `sampleId` 和新委托。若试图把新标本结果作为旧委托的 revision 2 写入，会返回 `409 SAMPLE_MISMATCH_NO_CORRECTION`。新委托的结果从 `revision:1` 开始，是新标本结果，不是旧标本更正。

受检者拒绝补采：

```http
POST /api/order-items/item-a/recollection-decision
Authorization: Bearer person-a

{ "willing": false, "reason": "暂不补采" }
```

该项目显示 `recollection_refused` 和未完成原因；其他有效结果仍可查询、复核放行和交付。

## 4. 受检者视图

```http
GET /api/my/overview
Authorization: Bearer person-a
```

返回三个分组：

- `groups.approved`：已有有效同意/套餐授权且未实际检验；
- `groups.waitingSpecimen`：已获准但余量不足、标本不适用、等待新标本或拒绝补采；
- `groups.actuallyTested`：已有开检/完成事实或结果版本。

中心人员可查：

```http
GET /api/people/person-a/overview
GET /api/reports?personId=person-a
```

## 5. 自动化业务检查覆盖的过程

`test/business.test.mjs` / `npm run check:business` 会真实启动 HTTP 服务和联调端，覆盖：

1. 采样员批准质量结论被拒、外送方读取未委托订单被拒；
2. 两个 2ml/3ml 加项并发占用 4ml 标本，恰好一个成功，另一个进入等待标本；
3. 开检前取消外送委托，验证余量释放、原支付渠道退款和重启后退款责任；
4. 已分装后取消，验证子管保留且 2ml 不恢复回原管；
5. 套餐 2000+2500 分摊，退 B 项 2500 后 A 项仍为 2000；
6. 外送接收端受理后断连，中心保存 `dispatch_unknown`，阻止重复送管，并通过原流水核对 `received/testing`；
7. 本人撤回同意后取消委托碰到 `alreadyTesting`，记录不得全额冲销的费用/退款责任；
8. 原管污染定位子管、项目、未交付结果和已交付接收人；
9. 另一位受检者的同项目结果仍可交付；
10. 质量复核后独立有效的 B 项先交付；
11. A 项更正版通知原实际接收人并说明失效范围，原交付事实保留；
12. 新标本不能冒充旧标本更正；
13. 拒绝补采后仍可查看其他有效结果和未完成原因；
14. 重启业务进程后，通过 trace 和管理查询核实标本去向、委托事实、结果、交付、通知与退款责任。
