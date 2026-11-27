# 体检加项的同意范围、标本占用与检验交付

Node.js 22、无第三方运行依赖的 HTTP 后端，承接套餐下单、加项知情同意、采样交接、检验委托、外送核对、支付退款回执、结果版本、质量暂停和报告交付。系统只记录并执行检验人员确认的适用条件，不根据检验数值判断疾病，也不会自行增加检查项目。

> 完整中文接口手册：[`docs/HTTP服务使用说明.md`](docs/HTTP服务使用说明.md)。

## 快速启动

```sh
npm ci --ignore-scripts
npm run check:data
npm test
```

启动外送检验/支付渠道联调替身（默认 `127.0.0.1:4300`）：

```sh
npm run peer
```

另开终端启动业务服务（默认 `http://127.0.0.1:4100`）：

```sh
npm start
```

验证：

```sh
curl -s http://127.0.0.1:4100/health
curl -s http://127.0.0.1:4100/
```

业务状态默认写入 `.local/service-state.json`；可用 `PORT`、`SERVICE_STATE`、`PEER_BASE_URL`、`PEER_KEY` 覆盖。重启后订单、同意、标本谱系、委托流水、结果、交付、通知和退款责任仍可查询。

## 一键业务贯穿检查

```sh
npm run check:business
```

它会启动临时业务服务和联调端，完整验证：

- 两个加项并发争用剩余标本时只有实际足够的项目占用成功；
- 撤回同意后取消外送委托碰到 `alreadyTesting` 的费用后果；
- 外送端受理后断连时不重复送管，而是核对原 `requestId` 流水；
- 开检前取消后的余量释放与原渠道退款；
- 已分装量不恢复回原管；
- 原管污染沿谱系影响子管、项目、结果和已交付接收人，但不会停掉另一位受检者的同名项目；
- 质量复核后独立有效项目可先交付；
- 更正通知实际接收人，新采样不能伪装成旧标本更正；
- 重启后仍可查清标本实际去向、项目完成情况和退款责任。

## 合成身份

本地 Bearer token 直接使用合成行为主体 ID：

- 中心：`frontdesk-a`、`doctor-a`、`collector-a`、`inspector-a`、`quality-a`、`admin-a`
- 受检者：`person-a`、`person-b`
- 外送检验：`lab-a`
- 支付回执：`payment-gateway`

例如：

```sh
curl -s http://127.0.0.1:4100/api/my/overview \
  -H 'Authorization: Bearer person-a'
```

权限会阻止采样员批准质量结论，也会阻止外送方读取未委托给 `lab-a` 的订单或项目。

## 资料与联调协议

- [`docs/资料约定.md`](docs/资料约定.md)：目录、记录、体积、期限、版本和标识约定。
- [`docs/联调协议.md`](docs/联调协议.md)：外部检验/收单本地替身的流水、断连和人工结果配置。
- `data/catalog.json`：合成检查项目、容器、最低用量、期限、条件、人员和两个初始标本。
- `data/records.json`：待校核的合成业务输入；它不是接口路径约定。

## 容器

默认镜像命令现在启动业务服务：

```sh
docker build -t exam-specimens-local .
docker run --rm -p 127.0.0.1:4100:4100 \
  --mount type=volume,source=exam-specimens-state,target=/home/node/state \
  -e SERVICE_STATE=/home/node/state/service.json \
  exam-specimens-local
```

仍需运行联调端时覆盖启动命令：

```sh
docker run --rm -p 127.0.0.1:4300:4300 \
  --mount type=volume,source=exam-specimens-state,target=/home/node/state \
  -e PEER_STATE=/home/node/state/peer.json \
  exam-specimens-local npm run peer
```

所有人物、证件、账户和业务编号均为合成值；不需要真实系统账号。
