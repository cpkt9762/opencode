# 会话重试机制（Session Retry）

`packages/opencode` 里针对 LLM 请求失败的重试与错误处理机制的完整参考。本文档覆盖 7 次提交（`f121a5fcf` 到 `c5d150c4d`）的全部设计与实现。

## 目标

让使用 `opencode` 的用户**在大多数瞬时错误下都感知不到**：网络抖动、provider 过载、mid-stream 错误、限流，都应该由后端自动重试并恢复，不打断用户的任务。

具体要求：

1. **认真重试**：只要错误是瞬时的（transient），就在合理时间内反复尝试。
2. **有上限**：确保任何持续性错误最终能 fail fast，不会死循环。
3. **全程可观测**：每次重试决策都留下日志，出问题能回溯。
4. **日志必达**：无论 opencode-cli 用什么 CLI 参数启动，日志都必须落地到文件。
5. **跨 provider**：OpenAI / Codex / Anthropic / 第三方 openai-compatible 全部覆盖。

## 需求背景

原始 `opencode` 的 retry 有以下不足，本 patch 针对性修复：

| 问题                                                 | 根因                                                                                                                                    | 修复提交    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| OpenAI `server_error: An error occurred...` 不重试   | mid-stream error 是 `JSONParseError` 而非 `APICallError`，被 `MessageV2.fromError` 降级为 `NamedError.Unknown`，失去 `isRetryable` 字段 | `f121a5fcf` |
| HTTP 5xx 有时被标记为 `isRetryable: false`           | `isOpenAiErrorRetryable()` 只特判 404，不管 5xx                                                                                         | `f121a5fcf` |
| 重试无上限，理论上可死循环                           | `Effect.retry(policy)` 没有 `times` 限制                                                                                                | `a301976aa` |
| 重试过程完全无日志                                   | `SessionRetry.policy` 没有任何 logging                                                                                                  | `a301976aa` |
| Codex provider 的 `service_unavailable_error` 不重试 | `providerID=codex` 不以 `openai` 开头，绕过所有兜底                                                                                     | `afeefca67` |
| Desktop App 启动时不写日志文件                       | `Log.init({ print: true })` 会短路文件写入                                                                                              | `8eb711ff8` |
| `ctx.model.modelID` 永远是 undefined                 | `Provider.Model` 的字段实际叫 `id`，写错字段名                                                                                          | `bc6fd4b9f` |
| retry 状态里塞了一大坨 error JSON                    | `retryable()` 返回原始 message 直接透传给前端                                                                                           | `c5d150c4d` |

## 核心流程

从用户请求到重试成功的完整链路：

```
User submits prompt
  ↓
Session.chat()
  ↓
SessionProcessor.process()
  ↓
LLM.stream({ model, messages, tools, ... })      // src/session/llm.ts
  ├── streamText() from ai-sdk                    // maxRetries: 0（不用 sdk 的内置 retry）
  └── Stream.fromAsyncIterable(result.fullStream)
      .pipe(
        Stream.map(event =>                       // ⚠️ 关键拦截点
          event.type === "error"
            ? { ...event, error: reclassifyStreamError(event.error, providerID) }
            : event
        )
      )
  ↓
Stream.tap(handleEvent)                           // src/session/processor.ts:185
  └── case "error": throw value.error             // 把重分类后的 error 抛出
  ↓
Stream.runDrain
  ↓ fail
Effect.onInterrupt(() => aborted = true)
Effect.catchCauseIf(                              // 把 Cause 压成 error
  cause => !hasInterruptsOnly(cause),
  cause => Effect.fail(Cause.squash(cause))
)
  ↓
Effect.retry(SessionRetry.policy({                // ⚠️ 决策点
  parse,
  modelID: ctx.model.id,                          // ← 不是 modelID，是 id
  set: info => status.set(sessionID, { type: "retry", ...info })
}))
  ├── retryable(error, { modelID }) ?
  │     ├── ContextOverflowError  → undefined → giveup
  │     ├── AuthError             → undefined → giveup
  │     ├── APIError              → message 或 gptFallback
  │     ├── plain-text keywords   → message
  │     ├── JSON keywords         → message
  │     └── gptFallback(error)    → modelID.startsWith("gpt-") ? message : undefined
  ├── attempt > RETRY_MAX_ATTEMPTS ? → giveup
  └── 否则 → wait = delay(attempt, error) → log → retry
  ↓ 成功
Effect.catch(halt)                                // 不触发
Effect.ensuring(cleanup())
  ↓
返回正常结果
```

失败路径（重试用尽后）走 `Effect.catch(halt)`：设置 `ctx.assistantMessage.error`，publish `Session.Event.Error`。

## 错误分类与决策

### 第 1 层：ai-sdk HTTP 阶段（pre-stream）

当请求在连接 / 握手阶段失败时，ai-sdk 抛 `APICallError`：

```ts
// packages/opencode/src/provider/error.ts:173
parseAPICallError({ providerID, error }) {
  return {
    type: "api_error",
    isRetryable: providerID.startsWith("openai")
      ? isOpenAiErrorRetryable(error)
      : error.isRetryable,  // 依赖 ai-sdk 的默认判定
    ...
  }
}

// packages/opencode/src/provider/error.ts:31
function isOpenAiErrorRetryable(e: APICallError) {
  const status = e.statusCode
  if (!status) return e.isRetryable
  if (status === 404) return true           // OpenAI 偶尔对合法模型返回 404
  if (status >= 500) return true            // 5xx 硬覆盖
  return e.isRetryable
}
```

### 第 2 层：mid-stream 错误（SSE 中途）

当 OpenAI / Codex 在 SSE 流建立之后才返回错误（如 `server_is_overloaded`），ai-sdk 不会抛 `APICallError`，而是往 stream 里 `enqueue({ type: "error", error: chunk.error })` —— 这里的 `chunk.error` 是个 `JSONParseError` 或普通 `Error`，**没有 `statusCode` 也没有 `isRetryable`**。

我们的拦截：

```ts
// packages/opencode/src/session/llm.ts:67
return Stream.fromAsyncIterable(result.fullStream, ...)
  .pipe(
    Stream.map(event =>
      event.type === "error"
        ? { ...event, error: ProviderError.reclassifyStreamError(event.error, pid) }
        : event,
    ),
  )

// packages/opencode/src/provider/error.ts:175
const OPENAI_TRANSIENT_STREAM_PATTERNS = [
  /server_error/i,
  /an error occurred while processing your request/i,
]

export function reclassifyStreamError(error: unknown, providerID: ProviderID): unknown {
  if (!(error instanceof Error)) return error
  if (APICallError.isInstance(error)) return error
  if (!providerID.startsWith("openai")) return error     // 仅 openai 家族
  if (!OPENAI_TRANSIENT_STREAM_PATTERNS.some(p => p.test(error.message))) return error
  return new APICallError({
    message: error.message,
    url: "",
    requestBodyValues: {},
    statusCode: 500,
    isRetryable: true,
    cause: error,
  })
}
```

**注意**：对于 `providerID=codex` 的情况，这个函数不会触发（不以 `openai` 开头），此时依赖第 4 层的 `gpt-` 兜底。

### 第 3 层：`SessionRetry.retryable()` 统一判定

```ts
// packages/opencode/src/session/retry.ts:68
export function retryable(error: Err, opts?: { modelID?: string }) {
  // 3.1 黑名单（即使是 gpt- 也不重试）
  if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
  if (MessageV2.AuthError.isInstance(error)) return undefined

  // 3.2 结构化 APIError 判定
  if (MessageV2.APIError.isInstance(error)) {
    if (!error.data.isRetryable) return gptFallback(error, opts?.modelID)
    if (error.data.responseBody?.includes("FreeUsageLimitError"))
      return `Free usage exceeded, subscribe to Go https://opencode.ai/go`
    return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
  }

  // 3.3 纯文本关键字白名单
  const msg = error.data?.message
  if (typeof msg === "string") {
    const lower = msg.toLowerCase()
    if (
      lower.includes("rate increased too quickly") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests")
    ) {
      return msg
    }
  }

  // 3.4 JSON body 关键字白名单
  const json = tryParseJson(msg)
  if (!json || typeof json !== "object") return gptFallback(error, opts?.modelID)
  if (json.type === "error" && json.error?.type === "too_many_requests") return "Too Many Requests"
  if (code.includes("exhausted") || code.includes("unavailable")) return "Provider is overloaded"
  if (json.type === "error" && json.error?.code?.includes("rate_limit")) return "Rate Limited"

  // 3.5 gpt- 激进兜底
  return gptFallback(error, opts?.modelID)
}
```

### 第 4 层：`gpt-` 模型激进兜底

对于所有其他路径都没救回来的错误，如果模型名以 `gpt-` 开头，一律重试：

```ts
// packages/opencode/src/session/retry.ts:60
function gptFallback(error: Err, modelID?: string) {
  if (!isGptModel(modelID)) return undefined // 非 gpt- 模型不触发
  if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
  if (MessageV2.AuthError.isInstance(error)) return undefined
  const raw = typeof error.data?.message === "string" ? error.data.message : ""
  return raw.length > 0 ? raw : "Retrying GPT model"
}
```

**设计取舍**：这是为了救住 Codex provider 的 `service_unavailable_error` 等 mid-stream 错误（它们以 `NamedError.Unknown` 的形式到达这里，结构化判定全都 miss）。代价是：gpt- 模型上的某些确定性代码 bug 也会被重试 10 次才 fail，总耗时 ~3.5 分钟。可接受。

### 第 5 层：最大次数检查

```ts
// packages/opencode/src/session/retry.ts:139
if (meta.attempt > RETRY_MAX_ATTEMPTS) {
  log.error("retry limit reached", info)
  retryLog("ERROR", "retry limit reached", info)
  return Cause.done(meta.attempt) // Effect.retry 停止
}
```

## 重试策略

### 指数退避

```ts
// packages/opencode/src/session/retry.ts:18
delay(attempt) = min(
  RETRY_INITIAL_DELAY × RETRY_BACKOFF_FACTOR^(attempt-1),
  RETRY_MAX_DELAY_NO_HEADERS
)
```

当 `RETRY_INITIAL_DELAY = 2000ms`, `RETRY_BACKOFF_FACTOR = 2`, `RETRY_MAX_DELAY_NO_HEADERS = 30000ms` 时，10 次重试的等待序列：

| attempt | waitMs |           累计 |
| ------: | -----: | -------------: |
|       1 |   2000 |             2s |
|       2 |   4000 |             6s |
|       3 |   8000 |            14s |
|       4 |  16000 |            30s |
|       5 |  30000 |            60s |
|       6 |  30000 |            90s |
|       7 |  30000 |           120s |
|       8 |  30000 |           150s |
|       9 |  30000 |           180s |
|      10 |  30000 | 210s (3.5 min) |

最坏情况总耗时约 **3.5 分钟**。

### Retry-After 头解析

优先级：`retry-after-ms` > `retry-after`（秒或 HTTP-date）> 指数退避。

```ts
// packages/opencode/src/session/retry.ts:22
if (headers["retry-after-ms"]) return cap(parseFloat(headers["retry-after-ms"]))
if (headers["retry-after"]) {
  const asSeconds = parseFloat(headers["retry-after"])
  if (!isNaN(asSeconds)) return cap(asSeconds * 1000)
  const asDate = Date.parse(headers["retry-after"]) - Date.now()
  if (!isNaN(asDate) && asDate > 0) return cap(asDate)
}
return cap(RETRY_INITIAL_DELAY * RETRY_BACKOFF_FACTOR ** (attempt - 1))
```

最大等待时间受 32-bit setTimeout 上限约束：`RETRY_MAX_DELAY = 2_147_483_647ms ≈ 24.8 天`。

## 关键常量

```ts
// packages/opencode/src/session/retry.ts:12
export const RETRY_INITIAL_DELAY = 2000 // 2 秒
export const RETRY_BACKOFF_FACTOR = 2 // 翻倍
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 秒（无 header 时上限）
export const RETRY_MAX_DELAY = 2_147_483_647 // 32-bit setTimeout 上限
export const RETRY_MAX_ATTEMPTS = 10 // 硬上限
```

## 涉及文件

| 文件                       | 职责                                                                           | 约 patch 行数 |
| -------------------------- | ------------------------------------------------------------------------------ | ------------: |
| `src/session/retry.ts`     | `delay()` / `retryable()` / `gptFallback()` / `policy()` / `friendlyMessage()` |          ~120 |
| `src/session/retry-log.ts` | 独立 `fs.appendFile` 日志模块                                                  |           ~43 |
| `src/session/processor.ts` | 调用 `Effect.retry(SessionRetry.policy(...))` 并传入 `modelID`                 |            ~2 |
| `src/session/llm.ts`       | `Stream.map` 拦截 mid-stream error 并重分类                                    |           ~10 |
| `src/provider/error.ts`    | `isOpenAiErrorRetryable()` + `reclassifyStreamError()`                         |           ~25 |
| `src/util/log.ts`          | `Log.init()` 的 tee 修复                                                       |            ~8 |

## 日志系统

### 两份日志同时写

1. **主日志** `~/.local/share/opencode/log/YYYY-MM-DDTHHmmss.log`
   - 所有 service 的 `log.*` 都写在这里
   - 由 `Log.create({ service: "session.retry" })` 写入
   - 每次 opencode-cli 启动生成一个新文件（基于启动时间戳）

2. **专用 retry 日志** `~/.local/share/opencode/log/session-retry.log`
   - 仅记录 retry 决策（retrying / giving up / retry limit reached）
   - 直接 `fs.appendFile`，**完全绕过** `Log.init()`
   - 超过 5MB 自动重命名为 `session-retry.log.1`
   - fire-and-forget，错误吞掉，不阻塞 retry 热路径

### 为什么要两份

OpenCode Desktop App 启动 opencode-cli 时传 `--print-logs --log-level WARN`。旧代码的 `Log.init()` 遇到 `print: true` 会 `return` 掉，**不设置文件写入**，所有日志只走 stderr 被 Desktop App 吞掉，用户完全看不到。

修复分两层：

1. **commit `8eb711ff8`**：`Log.init()` 改成 tee 模式，print=true 时**既**写 stderr **又**写文件
2. **commit `73e84bd2e`**：即使 `Log.init` 出任何问题，`retry-log.ts` 作为独立旁路保险，用 `fs.appendFile` 无条件写入

### 日志字段

```
2026-04-08T10:04:52.469Z WARN  retrying
  attempt=1                                       第几次尝试
  max=10                                          上限（RETRY_MAX_ATTEMPTS）
  waitMs=2000                                     本次等待毫秒数
  reason=<retryable 返回值>                       为什么决定重试
  modelID=gpt-5.4                                 失败的模型 ID
  name=APIError | UnknownError | ...              错误 NamedError 类型
  statusCode=500                                  HTTP 状态码（APIError 才有）
  message=<前 200 字符>                           原始 error.data.message 截断
```

三种决策对应三条日志：

- `retrying` — 决定重试，等 `waitMs` 毫秒
- `giving up, error not retryable` — `retryable()` 返回 undefined，放弃
- `retry limit reached` — 达到 `RETRY_MAX_ATTEMPTS`，放弃

### 查看

```bash
# 实时 tail 专用 retry 日志
tail -f ~/.local/share/opencode/log/session-retry.log

# tail 最新主日志
tail -f ~/.local/share/opencode/log/$(ls -t ~/.local/share/opencode/log/*.log | head -1)

# 只看 retry 相关
grep "session.retry" ~/.local/share/opencode/log/*.log
```

### `friendlyMessage()` 对前端的处理

`SessionRetry.policy()` 通过 `opts.set({ type: "retry", message, ... })` 把 retry 状态广播给前端。原始的 `message` 可能是整段 error JSON（比如 mid-stream error 的完整 body），直接透传会污染前端 UI。

```ts
// packages/opencode/src/session/retry.ts:130
function friendlyMessage(reason: string, attempt: number) {
  const looksLikeJson = reason.trimStart().startsWith("{") || reason.trimStart().startsWith("[")
  if (looksLikeJson || reason.length > 80) {
    return `Retrying (attempt ${attempt}/${RETRY_MAX_ATTEMPTS})`
  }
  return `${reason} (attempt ${attempt}/${RETRY_MAX_ATTEMPTS})`
}
```

日志里的 `reason` 字段保留完整原文（便于调试），前端只收到 friendly 版本。

## 已知局限

1. **前端消息流里仍会出现红色 `service_unavailable_error` 块**
   - 现象：后端 retry 成功但 SPA 消息流里依然渲染一个嵌入式红色错误框
   - 已排除：`SessionStatus.retry.message` 不是来源（SPA 仅读 `status.type`）
   - 待查方向：`Session.Event.Error` 订阅 / `message.parts` 里的某个 part / `halt()` 可能在某条未知路径被调用
   - 优先级：功能不受影响，用户体验瑕疵

2. **`gpt-` 兜底依赖模型命名约定**
   - 若未来通过 Codex provider 使用非 `gpt-*` 命名的模型，`gptFallback()` 不会触发
   - 缓解：届时可以把判定扩展成 `providerID` 白名单或同时匹配模型命名

3. **`RETRY_MAX_ATTEMPTS` 硬编码**
   - 未做配置化，用户不能通过 `opencode.json` 调整
   - 改造成本低：从 `Config` 读即可

4. **`reclassifyStreamError` 正则仅 2 条**
   - 只匹配 `server_error` 和 `an error occurred while processing your request`
   - OpenAI 将来出新的错误文案需要手动添加
   - 但有 `gpt-` 兜底作为第二道防线

## 未来改进方向

### 短期

1. 定位并修掉前端红色 error block 的渲染源头
2. 把 `RETRY_MAX_ATTEMPTS` 和 `RETRY_INITIAL_DELAY` 做成 `opencode.json` 可配置
3. `reclassifyStreamError` 支持 `providerID=codex` 及其他 openai-compatible provider

### 长期

**把 retry 迁移到 `LanguageModelV2` middleware 插件**。参考路线 B：

```ts
import { wrapLanguageModel, type LanguageModelV2Middleware } from "ai"

const retryMiddleware: LanguageModelV2Middleware = {
  wrapStream: async ({ doStream }) => {
    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        const { stream } = await doStream()
        return { stream: interceptMidStreamErrors(stream, attempt) }
      } catch (e) {
        if (!shouldRetry(e)) throw e
        await sleep(backoff(attempt))
      }
    }
    throw new Error("retry limit")
  },
}

// 通过 Hooks.provider.models 返回 wrapLanguageModel 包装过的 model
```

优点：完全零核心改动，和 `opencode` 上游解耦。
缺点：实现复杂、每个 provider 都要包装、调试链路深。

## 维护说明

### 上游 merge 冲突多发区

本 patch 跨 6 个核心文件，上游可能在下列热点改动：

| 文件                                   | 热点                                               | 说明                                 |
| -------------------------------------- | -------------------------------------------------- | ------------------------------------ |
| `src/session/processor.ts:467-480`     | `Effect.retry(SessionRetry.policy(...))` 块        | 新增参数时注意                       |
| `src/session/llm.ts:55-85`             | `stream()` Layer 实现                              | `Stream.map` 插入位置                |
| `src/util/log.ts:60-82`                | `Log.init()` 主体                                  | tee 分支                             |
| `src/session/retry.ts`                 | 全文件                                             | 上游基本不会动，但要看               |
| `src/provider/error.ts:31-38, 175-191` | `isOpenAiErrorRetryable` / `reclassifyStreamError` | 可能和上游的 provider error 重写冲突 |

### 冲突检查命令

```bash
# 在 merge 上游前检查这几个文件是否动过
git fetch upstream
git diff upstream/dev -- \
  packages/opencode/src/session/retry.ts \
  packages/opencode/src/session/retry-log.ts \
  packages/opencode/src/session/processor.ts \
  packages/opencode/src/session/llm.ts \
  packages/opencode/src/provider/error.ts \
  packages/opencode/src/util/log.ts
```

### 验证改动生效

```bash
# 1. 清除旧日志
rm -f ~/.local/share/opencode/log/session-retry.log

# 2. 重启 opencode-cli（或 Desktop App / VSCode Extension）

# 3. 触发任意 LLM 请求

# 4. 检查是否产出独立日志
ls -la ~/.local/share/opencode/log/session-retry.log
```

若 `session-retry.log` 被创建（即使暂时为空），说明最新 binary 的 `retry-log.ts` 代码已加载 —— 这是验证新 binary 是否安装到位的最简方式（文件存在性 = `73e84bd2e` 代码已运行）。

### 运行测试

```bash
cd packages/opencode
bun test test/session/retry.test.ts
```

测试覆盖 33 个用例，包括：

- `delay()` 的指数退避和 retry-after 头处理
- `retryable()` 的各个分支（APIError / text keyword / JSON keyword / gpt fallback）
- `reclassifyStreamError()` 的 openai / 非 openai / 各种 error 形态
- `policy()` 的 attempt 计数 + `RETRY_MAX_ATTEMPTS` 截断
- 端到端：mid-stream error → reclassify → retry 的完整路径

## 相关提交

按时间顺序：

```
f121a5fcf  fix(opencode): retry OpenAI 5xx and reclassify mid-stream server errors
a301976aa  feat(opencode): cap session retries at 10 and log each decision
afeefca67  feat(opencode): aggressive retry fallback for gpt- models
bc6fd4b9f  fix(opencode): pass correct model id to session retry policy
8eb711ff8  feat(opencode): tee --print-logs to log file in addition to stderr
73e84bd2e  feat(opencode): dedicated session-retry.log file independent of Log
c5d150c4d  feat(opencode): friendly session status message for retries
```
