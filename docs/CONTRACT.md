# 冻结接口契约 (Frozen Interface Contract) v1

> **本文件是并行开发的唯一权威契约。** 任何改动必须先由 Lead 修订本文件，禁止各 agent 自行变更。
> 依据：`agent-notify/docs/dsh-integration-plan.md`（开发计划 §3 接口约定）
> 基线：DSH 已发布包 `0.2.0-rc.1`（非本机 checkout 的 `0.1.7-alpha.2`，两者签名已核对一致）

---

## 0. 已闭合的 M0 前置验证结论

计划里的 5 个 M0 gate 已全部验证完毕，结论如下（**这些是实测结论，不得再当假设**）：

| Gate | 计划中的问题 | 实测结论 | 证据 |
|---|---|---|---|
| **M0-1** | 如何区分根/子 agent？ | **`ctx.agents.roots()`** | `dsh-agent/lib/types/index.d.ts:364`；实现过滤 `entry.owner === undefined` |
| **M0-2** | `spawn(detached)` 会不会阻塞？ | 用 `detached+unref`，与既有 OpenCode 插件同构 | `agent-notify/internal/opencodehooks/plugin/opencode.js:39-46` |
| **M0-3** | 不 `return next()` 会短路吗？ | **会**。两者都是 waterfall，`ApprovalOutcome` 是 fail-closed 闭集 | `dsh-user-approval/lib/types/types.d.ts:81`、`:26` |
| **M0-4** | patch entry `name` 能否用路径？ | **不需要**：DSH 全家桶已发布到 npm，走标准包名 | `npm view @deepseek-ai/dsh-agent versions` |
| **M0-5** | `dsh` 不在 PATH 怎么办？ | 有官方 npm 包：`@deepseek-ai/dsh`，bin 为 `dsh` | `npm view @deepseek-ai/dsh`（0.1.7-rc.2） |

**M0-1 的用法（唯一正确写法）**：

```ts
// 只对根 agent 触发；子 agent（subagent）不进通知，避免刷屏与聚焦缓存污染。
function isRoot(ctx: Context, agent: Agent): boolean {
  // ctx.get 而非 ctx.agents：属性访问对未 inject 的服务会抛错，见 §9。
  const roots = ctx.get('agents')?.roots()
  return roots === undefined ? true : roots.includes(agent)
}
```

> ⚠️ **`ctx.agents` 属性访问不可用**——它会抛 `cannot get property "agents" without inject`，
> 且该异常会被监听器强制的 try/catch 吞掉，导致完全静默。详见 §9（真实事故记录）。

> 为什么不能靠 `agent` 自身的字段：`Agent` 接口**没有** parent/root 字段（已核实 `runtime-types.ts` / 已发布 d.ts）。
> 归属关系只存在于 registry 的私有 `entry.owner`，对外**只能**通过 `roots()` 观察。
> `roots()` 返回新数组，按注册顺序；`agent` 的 owner 在 `enter()` 时写入、早于 `announce()`，
> 所以 `agent/created` 期间调用 `roots()` 已能看到正确的归属（`agent/src/index.ts:437-441, 464-472`）。

---

## 1. 载荷契约（插件 → agent-notify 二进制）

一行 JSON 写 stdin，沿用 Claude Code 方言字段名（理由见计划 §3.1）。

```ts
interface DshHookPayload {
  hook_event_name: 'SessionStart' | 'ApprovalRequest' | 'UserQuestion' | 'Stop' | 'RunFailed'
  session_id: string      // = agent.session.header.id
  cwd: string             // = agent.session.header.cwd ?? process.cwd()
  tool_name?: string      // ApprovalRequest: req.toolName
  reason?: string         // ApprovalRequest: req.reason ?? req.displayReason?.en
  question?: string       // UserQuestion: first question's .question
  error?: string          // RunFailed: normalized error message
}
```

事件映射表：

| `hook_event_name` | 归一化事件 | DSH 来源 |
|---|---|---|
| `SessionStart` | `session_start`（仅聚焦捕获，不发通知） | `agent/created`（仅根 agent） |
| `ApprovalRequest` | `permission_required` | `approval/request` |
| `UserQuestion` | `input_required` | `user-questions/request` |
| `Stop` | `run_completed` | `agent/turn-stopping` |
| `RunFailed` | `run_failed` | `agent/error` |

---

## 2. 二进制定位契约（固定 3 级优先级）

```ts
export function resolveBinary(env?: NodeJS.ProcessEnv): string | null
```

1. `process.env.AGENT_NOTIFY_BINARY`（非空即用，便于 `make local` 与测试）
2. `<home>/.agent-notify/agent-notify`（Windows 为 `agent-notify.exe`）——npx launcher 与 `make local` 的共同落点
3. 都没有 → 返回 `null`，**静默放弃，绝不抛出**

> `home` 取 `os.homedir()`；测试通过注入 `env` 与 `home` 覆盖，不依赖真实 HOME。

---

## 3. 模块划分（写入范围互不重叠）

```
src/
├── index.ts      # Cordis 插件入口：name / inject / apply —— 只做装配，不含业务
├── config.ts     # Config schema (schemastery)
├── payload.ts    # 事件 → DshHookPayload 构造（纯函数，无 IO）
├── spawn.ts      # resolveBinary + forward（spawn detached / unref / 全 try-catch）
├── listeners.ts  # 5 个监听器注册 + 根 agent 过滤 + waterfall next() 纪律
└── types.ts      # 共享类型（DshHookPayload、Forwarder 接口）
```

**依赖方向（单向，禁止反向 import）**：

```
index.ts ──> listeners.ts ──> payload.ts ──> types.ts
   │              │
   └──────────────┴──> spawn.ts ──> types.ts
config.ts ──> types.ts
```

**测试注入缝（关键）**：`listeners.ts` 不直接调用 `spawn.ts` 的副作用函数，而是接收一个 `Forwarder`：

```ts
export interface Forwarder {
  forward(payload: DshHookPayload): void   // 必须同步返回、绝不同步抛错
}
```

这样单测可以注入记录器来断言「发了几条、内容是什么、有没有短路 next()」，无需真的 spawn 进程。

---

## 4. 三条不可违背的正确性约束

### 4.1 waterfall 必须 `return next()`（唯一破坏性风险）

`approval/request` 与 `user-questions/request` 都是 waterfall，**无条件委托**：

```ts
ctx.on('approval/request', (req, next) => {
  forward({ ... })      // 先通知
  return next()         // 必须。不可省略、不可条件化、不可放在 try 里被吞
})
```

- 绝不能 `await next()` 之外的改造返回值；我们的返回值必须**就是** `next()` 的结果。
- 通知本身抛错也不能影响 `next()`：通知包 `try/catch`，`return next()` 放在 try 之外。

### 4.2 全部监听器体 try/catch

`agent/created` 是 **await** 的，抛出会污染会话启动；其余监听器抛出也会干扰 DSH。所有监听器体一律 `try { ... } catch { /* swallow */ }`。

### 4.3 只对根 agent 发事件

除 `agent/error` 外，所有事件都先过 `isRoot()`。`agent/error` 同样过滤（子 agent 失败不应冒充主任务失败）。

---

## 5. 验收标准（每个模块的 Definition of Done）

| 模块 | 验收 |
|---|---|
| `resolveBinary` | 3 级优先级各一条测试；找不到返回 `null` 且不抛 |
| `payload` | 5 类事件各一条快照测试；缺字段时降级不抛 |
| `listeners` | ① 两条 waterfall 都 `return next()`（mock next 断言被调用且返回值相等）② 子 agent 被过滤 ③ 监听器抛错不影响 next |
| `index` | `apply()` 注册 5 个监听器；`inject` 声明正确 |
| 全仓 | `npm run typecheck` 与 `npm test` 全绿 |


---

## 6. 冻结函数签名（并行开发的对接面）

各模块**按签名编写**，不要等待彼此实现完成。签名变更必须由 Lead 改本文件。

### 6.1 `src/payload.ts`（纯函数，无 IO）

```ts
/** 载荷构造所需的最小 agent 投影（避免依赖 dsh-agent 的完整类型）。 */
export interface AgentLike {
  readonly session: {
    readonly header: {
      readonly id: string
      readonly cwd?: string
    }
  }
}

/** 审批请求投影。 */
export interface ApprovalLike {
  readonly agent?: AgentLike
  readonly toolName?: string
  readonly reason?: string
  readonly displayReason?: Readonly<Record<string, string>>
}

/** 提问请求投影。 */
export interface QuestionLike {
  readonly agent?: AgentLike
  readonly questions?: ReadonlyArray<{ readonly question?: string }>
}

/** 抽取寻址字段；agent 缺失时 session_id 为空、cwd 回退 process.cwd()。 */
export function sessionRef(agent: AgentLike | undefined): { session_id: string; cwd: string }

export function sessionStartPayload(agent: AgentLike): DshHookPayload
export function approvalPayload(req: ApprovalLike): DshHookPayload
export function questionPayload(request: QuestionLike): DshHookPayload
export function stopPayload(agent: AgentLike): DshHookPayload
export function errorPayload(agent: AgentLike, error: unknown): DshHookPayload
```

**降级纪律**：任何字段缺失都不得抛出——`session_id` 缺失取 `''`、`cwd` 缺失取 `process.cwd()`、
`toolName` 缺失时 body 用通用文案。`errorPayload` 接受任意 `unknown`，需归一化为字符串
（`Error.message` → `String(x)`，截断到 200 字符）。

### 6.2 `src/spawn.ts`（唯一产生副作用的模块）

```ts
export interface SpawnOptions {
  /** 覆盖二进制定位第一优先级（默认读 process.env.AGENT_NOTIFY_BINARY）。 */
  binaryPath?: string
  /** 注入用 home 目录（默认 os.homedir()）；测试用它避免依赖真实 HOME。 */
  home?: string
  /** 覆盖环境（默认 process.env）。 */
  env?: NodeJS.ProcessEnv
  /** 诊断输出；默认静默。 */
  onDebug?: (message: string) => void
}

/** 按 CONTRACT §2 的 3 级优先级定位二进制；找不到返回 null，绝不抛出。 */
export function resolveBinary(options?: Pick<SpawnOptions, 'binaryPath' | 'home' | 'env'>): string | null

/** 构造一个 Forwarder：以分离式 spawn 投递一行 JSON。 */
export function createForwarder(options?: SpawnOptions): Forwarder
```

**纪律**：`forward()` 同步返回且**绝不抛错**；`spawn` 用 `detached: true` + `stdio: ['pipe','ignore','ignore']` +
`child.unref()`；必须挂 `child.on('error', () => {})` 吞掉 spawn 失败。

### 6.3 `src/listeners.ts`

```ts
export interface RegisterOptions {
  forwarder: Forwarder
  config: Config
  /** 根 agent 判定；默认走 `ctx.get('agents')?.roots()`（§9）。测试可注入确定性替身。 */
  isRoot?: (ctx: Context, agent: unknown) => boolean
}

/** 注册全部 5 个监听器；返回 disposer 数组（由 ctx.effect 收口）。 */
export function registerListeners(ctx: Context, options: RegisterOptions): void
```

**ctx.on 目标签名（已按已发布 0.2.0-rc.1 核对）**：

```ts
ctx.on('agent/created',       ({ agent, source, signal }) => { ... })           // await 的
ctx.on('approval/request',    (req, next) => { ...; return next() })            // waterfall
ctx.on('user-questions/request', (request, next) => { ...; return next() })     // waterfall
ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => { ... })             // serial
ctx.on('agent/error',         ({ agent, turn, step, error }) => { ... })        // emit
```

### 6.4 `src/index.ts`

```ts
export const name = 'agent-notify-dsh'
export const inject: string[] = []      // 无硬依赖：服务缺失时静默降级
export function apply(ctx: Context, config: Config): void
```

**`inject` 为空是刻意的**：插件必须在 `agents` 服务缺失时也能加载（否则整个 profile 起不来）。
根判定处用 `ctx.get('agents')?.roots()` 读取，读不到时返回 `true`（照发）——`ctx.agents` 属性访问会抛错，见 §9。

---

## 7. Lead 裁决记录（实现对契约的增补，已验证）

以下决策由 Lead 在并行开发期间裁定，均已实测验证。契约 §1–§6 的签名与行为不变。

### 7.1 事件类型增强必须显式引入（已接受）

**问题**：Cordis 的 `interface Events` 由各包分别 declaration-merge。只 import `Context` 时，
`keyof Events` 里**没有**任何 DSH 生命周期事件，`ctx.on('agent/created', ...)` 无法通过编译。

**实测证据**（去掉这三行后 typecheck 报 6 个错）：

```
src/listeners.ts(215,10): error TS2345: Argument of type '"agent/created"' is not assignable to parameter of type 'keyof Events'.
src/listeners.ts(242,53): error TS2339: Property 'agents' does not exist on type 'Context'.
```

**裁决**：接受 `src/listeners.ts` 顶部三条 `import type {}` 形式的副作用引入：

```ts
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
```

理由：`import type` 在构建产物中被完全擦除，插件对 cordis 之外**零运行时依赖**；
已验证 `lib/listeners.js` 只剩 `./payload.js` 一个运行时 import。三个包已在 devDependencies。

### 7.2 waterfall 采用「promise 同一性」而非仅值同一性（已接受）

实现为 `return next()`（不 `await`、不放在 try 内），测试同时断言 **promise 同一性**与**值同一性**。
这比契约 §4.1 的字面要求更强：`return await next()` 也能满足值同一，但会把同步 throw 与 rejection
重新包装，破坏调用方对原始错误的观察。裁决为保留更强实现。

**变异测试证据**（证明测试非空转，在 /tmp 副本执行）：把两处 `return next()` 改为 `void next()` 后，
**98 项中 15 项失败**。这正是契约 §4.1 警告的唯一破坏性风险，已被测试真实锁住。

### 7.3 其余裁定

| 争议点 | 裁决 | 依据 |
|---|---|---|
| `resolveBinary` 第 3 级是否加 `existsSync` | **保留** | 区别于前两级的「非空即用」；避免每次转发白起一个注定 ENOENT 的进程 |
| `toolName` 缺失时文案 | **`未知工具`** | Go 侧 `internal/claudehooks/event.go` 把 tool_name 原样拼进 body，空串会产出断句 |
| 截断单位 | **码点**（`Array.from`） | 对齐 Go 侧 `common.TruncateRunes(msg, 200)`，避免劈开代理对 |
| `enabled` 判定 | **`=== false` 视为关闭** | 与 schemastery `default(true)` 一致；「未配置」即「开启」 |
| 子命令名 | **`handle-dsh-hook`** | 对齐上游计划 §3.1 与 `handle-<agent>-hook` 惯例；仅 `spawn.ts` 一处常量 |
| `inject` 为空数组 | **保留** | 插件必须在 `agents` 缺失时仍能加载；但读服务**必须**走 `ctx.get`——属性访问会抛错（§9）。读不到时按「照发」处理，不静默 |

### 7.4 构建与导入约定（已锁定）

相对导入一律带 **`.js`** 扩展名（NodeNext ESM 约定），源码用 `.ts`。产出物经 `tsc` 编译后
`lib/index.js` 的 import 正确指向 `./config.js` / `./listeners.js` / `./spawn.js`。
**不需要** `allowImportingTsExtensions`——那会让产物保留 `.ts` 说明符，反而破坏发布。
---

## 8. 现场事故记录：必须导出 `Config`（否则插件静默失效）

**2026-10-05 实测发现并修复。这是本项目最隐蔽的一个 bug，务必保留这一节。**

### 症状

插件在真实 DSH 会话里**一条事件都观察不到**，但所有表面迹象都显示它装好了：

- `dsh --dump-config` 的加载树里有 `agent-notify-dsh` 这一行
- 插件模块被真正 import 并求值（诊断日志能打出来）
- 没有任何 warning / error 输出
- 手动跑 `agent-notify handle-dsh-hook` 一切正常

### 根因

Cordis 用 `resolveConfig` 解析插件配置，**模块没有 `Config` 导出时它把原始值原样传下去**：

```js
function resolveConfig(runtime, config) {
  if (!runtime.Config) return config   // ← 没有 Config 导出就走这里
  ...
}
```

`cordis.patch.yml` 的 insert 行没有 `config:` 键，于是 `apply()` 收到 `undefined`；
函数体第一行 `config.binaryPath` 立刻抛 `TypeError`，**发生在 `registerListeners()` 之前**——
所以 5 个监听器一个都没注册，插件从此静默。

### 为什么难发现

失败形态与成功完全一致：模块加载了、行在配置树里、无任何告警。
唯一可观察的差异是「永远没有事件」，而事件本身不产生任何日志。

### 修复

`src/index.ts` 末尾 `export { Config }`。这是**要件而非便利**：
导出后 Cordis 会把缺省值经 schema 校验成默认值，没有 `config:` 键的行也能正常工作。
DSH 官方插件（如 `dsh-hooks-claude-code`）全都导出 `Config`，正是这个原因。

### 验证（前后对照）

```bash
# 修复前：插件 Config 字段在 schema 里出现 0 次
dsh --profile web --dump-config-schema | grep -c binaryPath   # 0

# 修复后：schema 能解析到插件的 Config
dsh --profile web --dump-config-schema | grep -c binaryPath   # 1
```

回归测试在 `tests/integration.spec.ts`：

- `exports the Config schema so Cordis can supply defaults`
- `still applies when the loader supplies no config at all`
- `throws when handed an unresolved undefined config (documents the hazard)`

变异测试确认其有效：注释掉 `export { Config }` 后 2 项失败。

### 附带修复：测试的副作用

`tests/integration.spec.ts` 里两条用例调用**真实的** `apply()`，因而构造真实 forwarder、
spawn 真实二进制、**真的发出飞书通知**——每跑一次测试就给用户发两条假通知，
并污染 `state.json` 让事后诊断失去依据。现已在 `wired()` 里把 `AGENT_NOTIFY_BINARY`
指向一个不存在的路径，测试恢复为无副作用。
---

## 9. 现场事故记录二：`ctx.agents` 属性访问会抛错（已修复）

**2026-10-05 实测发现并修复。修复 §8 之后暴露出第二层故障，记录在此。**

### 症状

§8 修复后插件能加载、能注册监听器、**能收到事件**，但仍然一条通知都不发：

```
MODULE listeners.js evaluated          ← 加载 ✅
registerListeners() ENTERED            ← apply() 跑到 ✅
ctx.agents probe threw: cannot get property "agents" without inject   ← 根因
all 5 listeners registered OK          ← 监听器注册 ✅
EVENT agent/created fired ×2           ← 事件收到了 ✅
EVENT agent/turn-stopping fired        ← 收尾事件也到了 ✅
```

**链路完整，唯独不产出结果。**

### 根因

`isRoot` 用属性访问读服务：

```ts
const roots = ctx.agents?.roots()   // 抛：cannot get property "agents" without inject
```

Cordis 的 context 是代理，对**未 inject 的服务**，`get` 陷阱**主动抛错**。两个致命细节：

1. **`?.` 挡不住它**——可选链只对 nullish *值* 短路，不拦属性访问本身的抛错。
2. **抛错被监听器的 try/catch 吞掉**——而那个 catch 是契约 §4.2 **强制要求**的
   （`agent/created` 是 await 的，抛出会污染会话启动）。

于是：注册成功 → 收到每个事件 → 每次都在 `isRoot` 抛错 → 被吞 → **零通知、零日志、零告警**。
与「插件没活干」在外部完全不可区分。

### 修复

改用 `ctx.get('agents')`（读 store，服务缺失时返回 `undefined` 而不抛），
并把**失败方向定为「照发」**：读不到 registry 时视为根 agent 交付。

```ts
function defaultIsRoot(ctx, agent) {
  const roots = readRoots(ctx)
  if (roots === undefined) return true   // 宁可多推一条，不可静默
  return roots.includes(agent)
}
```

**取舍依据**：多发一条通知的代价是打扰一次；静默失效的代价是本次这整场排查。
DSH 官方插件（`hooks-claude-code`）同样用 `ctx.get('agents')`——它也不把 `agents` 放进 `inject`。

### 为什么 101 个测试全绿却线上全哑

**测试替身不复现真实失败模式。** 原来的 `fakeContext` 是普通 JS 对象：

```ts
const ctx = { agents: { roots: () => roots } }   // 普通对象，属性访问永不抛
```

真实 Cordis 是代理、会抛。**一个无法复现目标故障的替身，比没有替身更危险**——
它让测试全绿成为「已覆盖」的假证据。

### 测试侧的三处修正

1. `fakeContext` / `makeContext` 改为**抛错访问器 + 可用的 `ctx.get`**，复现代理语义。
2. 新增回归用例 `delivers a root event when only ctx.get can reach the registry`。
3. 把原「服务缺失 → 静默」的断言**翻转**为「服务不可读 → 照发」，并在注释里写明原因。

**变异验证**（全部有效）：

| 变异 | 结果 |
|---|---|
| `ctx.get` 改回 `ctx.agents` | 1 项失败 |
| `roots === undefined` 返回 `false` | 1 项失败 |
| **完整还原线上出问题的原始实现** | **4 项失败** |

最后一条是关键：把修复前的代码原样放回去，测试套件会明确失败。
