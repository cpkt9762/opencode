# Plan: Fork opencode-antigravity-auth — Replace HTTP Transport with ls_core gRPC

## Goal

Fork the existing `opencode-antigravity-auth@1.6.0` plugin and replace its HTTP transport layer (fetch interception → Google Generative Language API) with direct ls_core gRPC communication via the Cascade protocol. Keep all existing auth, accounts, rotation, config, CLI, logging, and recovery infrastructure intact.

## Approach: Fork, Not Rebuild

The existing plugin (~50 source files) is mature and battle-tested. Roughly half its code is transport-agnostic infrastructure (accounts, auth, token, rotation, config, CLI, logger, debug, recovery, version, errors, quota, storage). Instead of rebuilding this from scratch, we **fork the plugin and surgically replace only the HTTP transport layer** with ls_core gRPC.

## Architecture

```
opencode (AI SDK → @ai-sdk/google → fetch())
  │
  │  Plugin intercepts fetch() for generativelanguage.googleapis.com
  ▼
┌──────────────────────────────────────────────────────┐
│  opencode-antigravity-auth (forked)                  │
│                                                      │
│  ┌──── KEEP (existing infrastructure) ────────────┐  │
│  │ accounts.ts — Multi-account storage & rotation  │  │
│  │ auth.ts — OAuth2 token validation               │  │
│  │ token.ts — Token refresh queue                  │  │
│  │ rotation.ts — Account rotation algorithms       │  │
│  │ quota.ts — Quota monitoring                     │  │
│  │ config/ — Configuration schema                  │  │
│  │ cli.ts + ui/ — CLI menus                        │  │
│  │ storage.ts — Persistent storage                 │  │
│  │ logger.ts + debug.ts — Logging                  │  │
│  │ recovery/ — Session recovery                    │  │
│  │ errors.ts — Error types                         │  │
│  │ hooks/ — Auto-update checker                    │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌──── REPLACE (HTTP → gRPC) ─────────────────────┐  │
│  │ request.ts — Route to ls_core Cascade           │  │
│  │ request-helpers.ts — Cascade-specific helpers    │  │
│  │ transform/ — Remove (Cascade handles internally)│  │
│  │ core/streaming/ — Cascade stream → SSE Response │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌──── ADD (new ls_core modules) ─────────────────┐  │
│  │ src/lscore/                                     │  │
│  │  ├─ asset-provisioner.ts — Binary/cert lifecycle│  │
│  │  ├─ manager.ts — Process spawn + LRU pool       │  │
│  │  ├─ extension-server.ts — Connect+Proto server  │  │
│  │  ├─ cascade-client.ts — gRPC 3-step protocol    │  │
│  │  ├─ connect-wire.ts — Frame codec               │  │
│  │  └─ models.ts — Model name → enum ID mapping    │  │
│  │ src/gen/ — Proto TypeScript types               │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
         │
         │  ls_core gRPC/TLS (server_port)
         ▼
    ┌─────────────┐
    │  ls_core     │  Antigravity native binary (149MB Mach-O)
    │  (spawned)   │  → Google Cloud Code Assist backend
    └─────────────┘
```

## Surgery Map: KEEP / MODIFY / REPLACE / ADD

### KEEP (no changes)

| File                          | Purpose                                  |
| ----------------------------- | ---------------------------------------- |
| `src/plugin/accounts.ts`      | Multi-account management & storage       |
| `src/plugin/accounts.test.ts` | Account management tests                 |
| `src/plugin/auth.ts`          | OAuth token validation & refresh helpers |
| `src/plugin/auth.test.ts`     | Auth tests                               |
| `src/plugin/cache.ts`         | Auth & signature caching                 |
| `src/plugin/cache/`           | Cache internals                          |
| `src/plugin/cli.ts`           | CLI interactive menus                    |
| `src/plugin/debug.ts`         | Debug logging utilities                  |
| `src/plugin/errors.ts`        | Error types                              |
| `src/plugin/logger.ts`        | Structured logger                        |
| `src/plugin/project.ts`       | Project context resolution               |
| `src/plugin/quota.ts`         | Quota checking (API usage stats)         |
| `src/plugin/recovery.ts`      | Session recovery (tool_result_missing)   |
| `src/plugin/recovery/`        | Recovery internals                       |
| `src/plugin/refresh-queue.ts` | Proactive token refresh                  |
| `src/plugin/rotation.ts`      | Account rotation algorithms              |
| `src/plugin/server.ts`        | OAuth callback local server              |
| `src/plugin/storage.ts`       | Persistent Zod-validated storage         |
| `src/plugin/stores/`          | Store internals                          |
| `src/plugin/token.ts`         | Token refresh queue                      |
| `src/plugin/types.ts`         | Shared types                             |
| `src/plugin/ui/`              | TUI components                           |
| `src/plugin/version.ts`       | Version fetching                         |
| `src/hooks/`                  | Auto-update checker hook                 |
| `src/antigravity/oauth.ts`    | OAuth exchange/authorize                 |
| `src/constants.ts`            | Endpoints, headers, API config           |

### MODIFY (adapt to ls_core)

| File                          | Changes                                                                                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/plugin.ts`               | Main entry — add ls_core initialization in `loader()`, replace `fetch()` body to route through Cascade instead of HTTP. Keep all existing `auth`, `event`, `tool` hooks as-is. See Module 6. |
| `src/plugin/config/schema.ts` | Add ls_core config fields: `max_instances`, `idle_timeout`, `binary_path`, `cert_path`.                                                                                                      |
| `src/plugin/config/index.ts`  | Export new config fields.                                                                                                                                                                    |
| `package.json`                | Add dependencies: `@bufbuild/protobuf`, `@connectrpc/connect`, `@grpc/grpc-js`, `@grpc/proto-loader`, `@bufbuild/protoc-gen-es`. Add build scripts for proto generation.                     |

### REPLACE (HTTP transport → ls_core gRPC)

| File                              | What Changes                                                                                                                                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/plugin/request.ts`           | 1881 lines → gut the HTTP request/response transformation. Keep `isGenerativeLanguageRequest()` for intercepting. Replace `prepareAntigravityRequest()` and `transformAntigravityResponse()` with ls_core Cascade routing. See Module 5. |
| `src/plugin/request-helpers.ts`   | Remove HTTP-specific helpers (schema cleaning, thinking filters, SSE parsing). Keep only what's needed for prompt flattening.                                                                                                            |
| `src/plugin/core/streaming/`      | Replace SSE stream transformer with Cascade reactive stream → Response converter.                                                                                                                                                        |
| `src/plugin/thinking-recovery.ts` | Simplify — Cascade handles thinking internally. Keep only conversation state analysis for session recovery.                                                                                                                              |

### DELETE (no longer needed)

| File/Directory                                  | Reason                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `src/plugin/fingerprint.ts`                     | Not needed for ls_core (no HTTP headers to fake)                   |
| `src/plugin/transform/claude.ts`                | Cascade handles Claude-specific transformations                    |
| `src/plugin/transform/gemini.ts`                | Cascade handles Gemini-specific transformations                    |
| `src/plugin/transform/cross-model-sanitizer.ts` | No more HTTP body transformation                                   |
| `src/plugin/transform/model-resolver.ts`        | Replace with ls_core model enum resolver                           |
| `src/plugin/transform/types.ts`                 | Transform types no longer needed                                   |
| `src/plugin/transform/index.ts`                 | Barrel file                                                        |
| `src/plugin/search.ts`                          | Google search via Antigravity API (optional — can keep if desired) |
| `src/plugin/image-saver.ts`                     | Image generation via HTTP (Cascade doesn't expose this)            |

### ADD (new ls_core modules)

| File                              | Purpose                                                                     |
| --------------------------------- | --------------------------------------------------------------------------- |
| `src/lscore/asset-provisioner.ts` | Binary/cert lifecycle: version detection, local extraction, remote download |
| `src/lscore/manager.ts`           | Process spawn, readiness probe, stdin injection, LRU pool, TTL cleanup      |
| `src/lscore/extension-server.ts`  | Connect+Proto HTTP server for ls_core token injection via USS               |
| `src/lscore/cascade-client.ts`    | gRPC Cascade protocol (3-step: Start → Send → Stream)                       |
| `src/lscore/connect-wire.ts`      | Binary frame codec for Connect+Proto protocol                               |
| `src/lscore/models.ts`            | Model name → proto enum ID mapping + numeric passthrough                    |
| `src/lscore/types.ts`             | Shared ls_core types (ProvisionedAssets, LsCoreInstance, etc.)              |
| `src/gen/`                        | Generated proto TypeScript (from `buf generate`)                            |
| `scripts/extract-protos.ts`       | Build script: extract protos from extension.js → generate TypeScript        |
| `proto/`                          | Extracted proto descriptors (checked in as snapshot)                        |

## Dependencies

**Existing** (keep):

- `@opencode-ai/plugin` — OpenCode plugin interface
- `@openauthjs/openauth` — OAuth client
- `proper-lockfile` — File locking
- `xdg-basedir` — XDG directory resolution
- `zod` — Schema validation

**New** (add):

- `@bufbuild/protobuf` — Proto runtime (serialization/deserialization)
- `@bufbuild/protoc-gen-es` — Proto TypeScript code generator (devDep)
- `@bufbuild/buf` — Buf CLI for `buf generate` (devDep). NOTE: `buf` on npm is an unrelated package; MUST use `@bufbuild/buf`
- `@connectrpc/connect` + `@connectrpc/connect-node` — Connect protocol client/server
- `@grpc/grpc-js` + `@grpc/proto-loader` — gRPC client to ls_core's server_port

## Verification Strategy

Each module has standalone tests. Tests run from `3rd-github/opencode-antigravity-auth/` using the existing `vitest` setup.

```bash
# Unit tests (no external deps)
npm test

# Single module
npx vitest run src/lscore/connect-wire.test.ts

# E2E (requires ANTIGRAVITY_REFRESH_TOKEN + Antigravity.app installed)
ANTIGRAVITY_REFRESH_TOKEN="1//0e..." npx vitest run test/e2e/ --timeout 60000
```

---

## Module 0: Asset Provisioner

### What

Manage ls_core binary and cert.pem lifecycle: version detection, local extraction, remote download, version alignment, cert expiry monitoring.

### Why

- **Version mismatch → 403**: Google backend rejects requests if `InitMetadata.ide_version` doesn't match the actual ls_core binary
- **cert.pem expires**: Bundled TLS cert has fixed expiry (current: 2026-09-04)
- **Model enum drift**: New versions add model IDs

### Three Version Numbers (CRITICAL)

| Source                                            | Example    | Correct for ls_core?         |
| ------------------------------------------------- | ---------- | ---------------------------- |
| `Info.plist` → `CFBundleShortVersionString`       | **1.20.6** | ✅ YES                       |
| `product.json` → `version`                        | `1.107.0`  | ❌ VS Code engine version    |
| `extensions/antigravity/package.json` → `version` | `0.2.0`    | ❌ Extension package version |

### Output

`src/lscore/asset-provisioner.ts`:

```typescript
type ProvisionedAssets = {
  binaryPath: string        // Path to ls_core binary
  certPath: string          // Path to cert.pem
  version: string           // Detected version (e.g. "1.20.6")
  cloudCodeEndpoint: string // Cloud Code URL (from extension.js or default)
}

// Public API
ensure(opts?: { binaryPath?: string; certPath?: string; autoUpdate?: boolean }): Promise<ProvisionedAssets>
detectVersion(): string
checkCertExpiry(certPath: string): { valid: boolean; daysRemaining: number }
checkForUpdate(): Promise<{ available: boolean; version: string } | null>
extractProtos(extensionJsPath: string): string[]  // Returns paths to extracted .pb files
```

### Version Detection (macOS)

```typescript
function detectVersion(): string {
  // 1. Check persisted config: ~/.antigravity_tools_ls/data/ls_config.json
  // 2. Read from Info.plist (the ONLY correct source)
  //    - /Applications/Antigravity.app/Contents/Info.plist
  //    - ~/Applications/Antigravity.app/Contents/Info.plist
  //    Key: CFBundleShortVersionString
  // 3. Throw if neither found
}
```

### Asset Provisioning Flow

```
ensure():
  1. Read ls_config.json → { version, ls_address }
  2. Check binary + cert at ~/.antigravity_tools_ls/bin/
  3. IF both exist AND version matches → fast path return
  4. IF local Antigravity.app installed:
     a. Read version from Info.plist (CFBundleShortVersionString)
     b. Copy bin/language_server_macos_arm → ~/.antigravity_tools_ls/bin/ls_core
     c. Copy dist/languageServer/cert.pem → ~/.antigravity_tools_ls/bin/cert.pem
     d. Extract cloudCodeEndpoint from dist/extension.js
     e. Extract protos from extension.js → ~/.antigravity_tools_ls/proto/*.pb
     f. Persist to ls_config.json
  5. IF no local app → remote download via release API
```

### Proto Extraction (from extension.js)

```typescript
extractProtos(extensionJsPath: string): string[] {
  // Regex: fileDesc\)\("([A-Za-z0-9+/=]+)" — matches (0,i.fileDesc)("BASE64...") in minified JS
  // Extracts 24 base64-encoded FileDescriptorProto blobs
  // Decodes each to raw .pb, writes to ~/.antigravity_tools_ls/proto/
  // Returns file paths. Proven to work in <1s.
  // Fallback: binary scan of ls_core for 229 embedded descriptors (slower ~10s)
}
```

### Remote Release API

```
GET https://antigravity-auto-updater-974169037036.us-central1.run.app/releases
→ [{ "version": "1.21.6", "execution_id": "5723021441368064" }, ...]

DMG URL: https://edgedl.me.gvt1.com/edgedl/release2/j0qc3/antigravity/stable/{version}-{execution_id}/darwin-arm/Antigravity.dmg
```

### Cert Expiry Detection

```typescript
function checkCertExpiry(certPath: string): { valid: boolean; daysRemaining: number } {
  const cert = new crypto.X509Certificate(fs.readFileSync(certPath))
  const expiry = new Date(cert.validTo)
  const days = Math.floor((expiry.getTime() - Date.now()) / 86400000)
  return { valid: days > 0, daysRemaining: days }
}
// daysRemaining < 30 → warn. valid === false → force re-provision.
```

### Key Detail

- `Info.plist` is the ONLY correct version source
- Binary is 149MB — show progress during provisioning
- Remote download: ~150MB + hdiutil (macOS only for DMG)
- cert.pem: self-signed CN=localhost, renewed each release (expires 2026-09-04)
- `ls_config.json` persists version to avoid re-detecting every startup

### Verification

```bash
npx vitest run src/lscore/asset-provisioner.test.ts
```

- `detectVersion()` reads `CFBundleShortVersionString` from mock Info.plist (NOT `product.json`)
- `checkCertExpiry()` correctly parses X.509 and calculates days
- `ensure()` fast path: both assets present + version match → no copy/download
- `ensure()` version mismatch → triggers local extraction
- `checkForUpdate()` parses release API response
- `extractProtos()` returns 24 file paths from test extension.js fixture

---

## Module 1: Proto TypeScript Generation

### What

Generate TypeScript types + serialization from proto descriptors extracted by Module 0.

### Input

24 raw `FileDescriptorProto` binary files (`.pb`) from `AssetProvisioner.extractProtos()`. Key files:

- `exa.language_server_pb.language_server.pb` — `CascadeService` RPCs
- `exa.extension_server_pb.extension_server.pb` — `ExtensionServerService` RPCs
- `exa.reactive_component_pb.reactive_component.pb` — Reactive diff streaming
- `exa.unified_state_sync_pb.unified_state_sync.pb` — USS token injection
- `exa.codeium_common_pb.codeium_common.pb` — `Model` enum, `Metadata`
- `exa.cortex_pb.cortex.pb` — Cascade types

### Why Not Static Proto Files

Static `.proto` from `Antigravity-Tools-LS/transcoder-core/proto/` goes stale when Antigravity updates. Extracting from extension.js keeps protos in sync with the installed binary.

### Output

- `src/gen/` — Generated TypeScript message classes and service stubs
- `proto/descriptors.binpb` — Assembled FileDescriptorSet (checked in as snapshot)
- `scripts/extract-protos.ts` — Build script

### Build Script (`scripts/extract-protos.ts`)

```
Step 1: Extract 24 FileDescriptorProto .pb files via AssetProvisioner.extractProtos()
Step 2: Assemble into single FileDescriptorSet
        Each .pb is a FileDescriptorProto, NOT a FileDescriptorSet.
        Assembly: for each pb → tag 0x0A + varint(length) + data
        → proto/descriptors.binpb
Step 3: npx @bufbuild/buf generate --descriptor_set_in=proto/descriptors.binpb
        → src/gen/*.ts
Step 4: (optional) Write .proto text files for human reference
Step 5: Export barrel src/gen/index.ts
```

### buf.gen.yaml

```yaml
version: v2
plugins:
  - local: protoc-gen-es
    out: src/gen
    opt:
      - target=ts
```

### package.json scripts

```json
{
  "scripts": {
    "extract-protos": "bun scripts/extract-protos.ts",
    "generate": "npm run extract-protos && npx @bufbuild/buf generate --descriptor_set_in=proto/descriptors.binpb",
    "prebuild": "npm run generate"
  }
}
```

For CI without Antigravity.app: check in `proto/descriptors.binpb` as snapshot fallback.

### Key Detail

- Proto packages: non-standard names like `exa.language_server_pb` — verify buf handles them
- Some protos import `google/protobuf/timestamp.proto` — buf well-known types cover this
- `Model` enum in `exa.codeium_common_pb` is critical — maps model names to numeric IDs
- Extraction regex: `fileDesc\)\("([A-Za-z0-9+/=]+)"` in minified extension.js

### Verification

```bash
npx vitest run src/lscore/proto-gen.test.ts
```

- Import generated `Model` enum, assert `Model.MODEL_CLAUDE_4_SONNET === 281`
- Assert `Model.MODEL_GOOGLE_GEMINI_2_5_PRO === 246`
- Encode/decode `StartCascadeRequest` roundtrip

---

## Module 2: Connect+Proto Frame Codec

### What

Binary frame encoding/decoding for the Connect Protocol used by Extension Server.

### Frame Spec (from `extension_server.rs` L34-68)

- Data frame: `[0x00][4B big-endian length][protobuf payload]`
- EndStream frame: `[0x02][4B big-endian length][JSON "{}"]`

### Output

`src/lscore/connect-wire.ts`:

```typescript
export function encodeData(proto: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + proto.length)
  frame[0] = 0x00
  new DataView(frame.buffer).setUint32(1, proto.length, false)
  frame.set(proto, 5)
  return frame
}

export function encodeEndStream(): Uint8Array {
  const json = new TextEncoder().encode("{}")
  const frame = new Uint8Array(5 + json.length)
  frame[0] = 0x02
  new DataView(frame.buffer).setUint32(1, json.length, false)
  frame.set(json, 5)
  return frame
}

export function decodePayload(frame: Uint8Array): Uint8Array {
  if (frame.length < 5) return frame
  return frame.slice(5)
}
```

### Verification

```bash
npx vitest run src/lscore/connect-wire.test.ts
```

- `encodeData` of known protobuf → check first 5 bytes
- `decodePayload(encodeData(data))` roundtrip === original
- `encodeEndStream()` → `[0x02, 0x00, 0x00, 0x00, 0x02, 0x7B, 0x7D]`

---

## Module 3: Extension Server

### What

HTTP server on random local port speaking Connect+Proto. Simulates an IDE Extension Server for ls_core to authenticate and sync state.

### Input

- Random free port (allocated by caller)
- CSRF token (UUID per instance)
- Current access token (from existing plugin token infrastructure)
- Token change subscription

### Output

`src/lscore/extension-server.ts`:

```typescript
class ExtensionServer {
  start(
    port: number,
    csrfToken: string,
    getAccessToken: () => string,
    onTokenChange: (cb: (token: string) => void) => () => void,
  ): Promise<void>
  stop(): Promise<void>
  port: number
}
```

### RPC Endpoints

| Route suffix                       | Type          | Behavior                                                                                                                |
| ---------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GetSecretValue`                   | Unary         | Return current access token                                                                                             |
| `SubscribeToUnifiedStateSyncTopic` | Server stream | `uss-oauth`: InitialState with 5 keys + AppliedUpdate on token change + 30s heartbeat. Other topics: empty InitialState |
| `LanguageServerStarted`            | Unary         | Log, return empty                                                                                                       |
| `LogEvent`                         | Unary         | Log, return empty                                                                                                       |
| `IsAgentManagerEnabled`            | Unary         | `{ enabled: false }`                                                                                                    |
| `PushUnifiedStateSyncUpdate`       | Unary         | Accept, discard, return empty                                                                                           |
| `GetChromeDevtoolsMcpUrl`          | Unary         | `{ url: "" }`                                                                                                           |

### Request Format

- URL: `http://127.0.0.1:{es_port}/exa.extension_server_pb.ExtensionServerService/{MethodName}`
- Content-Type: `application/connect+proto`
- CSRF: `x-codeium-csrf-token` header must match

### USS OAuth Token Injection (critical)

When topic is `uss-oauth`:

1. Build `OAuthTokenInfo { access_token, token_type: "Bearer", expiry }` → protobuf → Base64
2. Create `Topic { data: { [key]: Row { value: base64, e_tag: 1 } } }` for 5 keys:
   - `oauthTokenInfoSentinelKey`, `primary-account`, `active-account`, `current-account`, `default-account`
3. Send as `UnifiedStateSyncUpdate { initial_state: topic }`
4. On token change → `AppliedUpdate` for each key
5. Every 30s → heartbeat `AppliedUpdate`

### Response Format

- Unary: `Content-Type: application/connect+proto`, body = `encodeData(responseProto) + encodeEndStream()`
- Streaming: chunked, each chunk = `encodeData(updateProto)`, final = `encodeEndStream()`

### Integration with Existing Token Infrastructure

The Extension Server consumes tokens from the existing plugin's `refreshAccessToken()` in `token.ts`. When `AccountManager` rotates to a new account, the Extension Server receives the new token via its callback.

```typescript
// In manager.ts, when creating an ExtensionServer:
const getToken = () => currentAccessToken
const unsub = accountManager.onTokenChange((token) => {
  currentAccessToken = token
})
await extensionServer.start(esPort, csrfToken, getToken, (cb) => {
  // Wire to existing token infrastructure
})
```

### Key Detail

- NOT gRPC — it's Connect Protocol over plain HTTP
- Node's `http.createServer()` or `Bun.serve()` can handle it
- Request body needs `decodePayload()` to strip 5-byte frame header before proto deserialization

### Verification

```bash
npx vitest run src/lscore/extension-server.test.ts
```

- Start server, send `GetSecretValue` with correct CSRF → response decodes to correct token
- Subscribe `uss-oauth` → InitialState has 5 keys with valid Base64 `OAuthTokenInfo`
- CSRF mismatch → 403
- Token change → AppliedUpdate received

---

## Module 4: ls_core Process Manager

### What

Manage ls_core native process lifecycle: spawn, readiness detection, stdin metadata injection, LRU pool, TTL cleanup.

### Integration with Existing AccountManager

The existing `AccountManager` in `accounts.ts` manages account selection and rotation. `LsCoreManager` maps each account (by refresh token hash) to an ls_core process instance.

```
AccountManager.selectAccount(family, model)
  → accountIndex
  → identity = md5(account.refreshToken)
  → LsCoreManager.acquire(identity)
  → LsCoreInstance { grpcAddr, csrfToken, tlsCert }
```

### Output

`src/lscore/manager.ts`:

```typescript
type LsCoreInstance = {
  grpcAddr: string // 127.0.0.1:{server_port}
  csrfToken: string
  tlsCert: Uint8Array
  identity: string
  lastError(): string | undefined
}

class LsCoreManager {
  constructor(assets: ProvisionedAssets, opts: { maxInstances: number; idleTimeout: number })
  acquire(
    identity: string,
    tokenManager: { getAccessToken(): string; onTokenChange(cb): unsubscribe },
  ): Promise<LsCoreInstance>
  release(instance: LsCoreInstance): void
  shutdown(): Promise<void>
}
```

### Instance Lifecycle

1. **Port allocation**: 3 free ports (lsp_port, server_port, es_port) via `net.createServer().listen(0)`

2. **Token pre-exchange**: Use existing `refreshAccessToken()` to get fresh token

3. **Extension Server start**: Start on es_port with CSRF + token

4. **Process spawn** via `child_process.spawn()` (or `Bun.spawn()`):

   ```
   env: {
     HOME: dataDir/isolated_vs_{md5(identity)},
     CLOUD_CODE_ENDPOINT: assets.cloudCodeEndpoint,
     VSCODE_PID: process.pid.toString(),
     ELECTRON_RUN_AS_NODE: "1",
     VSCODE_NLS_CONFIG: '{"locale":"en-us"}'
   }
   args: [
     assets.binaryPath,
     "-server_port", serverPort,
     "-extension_server_port", esPort,
     "-csrf_token", csrfToken
   ]
   stdin: "pipe", stderr: "pipe"
   ```

5. **Stdin metadata injection**: Write protobuf `InitMetadata` then close stdin:

   ```
   InitMetadata {
     ide_name: "antigravity",                 // tag 1
     extension_version: assets.version,       // tag 2 — DYNAMIC
     api_key: "",                              // tag 3 — MUST be empty
     locale: "en_US",                          // tag 4
     ide_version: assets.version,             // tag 7 — DYNAMIC
     session_id: uuid(),                      // tag 10
     extension_name: "antigravity",           // tag 12
     device_fingerprint: md5(identity),       // tag 24
     trigger_id: uuid(),                      // tag 25
     detect_and_use_proxy: 1,                 // tag 34
   }
   ```

   ⚠️ `ide_version` and `extension_version` MUST match `Info.plist` `CFBundleShortVersionString`.

6. **Readiness probe**: TCP connect to `127.0.0.1:{server_port}` every 300ms, timeout 10s

7. **stderr monitoring**: Background reader, cache last error. Detect `PERMISSION_DENIED`, `Verify your account`

8. **Sandbox isolation**: Each instance gets `~/.antigravity_tools_ls/data/isolated_vs_{hash}` as HOME

### Pool Management

- `maxInstances: 3` (configurable via `config.max_instances`)
- LRU eviction when full: kill oldest `lastAccessed`
- TTL cleanup: every 60s, reclaim instances idle > `config.idle_timeout` (default 1800s)
- Reuse: same identity → return existing if healthy

### Key Detail

- `api_key` in InitMetadata MUST be empty — tokens injected via Extension Server
- stdin MUST close after write — ls_core blocks waiting for EOF
- Binary is 149MB Mach-O arm64 — memory per instance can exceed 2GB peak
- Process cleanup on parent exit: listen for `process.on('exit')` and SIGTERM

### Verification

```bash
npx vitest run src/lscore/manager.test.ts
```

- Unit: LRU eviction — add 4 instances with max=3, oldest killed
- Unit: TTL cleanup — create instance, advance clock 31min, cleanup runs
- Unit: sandbox directory created + cleaned on dispose
- Integration: spawn real ls_core, readiness probe succeeds within 10s

---

## Module 5: Cascade Client

### What

gRPC client implementing the three-step Cascade protocol with dual-layer streaming.

### Input

- `LsCoreInstance` from Module 4
- User prompt text (flattened from AI SDK messages)
- Model ID (numeric enum)

### Output

`src/lscore/cascade-client.ts`:

```typescript
class CascadeClient {
  connect(grpcAddr: string, csrfToken: string, tlsCert: Uint8Array): Promise<void>
  chat(prompt: string, modelId: number, signal?: AbortSignal): AsyncIterable<string>
  close(): void
}
```

### Three-Step Protocol

```
Step 1: StartCascade
  Request: { metadata, trajectory_type: CASCADE }
  Response: { cascade_id }

Step 2: SendUserCascadeMessage
  Request: { cascade_id, metadata, items: [{ text: prompt }],
             cascade_config: { planner_config: { requested_model: modelId,
                                                  planner_type_config: Conversational } } }
  Response: { queued: true }

Step 3: StreamCascadeReactiveUpdates (primary) + GetCascadeTrajectory (fallback)
  Request: { protocol_version: 1, id: cascade_id, subscriber_id: uuid }
  Response: stream of { version, diff: MessageDiff }
```

### Reactive Diff Text Extraction

Path through MessageDiff: field `1` (steps) → field `20` (planner_response) → field `1` (response).

Recursive `FieldDiff` traversal:

- `UpdateSingular` with `StringValue` at leaf → full accumulated text
- Track `lastSentLen`, yield `fullText[lastSentLen:]` as delta

### Dual Strategy

1. **Primary**: `StreamCascadeReactiveUpdates` — real-time
2. **Fallback**: Poll `GetCascadeTrajectory` every 500ms if stream fails. Exit when `status === Idle`

### gRPC Connection

- TLS with CA from `cert.pem`, server name `localhost`
- `x-codeium-csrf-token` in gRPC metadata on every request
- HTTP/2 keep-alive: 30s
- Connect timeout: 10s

### Metadata

```typescript
const metadata = {
  ide_name: "antigravity",
  ide_version: assets.version, // DYNAMIC
  extension_name: "antigravity",
  extension_version: assets.version, // DYNAMIC
}
```

### Key Detail

- `@grpc/grpc-js` for gRPC client (HTTP/2 + TLS)
- Model ID is numeric proto enum, NOT string
- Must call `AddTrackedWorkspace` and `SetWorkingDirectories` during setup (see `client.rs` L106-133)
- CSRF in gRPC metadata: `call.metadata.set('x-codeium-csrf-token', csrfToken)`

### Verification

```bash
npx vitest run src/lscore/cascade-client.test.ts
```

- Unit: mock gRPC stream, `extract_text_from_diff` walks field path `[1, 20, 1]`
- Unit: fallback polling activates on reactive stream error
- Unit: delta tracking — "Hello" then "Hello World" yields "Hello", " World"
- Integration: live ls_core, send "Hello", text deltas arrive

---

## Module 6: Plugin Integration (The Glue)

### What

Wire new ls_core modules into the existing plugin entry (`src/plugin.ts`). The key integration point is the `fetch()` function returned by `auth.loader`.

### Current Flow (HTTP)

```typescript
// In auth.loader():
return {
  apiKey: "",
  async fetch(input, init) {
    if (!isGenerativeLanguageRequest(input)) return fetch(input, init)
    // 1. AccountManager selects account
    // 2. prepareAntigravityRequest() transforms to Antigravity HTTP
    // 3. fetch() to Google API
    // 4. transformAntigravityResponse() transforms response
    // 5. Handle 429 rate limits, rotate accounts, retry
    return response
  },
}
```

### New Flow (ls_core gRPC)

```typescript
// In auth.loader():
const assets = await AssetProvisioner.ensure({ ...config })
const lscoreManager = new LsCoreManager(assets, {
  maxInstances: config.max_instances ?? 3,
  idleTimeout: config.idle_timeout ?? 1800,
})

return {
  apiKey: "",
  async fetch(input, init) {
    if (!isGenerativeLanguageRequest(input)) return fetch(input, init)

    // 1. AccountManager selects account (EXISTING — no change)
    const { account, accountIndex } = accountManager.selectAccount(family, model)

    // 2. Refresh token (EXISTING token infrastructure)
    const accessToken = await refreshAccessToken(auth, client, providerId)

    // 3. Acquire ls_core instance (NEW)
    const identity = md5(account.refreshToken)
    const instance = await lscoreManager.acquire(identity, {
      getAccessToken: () => accessToken,
      onTokenChange: (cb) => accountManager.onTokenChange(cb),
    })

    // 4. Extract model + prompt from AI SDK request (NEW)
    const body = await parseRequestBody(input, init)
    const prompt = flattenMessages(body.contents)
    const modelId = resolveModelEnum(body.model)

    // 5. Send via Cascade (NEW)
    const cascadeClient = new CascadeClient()
    await cascadeClient.connect(instance.grpcAddr, instance.csrfToken, instance.tlsCert)

    // 6. Convert Cascade stream to SSE Response (NEW)
    const sseStream = cascadeStreamToSSE(cascadeClient.chat(prompt, modelId, init?.signal))
    return new Response(sseStream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })
  },
}
```

### What Changes in plugin.ts

1. **Add** ls_core initialization in `loader()`:
   - `AssetProvisioner.ensure()` on first load
   - `LsCoreManager` creation with config
   - Cert expiry warning via `client.tui.showToast()`

2. **Replace** the fetch body's HTTP routing with Cascade routing (the `while(true)` retry loop with account rotation stays, but inner body changes)

3. **Keep** ALL existing logic for:
   - Account selection (`accountManager.selectAccount`)
   - Rate limit handling (429 → rotate → retry)
   - Toast notifications
   - Debug logging
   - Session recovery hooks
   - Event handling
   - Auto-update checker
   - Google Search tool

4. **Add** ls_core cleanup in shutdown/exit handler

### Cascade Stream → SSE Response Conversion

The existing plugin returns `Response` objects with SSE body (what `@ai-sdk/google` expects). The new flow must produce identical SSE format:

```typescript
function cascadeStreamToSSE(deltas: AsyncIterable<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      let accumulated = ""
      for await (const delta of deltas) {
        accumulated += delta
        // Emit SSE event matching Google Generative Language API format
        const payload = {
          candidates: [
            {
              content: { parts: [{ text: accumulated }], role: "model" },
              finishReason: null,
            },
          ],
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
      }
      // Final event with finishReason
      const final = {
        candidates: [
          {
            content: { parts: [{ text: accumulated }], role: "model" },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: Math.max(1, Math.floor(accumulated.length / 4)),
          candidatesTokenCount: Math.max(1, Math.floor(accumulated.length / 4)),
        },
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(final)}\n\n`))
      controller.close()
    },
  })
}
```

### Model Resolution

Map AI SDK model names (from `opencode.json`) to ls_core proto enum IDs:

```typescript
// src/lscore/models.ts
const MODEL_MAP: Record<string, number> = {
  // Antigravity-prefixed names (existing plugin convention)
  "antigravity-gemini-3-pro": 246, // MODEL_GOOGLE_GEMINI_2_5_PRO → adjust per actual enum
  "antigravity-gemini-3-flash": 312,
  "antigravity-claude-sonnet-4-6": 281,
  "antigravity-claude-opus-4-6-thinking": 333,
  // Bare names
  "gemini-2.5-pro": 246,
  "gemini-2.5-flash": 312,
  "claude-4-sonnet": 281,
  "claude-4.5-sonnet": 333,
}

// Numeric passthrough: "model-350" → 350
function resolveModelEnum(name: string): number {
  if (MODEL_MAP[name]) return MODEL_MAP[name]
  const match = name.match(/^model-(\d+)$/)
  if (match) return parseInt(match[1], 10)
  throw new Error(`Unknown model: ${name}`)
}
```

### Config Schema Additions

Add to `src/plugin/config/schema.ts`:

```typescript
// ls_core specific
max_instances: z.number().int().min(1).max(10).default(3).describe("Max ls_core process pool size"),
idle_timeout: z.number().int().min(60).default(1800).describe("Idle instance timeout in seconds"),
binary_path: z.string().optional().describe("Explicit path to ls_core binary"),
cert_path: z.string().optional().describe("Explicit path to cert.pem"),
auto_provision: z.boolean().default(true).describe("Auto-discover/download ls_core binary"),
```

### Key Detail

- The `fetch()` interception stays — `@ai-sdk/google` still calls `fetch()` to `generativelanguage.googleapis.com`
- We intercept and route to ls_core instead of forwarding to Google
- SSE response format must match what `@ai-sdk/google` expects (same JSON shape as Google Generative Language API)
- Account rotation on error: if ls_core Cascade fails, mark account as rate-limited and try next (same logic)
- No HTTP fallback — ls_core is the sole transport

### Verification

```bash
npx vitest run src/plugin/request.test.ts  # Updated tests
```

- Unit: `cascadeStreamToSSE` produces valid SSE events with correct JSON shape
- Unit: `resolveModelEnum` maps all expected model names
- Unit: `flattenMessages` converts AI SDK message format to Cascade prompt text
- Integration: full round-trip — fetch interception → ls_core → SSE response

---

## Module 7: E2E Testing

### Tier A: Automated E2E Tests

All tests share setup in `test/e2e/lscore.test.ts`:

```typescript
import { AssetProvisioner } from "../../src/lscore/asset-provisioner"
import { LsCoreManager } from "../../src/lscore/manager"
import { CascadeClient } from "../../src/lscore/cascade-client"

const REFRESH_TOKEN = process.env.ANTIGRAVITY_REFRESH_TOKEN
if (!REFRESH_TOKEN) throw new Error("Set ANTIGRAVITY_REFRESH_TOKEN")
```

**1. Asset Provisioning**

```typescript
test("asset provisioning detects version and binary", async () => {
  const assets = await AssetProvisioner.ensure({ autoUpdate: false })
  expect(assets.binaryPath).toMatch(/language_server_macos_arm|ls_core/)
  expect(assets.version).toMatch(/^\d+\.\d+\.\d+$/)
  const expiry = AssetProvisioner.checkCertExpiry(assets.certPath)
  expect(expiry.valid).toBe(true)
})
```

**2. Token Exchange**

```typescript
test("token exchange with real refresh token", async () => {
  // Uses existing plugin's refreshAccessToken()
  const { access } = await exchangeToken(REFRESH_TOKEN)
  expect(access.length).toBeGreaterThan(50)
})
```

**3. ls_core Spawn + Readiness**

```typescript
test("ls_core spawns and becomes ready within 10s", async () => {
  const assets = await AssetProvisioner.ensure({ autoUpdate: false })
  const manager = new LsCoreManager(assets, { maxInstances: 1, idleTimeout: 60 })
  const instance = await manager.acquire(REFRESH_TOKEN, tokenManager)
  expect(instance.grpcAddr).toMatch(/^127\.0\.0\.1:\d+$/)
  await manager.shutdown()
}, 15_000)
```

**4. Cascade Smoke**

```typescript
test("send prompt via Cascade, receive text", async () => {
  // Full 3-step protocol
  const client = new CascadeClient()
  await client.connect(instance.grpcAddr, instance.csrfToken, instance.tlsCert)
  let text = ""
  for await (const delta of client.chat("Reply with exactly: hello world", geminiFlashId)) {
    text += delta
  }
  expect(text.toLowerCase()).toContain("hello")
}, 30_000)
```

**5. SSE Response Format**

```typescript
test("cascadeStreamToSSE produces valid Google API SSE", async () => {
  // Mock cascade deltas → verify SSE lines match @ai-sdk/google expectations
  const stream = cascadeStreamToSSE(mockDeltas(["Hello", " World"]))
  const lines = await collectSSE(stream)
  expect(lines[0]).toContain('"candidates"')
  expect(lines[0]).toContain('"text":"Hello"')
})
```

**6. Abort/Cancellation**

```typescript
test("abort signal cancels Cascade and cleans up", async () => {
  const controller = new AbortController()
  let count = 0
  for await (const delta of client.chat("Write a long essay", modelId, controller.signal)) {
    count++
    if (count >= 3) controller.abort()
  }
  // Verify no zombie processes
  await new Promise((r) => setTimeout(r, 1000))
  const procs = countLsCoreProcesses()
  expect(procs).toBeLessThanOrEqual(1)
}, 15_000)
```

**7. Version Alignment**

```typescript
test("provisioned version matches Info.plist", async () => {
  const assets = await AssetProvisioner.ensure({ autoUpdate: false })
  const plistVersion = readPlistVersion()
  if (plistVersion) expect(assets.version).toBe(plistVersion)
})
```

### Tier B: opencode Integration Smoke Test (manual, by user)

**Prerequisites**: Antigravity.app installed, Google account with Cloud Code Assist.

**Step 1: Build locally**

```bash
cd 3rd-github/opencode-antigravity-auth && npm install && npm run build
```

**Step 2: Configure `~/.config/opencode/opencode.json`**

Use `file://` absolute path for local plugin:

```jsonc
{
  "provider": {
    "google": {
      "models": {
        "antigravity-gemini-3-flash": {
          "name": "Gemini 3 Flash (ls_core)",
          "limit": { "context": 1048576, "output": 65536 },
          "modalities": { "input": ["text"], "output": ["text"] },
        },
      },
    },
  },
  "plugin": ["file:///absolute/path/to/3rd-github/opencode-antigravity-auth"],
}
```

**Step 3: Launch opencode**

```bash
opencode
# Plugin triggers Google OAuth2 flow
# User authenticates → refresh token stored
```

**Step 4: Send prompt**

Select `google/antigravity-gemini-3-flash`, type "What is 2+2?", press Enter.

**Expected**: Stream starts within 10s. Text appears incrementally. Response contains "4". `ps aux | grep language_server_macos` shows 1 process.

**Step 5: Exit + verify cleanup**

```bash
# Ctrl+C opencode, wait 3s
ps aux | grep language_server_macos
# Expected: no processes remaining
```

---

## Package Structure (After Fork)

```
3rd-github/opencode-antigravity-auth/
├── src/
│   ├── plugin.ts                  # MODIFIED — add ls_core init + route
│   ├── constants.ts               # KEEP
│   ├── constants.test.ts          # KEEP
│   ├── shims.d.ts                 # KEEP
│   ├── antigravity/
│   │   └── oauth.ts               # KEEP
│   ├── hooks/
│   │   └── auto-update-checker/   # KEEP
│   ├── lscore/                    # ← NEW directory
│   │   ├── asset-provisioner.ts   # Module 0
│   │   ├── asset-provisioner.test.ts
│   │   ├── manager.ts             # Module 4
│   │   ├── manager.test.ts
│   │   ├── extension-server.ts    # Module 3
│   │   ├── extension-server.test.ts
│   │   ├── cascade-client.ts      # Module 5
│   │   ├── cascade-client.test.ts
│   │   ├── connect-wire.ts        # Module 2
│   │   ├── connect-wire.test.ts
│   │   ├── models.ts              # Module 6 (model resolver)
│   │   ├── models.test.ts
│   │   └── types.ts
│   ├── gen/                       # ← NEW — generated proto TypeScript
│   │   └── index.ts
│   └── plugin/
│       ├── accounts.ts            # KEEP
│       ├── auth.ts                # KEEP
│       ├── cache.ts               # KEEP
│       ├── cache/                 # KEEP
│       ├── cli.ts                 # KEEP
│       ├── config/                # MODIFY (add ls_core fields)
│       ├── core/
│       │   └── streaming/         # REPLACE (Cascade → SSE)
│       ├── debug.ts               # KEEP
│       ├── errors.ts              # KEEP
│       ├── fingerprint.ts         # DELETE
│       ├── logger.ts              # KEEP
│       ├── project.ts             # KEEP
│       ├── quota.ts               # KEEP
│       ├── recovery.ts            # KEEP
│       ├── recovery/              # KEEP
│       ├── refresh-queue.ts       # KEEP
│       ├── request.ts             # REPLACE (HTTP → Cascade routing)
│       ├── request-helpers.ts     # TRIM (keep prompt flattening only)
│       ├── rotation.ts            # KEEP
│       ├── server.ts              # KEEP
│       ├── storage.ts             # KEEP
│       ├── stores/                # KEEP
│       ├── thinking-recovery.ts   # SIMPLIFY
│       ├── token.ts               # KEEP
│       ├── types.ts               # KEEP
│       ├── ui/                    # KEEP
│       └── version.ts             # KEEP
├── proto/
│   └── descriptors.binpb          # ← NEW — checked-in snapshot
├── scripts/
│   └── extract-protos.ts          # ← NEW — build script
├── buf.gen.yaml                   # ← NEW
├── test/
│   ├── unit/                      # Existing + new lscore tests
│   └── e2e/
│       └── lscore.test.ts         # ← NEW
├── package.json                   # MODIFY (add deps, scripts)
├── tsconfig.json                  # KEEP
└── vitest.config.ts               # KEEP
```

## Implementation Order

```
Module 0 (AssetProvisioner) ───┐
Module 1 (Proto gen) ──────────┤
Module 2 (Connect wire) ───────┤ ← Parallel, no dependencies
                               │
Module 3 (ExtensionServer) ────┤ ← Depends on Module 1+2
                               │
Module 4 (LsCoreManager) ──────┤ ← Depends on Module 0+3
                               │
Module 5 (CascadeClient) ──────┤ ← Depends on Module 0+1
                               │
Module 6 (Plugin Integration) ─┤ ← Depends on Module 4+5 + existing plugin
                               │
Module 7 (E2E Testing) ────────┘ ← Depends on all
```

Modules 0, 1, 2 can be done in parallel. Module 3 needs 1+2. Module 4 needs 0+3. Module 5 needs 0+1. Module 6 needs 4+5. Module 7 is last.

## Risks & Mitigations

| Risk                                              | Impact                      | Mitigation                                                        |
| ------------------------------------------------- | --------------------------- | ----------------------------------------------------------------- |
| `@grpc/grpc-js` incompatible with Bun runtime     | Blocks Module 5             | Fallback: raw HTTP/2 via `node:http2`                             |
| ls_core version mismatch                          | 403 from Google             | Module 0: dynamic version from `Info.plist`                       |
| Token injection timing race                       | ls_core auth failure        | Start ExtensionServer BEFORE spawning ls_core                     |
| SSE format mismatch with `@ai-sdk/google`         | Broken streaming            | Match exact JSON shape from real Google API responses             |
| cert.pem expires (2026-09-04)                     | Silent TLS failure          | Module 0: `checkCertExpiry()` on startup                          |
| Existing HTTP-only users can't migrate seamlessly | Must reinstall/reconfigure  | Clear migration docs; version bump to 2.0 signals breaking change |
| Cascade prompt is flat text                       | Degraded quality            | Rich text template with XML tags for message boundaries           |
| Memory: each ls_core instance >2GB                | OOM with multiple instances | Default `maxInstances: 3`, configurable                           |

## Out of Scope

- Multi-platform support — macOS arm64 only initially
- Tool call passthrough — Cascade tools are internal
- Streaming thinking/reasoning extraction — future enhancement
- HTTP transport fallback — this fork is ls_core only
- Dynamic proto hot-reload without rebuild
- Cloud Code reverse proxy (loadCodeAssist interception)
