# agent-notify-dsh

把 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（DSH）的 agent 生命周期事件转发给
[agent-notify](https://github.com/hellolib/agent-notify)，从而在授权等待、提问等待、任务完成或任务失败时收到桌面与手机推送。

---

## 当前状态：插件侧已完成，上游 Go 侧尚未交付

本仓库**只产出 DSH 插件侧**（TypeScript）。要真正收到通知，还需要 agent-notify 本体提供
`handle-dsh-hook` 子命令——该子命令目前**尚未实现**，属于上游仓库
[agent-notify](https://github.com/hellolib/agent-notify) 的 **M2 任务**
（见其 `docs/dsh-integration-plan.md` §5「M2 · Go 侧接入」）。

> 如实说明：`handle-dsh-hook` 与本仓库是**两个**交付面。在本仓库安装插件、但上游 M2 未落地之前，
> 插件会照常注册监听器并把载荷写到 stdin（或静默放弃定位失败的投递），但**不会产生任何通知**。
> 这是「缺少接收端」，不是插件故障。

在上游仓库中确认接收端可用：

```bash
agent-notify handle-dsh-hook --help   # M2 交付后此命令才存在
```

---

## 安装

### 1. 先装 agent-notify 本体

插件不自带二进制，它会去本机查找 agent-notify 可执行文件（默认落点
`~/.agent-notify/agent-notify`，Windows 为 `agent-notify.exe`）：

```bash
npx agent-notify        # 交互式向导：下载平台二进制 + 配置渠道
# 或按上游 README 的方式构建/安装，最终二进制需落在 ~/.agent-notify/
```

### 2. 再装 DSH 插件

```bash
# 从 npm 安装
dsh plugin --profile web add agent-notify-dsh

# 本地开发：以 link: 方式安装本仓库
dsh plugin --profile web add link:/Users/liming/Documents/agent-notify-dsh
```

注意：

- `dsh plugin` 内部转发给 pnpm，并按 `dsh.profile.bundles` 记账；**不要手改** profile 的
  `package.json` 或 `node_modules`。
- `desktop` profile 由 Electron 应用独占管理，会被 DSH 直接拒绝（`apps/cli/src/args.ts` 的
  `rejectElectronProfile`）；如需指定 profile，请用 `web` 或自建 profile。
- 卸载：`dsh plugin --profile web remove agent-notify-dsh`。

---

## 事件映射

插件把 5 类 DSH 事件转换为一行 JSON 写入二进制的 stdin，字段名沿用 Claude Code 方言
（`hook_event_name` / `session_id` / `cwd` / `tool_name` / `reason` / `question` / `error`），
以便上游复用既有的 Claude Code 解析器。契约见 [`docs/CONTRACT.md`](docs/CONTRACT.md) §1。

| `hook_event_name` | 归一化事件 | DSH 来源 | 说明 |
|---|---|---|---|
| `SessionStart` | `session_start` | `agent/created`（仅根 agent） | **仅点击聚焦捕获，不发通知** |
| `ApprovalRequest` | `permission_required` | `approval/request` | 等待授权——核心增量 |
| `UserQuestion` | `input_required` | `user-questions/request` | 等待用户回答 |
| `Stop` | `run_completed` | `agent/turn-stopping` | 一轮结束 |
| `RunFailed` | `run_failed` | `agent/error` | 运行失败 |

只对**根 agent** 触发：子 agent（subagent）的事件一律被过滤，避免刷屏并污染点击聚焦的窗口缓存
（契约 §4.3）。

---

## 为什么需要这个插件：相对 DSH 自带 Claude Code bridge 的增量

DSH 内置 `@deepseek-ai/dsh-hooks-claude-code`，它能直接跑未修改的 Claude Code 命令式 hook。
但它**只认 7 个事件**（`packages/hooks/hooks-claude-code/src/config.ts:11-19`）：

```ts
const CLAUDE_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse',
  'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop',
] as const
```

而 agent-notify 写给 Claude Code 的事件是 5 个
（`agent-notify/internal/claudehooks/settings.go:17-23`）：
`SessionStart` / `PermissionRequest` / `Notification` / `Stop` / `PostToolUseFailure`。

**交集只有 `SessionStart` 与 `Stop`：**

| agent-notify 写入 CC 的事件 | 归一化事件 | DSH CC bridge 是否支持 |
|---|---|---|
| `SessionStart` | `session_start`（仅聚焦捕获） | 支持 |
| `PermissionRequest` | `permission_required` | **静默丢弃** |
| `Notification` | `input_required` | **静默丢弃** |
| `Stop` | `run_completed` | 支持 |
| `PostToolUseFailure` | `run_failed` | **静默丢弃**（bridge 只有 `PostToolUse`） |

`parseClaudeCodeConfig` 只遍历该白名单（同文件 `:86`），**表外事件不报错、不告警**——用户会以为装好了，
实际上只有 2/4 事件生效，而**「等待授权」恰恰是这类工具最核心的通知场景**。

因此本插件不走向 CC bridge 兼容层，而是走**原生 Cordis 插件**路线，直接订阅
`approval/request` 与 `user-questions/request` 两个 waterfall 扩展点，
把 `permission_required` / `input_required` / `run_failed` 三个事件补齐。

### 两条 waterfall 的纪律（对 DSH 是安全前提）

`approval/request` 与 `user-questions/request` 都是 waterfall，`ApprovalOutcome` 是 fail-closed 闭集：
监听器如果不调用 `next()` 就返回，会**短路整条审批链**，导致工具被拒或授权弹窗永不出现。

本插件的两个监听器一律「先通知、再无条件委托」，且通知包在 `try/catch` 内、`return next()` 放在
`try` 之外：

```ts
ctx.on('approval/request', (req, next) => {
  try { forward({ /* ... */ }) } catch { /* swallow */ }  // 只通知
  return next()                                           // 必须：不可省略、不可条件化
})
```

所有监听器体都包 `try/catch`（`agent/created` 是 await 的，抛出会污染会话启动）；
投递使用分离式 `spawn` + `unref()`，**永不阻塞、永不抛出**。契约见 §4。

---

## 配置

配置由 schemastery 校验，4 个字段都带默认值，因此 `{}` 即合法。定义见
[`src/config.ts`](src/config.ts)。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `true` | 关闭后监听器仍注册，但不投递任何事件（便于单独测量监听器开销） |
| `binaryPath` | `string`（可选） | 未设置 | 指定 agent-notify 二进制绝对路径。设置后**优先于**环境变量（它覆盖下面的定位第 1 级） |
| `sessionStart` | `boolean` | `true` | 是否转发 `agent/created` 为 `SessionStart`。它不发通知，只为让 Go 侧捕获本会话的点击聚焦窗口 |
| `debug` | `boolean` | `false` | 每次投递向插件 logger 打一行诊断；默认静默 |

写进 profile 的 patch 会**整行替换** `config` 而非合并，所以只写非默认值即可，例如：

```yaml
- insert:
    - id: agent-notify-dsh
      name: agent-notify-dsh
      config:
        debug: true
        binaryPath: /Users/me/.agent-notify/agent-notify
```

---

## 二进制定位（固定 3 级优先级）

严格按契约 §2 顺序解析，**找不到就静默放弃，绝不抛出**：

1. 环境变量 `AGENT_NOTIFY_BINARY`（非空即用，便于 `make local` 与测试）
2. `<home>/.agent-notify/agent-notify`（Windows 为 `agent-notify.exe`）——npx launcher 与 `make local` 的共同落点
3. 都没有 → 返回 `null`，该次投递静默丢弃

`home` 取 `os.homedir()`。插件配置里的 `binaryPath`（见上表）会覆盖第 1 级。

---

## 兼容性

- **开发基线：DSH 已发布包 `0.2.0-rc.1`**（`@deepseek-ai/dsh-agent` / `dsh-session` /
  `dsh-user-approval` / `dsh-user-questions` 均锁定该版本；`peerDependencies` 为
  `@deepseek-ai/cordis ~4.0.4`）。
- DSH 处于 rc/alpha 阶段，事件签名可能漂移。插件对未知事件名静默跳过，不会因此报错。
- Node.js `>=20`。

### 挂载方式

插件是标准 npm 包，manifest 里声明 bundle patch：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

DSH 启动时按 bundle 层栈叠加各插件的 patch，本插件用一条 `insert` 把自己的 entry 插入 profile 的配置树
（见 [`cordis.patch.yml`](cordis.patch.yml)）：

```yaml
- insert:
    - id: agent-notify-dsh
      name: agent-notify-dsh
```

`name` 与 [`src/index.ts`](src/index.ts) 导出的 `name` 一致；`inject` 刻意声明为空数组，
这样 `agents` 服务缺失时插件仍能加载（否则整个 profile 起不来），根判定处用
`ctx.agents?.roots() ?? []` 做可选访问。

---

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # 产物到 lib/
```

CI（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）在 push 与 pull_request 上按
Node 20 / 22 矩阵跑 `npm ci` → `npm run typecheck` → `npm test`。

---

## 许可

[MIT](LICENSE)
