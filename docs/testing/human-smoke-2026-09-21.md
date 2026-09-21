# 真人烟测记录｜2026-09-21

> 目的：记录 2026-09-21 对 Agent Publisher 当前 MVP 的真人运行证据、阻塞点与后续工作映射。
>
> 口径：代码 / 配置 / runtime 是当前技术事实；Issue 是工作项合同；本文只作为本轮真人 smoke evidence，不替代实现合同或验收结论。

## 一、环境与范围

- Base：`dev`
- 平台：小红书图文
- 浏览器：Docker `browser-runtime` + Chromium + noVNC
- Web：Vite dev server
- API：`app-runtime`
- Material source：`provider_pipeline`
- AI：OpenAI-compatible provider，经 `PUBLISHER_AI_BASE_URL` / `PUBLISHER_AI_API_KEY` / `PUBLISHER_AI_MODEL` 注入
- 最终发布未执行；本轮只验证发布前链路。

## 二、本轮结论

当前系统已经证明不是纯 fixture：

- Web 可以创建真实 Job；
- Job / checkpoint 可持久化；
- app-runtime 重启后同一 Job 仍可恢复；
- 首页刷新后真实任务仍存在；
- 真实 AI Content Secretary live smoke 已通过；
- browser profile 可跨 `browser-runtime restart` 保持真实小红书登录态；
- noVNC 本机访问可用；
- 非支持页面的 fail-closed 生效。

但完整预发布链 **尚未通过**。当前存在两个独立 blocker：

1. Material pipeline 在 Web 真任务中停止，页面显示“预发布物料当前不可用”；
2. XHS real prepare 在已登录 Creator 页面仍返回 `BROWSER_INTERACTION_FAILED`，底层阶段/错误被过度泛化。

此外，失败页的“从该步骤重试”按钮当前为硬编码 `disabled`，并不存在真实恢复动作。

## 三、逐项真人证据

| 验收项 | 结果 | 证据 / 备注 |
| --- | --- | --- |
| noVNC 本机访问 | PASS | `127.0.0.1:6080` 可连接真实 Chromium |
| Browser Profile 登录态持久化 | PASS | 真人登录小红书后执行 `docker compose restart browser-runtime`，重连后仍保持登录 |
| 非支持页面 fail-closed | PASS | 普通小红书用户页执行 smoke 时返回 `UNSAFE_BROWSER_PAGE`，未继续导航 |
| 真人登录接管 | PASS | smoke 进入 `waiting_for_login` + `login_required`，可在 Live View 完成人工登录 |
| 登录后自动恢复 | 未充分覆盖 | 后续被 `BROWSER_INTERACTION_FAILED` 混在一起，不能仅凭现有证据断言自动 resume 成功或失败 |
| XHS Creator 已登录入口 | PASS | 已确认真实 Creator 发布入口处于认证状态 |
| XHS 图文 prepare | FAIL / BLOCKER | 已登录、支持页面上仍返回 `SMOKE_BLOCKED` / `BROWSER_INTERACTION_FAILED` |
| 真 AI Content Secretary | PASS | `PUBLISHER_LIVE_MODEL_SMOKE=1 npm run smoke:content-secretary-live` 真人执行成功 |
| Web -> API -> 真 Job | PASS | Web 显示“真实 Job · APP-02”并进入执行流程 |
| Web 刷新恢复同一 Job | PASS | 刷新后仍为同一 Job、同一持久状态 |
| app-runtime 重启后 Job 恢复 | PASS | 重启后当前 Job 仍可读取，状态未丢失 |
| 首页真实任务列表持久化 | PASS | 返回首页、刷新后真实 Job 仍存在 |
| Failure UX 隐藏 raw stack | PASS | 页面只展示安全化停止位置 / 原因 / 恢复策略 |
| Material pipeline | FAIL / BLOCKER | Web 真 Job 停在“准备素材包 / 预发布物料当前不可用” |
| 失败步骤 retry | FAIL | UI 按钮存在但当前代码硬编码 `disabled` |
| 最终发布 | 未测试 | 不在本轮安全边界内 |

## 四、已确认的问题清单

### F-01 Live View 只能 loopback

当前 Compose：

```yaml
ports:
  - "127.0.0.1:6080:6080"
```

本机 noVNC 可用，但通过宿主机 LAN IP（例如 `192.168.1.x:6080`）无法访问。

需求侧希望允许通过宿主机 IP 的浏览器直接打开 Live View。由于 noVNC 当前无独立认证，不能只把 bind 改成 `0.0.0.0` 而忽略访问控制。

### F-02 browser-runtime 缺 CJK 字体

真实小红书页面里的中文出现方框，严重影响真人登录 / 操作 / 排障。

注意：这是 Chromium 容器系统字体问题，不等同于 Takumi 渲染字体。

### F-03 smoke 命令对真人过于脆弱

当前真实 prepare 命令较长：

```bash
docker compose --profile app run --rm --build -e XHS_REAL_ACCOUNT_SMOKE=1 app-runtime npm run smoke:xhs-prepare
```

真人执行中出现过参数连写、环境变量拼写错误。应提供稳定的一键入口。

### F-04 XHS 错误诊断被过度泛化

当前真实 prepare 的底层异常会被归并为：

```text
SMOKE_BLOCKED
detailCode=BROWSER_INTERACTION_FAILED
The Xiaohongshu browser interaction stopped safely.
```

这能保护敏感信息，但不足以定位真实 DOM / 上传 / selector / wait 阶段问题。

建议保留安全边界，同时提供有界诊断字段，例如：

- phase
- URL category
- interaction stage
- bounded original error type / message

不得输出 token、cookie、profile 路径或其他凭据。

### F-05 XHS real prepare 真实兼容 blocker

已确认：
- Creator 页面已登录；
- 当前 URL 属于支持的 `creator.xiaohongshu.com/publish...`；
- 仍返回 `BROWSER_INTERACTION_FAILED`。

因此不能把问题归因于“用户没登录”或“页面不在支持范围”。

### F-06 AI Provider 配置缺少产品入口

AI provider 当前依赖 shell 临时环境变量：

- `PUBLISHER_AI_BASE_URL`
- `PUBLISHER_AI_API_KEY`
- `PUBLISHER_AI_MODEL`

终端关闭后配置丢失；重新创建 app-runtime 时必须再次注入。

MVP 需要产品化配置入口，最低包括：

- Base URL
- Model ID
- API Key
- 配置校验 / 连接测试
- Key 不回显、不写日志

### F-07 AI Base URL 校验有效，但反馈层级不合适

少写 `https://` 时 runtime 会拒绝启动，这是正确 fail-closed。

但错误目前主要出现在启动日志。产品 UI 应在输入阶段直接提示：
“Base URL 必须使用 HTTPS（loopback 开发地址除外）”。

### F-08 Web dev URL 与文档 / 预期不一致

当前 Vite 未配置 `server.host`，真人环境里：

- `http://localhost:5173` 可访问；
- `http://127.0.0.1:5173` 不可访问；
- Vite 显示 `Network: use --host to expose`。

需要统一 dev config、README 与真人验收文档的入口口径。

### F-09 Web 后端不可用反馈过于笼统

当 `127.0.0.1:3000` 没有监听时，Web 只显示“Agent Publisher API 请求失败”。

开发终端实际为：

```text
[vite] http proxy error: /api/jobs
Error: connect ECONNREFUSED 127.0.0.1:3000
```

UI 至少应区分“后台服务不可用 / 未启动”与普通业务错误。

### F-10 Material pipeline 真人 blocker

Web 真 Job 已进入 provider pipeline，但停止在：

```text
准备素材包
预发布物料当前不可用
```

目前无法仅凭 UI 判断具体失败发生在：

- Content Secretary / MaterialPlan；
- builtin image；
- baseline cover；
- design；
- AssetStore / renderer；

中的哪一步。

因此此项必须先通过运行日志 / JobStep evidence 定位，不能猜测根因。

### F-11 Failure retry 是伪 UI

当前 `web/src/App.tsx` 的失败页按钮为：

```tsx
<button className="secondary-button" disabled>
  从该步骤重试
</button>
```

但页面同时展示“可检查当前任务后安全重试”的恢复策略，产品语义冲突。

### F-12 app-runtime 稳定性存在待确认项

真人截图中，在 Material failure 页面出现后，Vite 又记录：

```text
/api/jobs
ECONNREFUSED 127.0.0.1:3000
```

按当前 orchestrator 设计，普通 material provider failure 应被捕获并返回 blocked 状态，不应直接杀死 Fastify 进程。

当前证据不足以证明 app-runtime 是因该异常崩溃，也可能是之后被其他操作停止。因此该项标记为：

**待确认，不得作为已证实 crash 结论。**

复现时应同步保存：

```bash
docker compose --profile app ps -a
docker compose --profile app logs --tail=200 app-runtime
```

### F-13 真人验收前置指引不完整

本轮实际踩到了多个“实现本身可能没坏，但新人不知道怎么启动”的问题：

- AI provider 配置没有在前置条件明确说明；
- 环境变量必须在启动 app-runtime 的同一 shell 生命周期中存在；
- 项目根目录 / docker 子目录的操作位置容易混淆；
- 长 smoke 命令容易输错；
- Web / API / browser-runtime 的启动顺序与健康检查没有一个统一入口。

真人验收文档应按完全新人路径重写，而不是要求测试者理解 Compose / Vite 架构后自行拼接。

## 五、Issue / 工作项映射

### 已有 Issue，优先回填证据，不重复建卡

- **#11 M1-04 Browser Profile 持久化与单会话约束**
  - 本轮新增真人证据：真实小红书登录态跨 browser-runtime restart 保持。
  - Issue 已完成；本文作为补充 evidence。

- **#50 XHS-01 登录态检测与人工接管恢复**
  - 已覆盖：`waiting_for_login`、`login_required`、人工真人登录。
  - 未充分覆盖：登录完成后的自动 resume 结果。

- **#51 XHS-02 图文 prepare / 回读 / 审批停止**
  - 当前 blocker：真实 Creator 页面 `BROWSER_INTERACTION_FAILED`。

- **#70 XHS-03 真人 prepare smoke harness**
  - 当前 harness 能 fail-closed，但命令 UX 与错误诊断不足。
  - real prepare 仍未通过。

- **#73 F3-01 Web UI 去 Fixture / 真实预发布接线**
  - 已覆盖：真实 Job、刷新恢复、app-runtime restart 恢复、首页真实任务持久化、失败态安全展示。
  - 未通过：完整链被 Material pipeline 阻塞。
  - 明确缺陷：失败页 retry 按钮硬编码 disabled。

- **#6 Material 图文基线 Provider 与可降级 MaterialPack**
  - 当前真人 blocker：真实 provider pipeline 无法完成 MaterialPack。

- **#78 MAT-05 MaterialPreparationService**
  - 实现已完成，但真人链在 Material 阶段失败。
  - 在定位具体失败点前，不应把该真人失败直接归因为 #78 某个子步骤。

### 建议新建的独立 implementation slices

本轮只记录建议，不在本文提交中自动创建新 Issue：

1. **AI 设置 UI + 持久化配置**
2. **browser-runtime CJK 字体**
3. **Live View LAN 访问 + 最小认证 / 暴露策略**
4. **真人 smoke 一键入口 + 有界诊断**
5. **app-runtime 稳定性 / 退出原因可观测性**（先复现确认，再决定是否建卡）

Web backend unavailable 提示、Vite host 口径、Failure retry 建议优先归入 #73 或拆出其后继小切片，避免重复造大卡。

## 六、下一轮最短复测路径

修复后不需要从头全部重跑。

1. 启动 browser-runtime + app-runtime + Web，并确认 AI 配置有效；
2. Web 创建一个新的真实图文 Job；
3. 验证 MaterialPack 真正生成，并人工检查标题 / 正文 / 图片；
4. 自动进入 Browser / XHS；
5. 未登录时确认 `waiting_for_login`，真人登录后确认自动 resume；
6. XHS 真 prepare 上传 + 填写 + readback；
7. 停在 `waiting_for_approval + approval_required`；
8. 刷新 / app-runtime restart 后仍保持同一 durable Job；
9. 全程不得触发最终发布。

## 七、当前放行边界

本轮可以确认：
- durable Job / SQLite 恢复链有真人证据；
- Browser Profile 登录态持久化有真人证据；
- AI live smoke 有真人证据；
- Web 已不是纯 fixture；
- 安全停止 / fail-closed 的多个边界真实生效。

本轮不能确认：
- Material pipeline 可交付真实 MaterialPack；
- XHS real prepare 可完成；
- 登录后自动 resume 完整闭环；
- Web 完整预发布链；
- 最终 publish。

因此当前 MVP 的“真实预发布主链”仍需修复后再次真人验收。
