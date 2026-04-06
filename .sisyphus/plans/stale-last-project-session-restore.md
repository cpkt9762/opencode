# Stale `lastProjectSession` Restore Guard Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent startup project restore from calling `session.get()` for stale persisted `lastProjectSession` values while preserving the existing fallback to the latest valid session.

**Architecture:** Keep restore ownership inside `packages/app/src/pages/layout.tsx`. Add a tiny pure helper in `packages/app/src/pages/layout/helpers.ts` that distinguishes persisted startup restore from discovered restore candidates. Persisted startup restore may only reopen sessions already visible in the bootstrapped local session store; if missing, clear the stale persisted key and continue through the existing `latestRootSession(...)` fallback chain unchanged.

**Tech Stack:** SolidJS, TypeScript, Bun test, persisted local storage state, `@opencode-ai/sdk`

---

## File Map

- Modify: `packages/app/src/pages/layout.tsx`
- Modify: `packages/app/src/pages/layout/helpers.ts`
- Test: `packages/app/src/pages/layout/helpers.test.ts`
- Do not modify: `packages/app/src/context/global-sync/bootstrap.ts`
- Do not modify: `packages/app/src/context/sync.tsx`
- Do not modify: `packages/opencode/src/server/routes/session.ts`

## Scope Notes

- Root cause is the startup restore branch in `packages/app/src/pages/layout.tsx:1319-1325`.
- The first stale-ID fetch happens inside `openSession()` at `packages/app/src/pages/layout.tsx:1308-1311`.
- This plan intentionally does **not** change warmup/hydration paths that also call `session.get()`; they are not the persisted-startup-restore culprit.

### Task 1: Lock the restore policy in a pure unit test

**Files:**

- Modify: `packages/app/src/pages/layout/helpers.test.ts`
- Modify: `packages/app/src/pages/layout/helpers.ts`

- [ ] **Step 1: Add failing tests for persisted-vs-candidate restore policy**

```ts
import { shouldFetchSessionForRestore } from "./helpers"

test("skips remote resolution for persisted startup restore", () => {
  expect(shouldFetchSessionForRestore("persisted")).toBe(false)
})

test("allows remote resolution for discovered restore candidates", () => {
  expect(shouldFetchSessionForRestore("candidate")).toBe(true)
})
```

- [ ] **Step 2: Run the targeted test to prove the helper does not exist yet**

Run from `packages/app`:

```bash
bun test --preload ./happydom.ts ./src/pages/layout/helpers.test.ts
```

Expected: FAIL because `shouldFetchSessionForRestore` is missing.

- [ ] **Step 3: Add the minimal pure helper to `helpers.ts`**

```ts
export const shouldFetchSessionForRestore = (source: "persisted" | "candidate") => source === "candidate"
```

- [ ] **Step 4: Re-run the targeted test**

Run from `packages/app`:

```bash
bun test --preload ./happydom.ts ./src/pages/layout/helpers.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/pages/layout/helpers.ts packages/app/src/pages/layout/helpers.test.ts
git commit -m "test: codify restore fetch policy"
```

### Task 2: Thread the policy into the startup restore path

**Files:**

- Modify: `packages/app/src/pages/layout.tsx:1300-1325`
- Reference: `packages/app/src/pages/layout/helpers.ts`

- [ ] **Step 1: Extend `openSession()` to accept a restore source**

Use an explicit source tag such as:

```ts
type RestoreSource = "persisted" | "candidate"
```

and thread it through:

```ts
const openSession = async (target: { directory: string; id: string }, source: RestoreSource) => {
  ...
}
```

- [ ] **Step 2: Keep the local-store fast path unchanged**

Preserve the existing branch that immediately navigates when the session already exists in:

```ts
globalSync.child(target.directory, { bootstrap: false })[0].session
```

This keeps valid persisted sessions working without any extra requests.

- [ ] **Step 3: Block remote `session.get()` only for persisted startup restore**

Before this block:

```ts
const resolved = await globalSDK.client.session.get({ sessionID: target.id })
```

add the guard:

```ts
if (!shouldFetchSessionForRestore(source)) return false
```

Effect:

- persisted startup restore: no remote resolution for a missing cached session
- discovered candidate restore (`latest` / `fetched`): existing remote resolution behavior stays intact

- [ ] **Step 4: Call `openSession(projectSession, "persisted")` in the stale-key branch**

Keep this flow in place:

```ts
const projectSession = store.lastProjectSession[root]
...
if (!opened) clearLastProjectSession(root)
```

This means stale persisted IDs are still deleted, but the app no longer emits a doomed `session.get()` request first.

- [ ] **Step 5: Keep the fallback chain unchanged for valid alternatives**

Continue to use the existing order after a failed persisted restore:

1. `latestRootSession(...)` from local child stores
2. `latestRootSession(...)` from fetched `session.list({ directory })`
3. empty `/session` route

Those calls should pass `"candidate"` so the rest of the restore behavior remains unchanged.

- [ ] **Step 6: Add a targeted decision test for the startup restore branch**

Create or extend a small testable helper in `packages/app/src/pages/layout/helpers.ts` so the startup decision can be verified without mounting the full page. The helper should accept the minimum inputs needed to decide whether to:

1. reopen immediately from the bootstrapped child-store session list,
2. skip remote fetch and clear stale persisted state,
3. allow remote resolution for a non-persisted candidate.

Example shape:

```ts
type RestoreInput = {
  source: "persisted" | "candidate"
  cached: boolean
}

type RestoreDecision = "open_cached" | "skip_fetch" | "fetch_remote"

export const restoreDecision = (input: RestoreInput): RestoreDecision => {
  if (input.cached) return "open_cached"
  if (input.source === "persisted") return "skip_fetch"
  return "fetch_remote"
}
```

Add tests that explicitly cover the acceptance points:

```ts
test("persisted restore with missing cached session skips remote fetch", () => {
  expect(restoreDecision({ source: "persisted", cached: false })).toBe("skip_fetch")
})

test("persisted restore with cached session still opens", () => {
  expect(restoreDecision({ source: "persisted", cached: true })).toBe("open_cached")
})

test("candidate restore with missing cached session still fetches remotely", () => {
  expect(restoreDecision({ source: "candidate", cached: false })).toBe("fetch_remote")
})
```

- [ ] **Step 7: Run the targeted decision test before wiring the UI call site**

Run from `packages/app`:

```bash
bun test --preload ./happydom.ts ./src/pages/layout/helpers.test.ts
```

Expected: FAIL until the decision helper exists and the assertions match the intended policy.

- [ ] **Step 8: Wire `layout.tsx` to the tested decision helper**

Replace the inline persisted/candidate branching in `openSession()` with the pure helper from the previous step so the behavior exercised in the test is the exact behavior used by `navigateToProject()`.

- [ ] **Step 9: Run the task-specific QA scenario with `bun test`**

Run from `packages/app`:

```bash
bun test --preload ./happydom.ts ./src/pages/layout/helpers.test.ts
```

Expected: PASS with explicit coverage for all three outcomes below in the test output:

- persisted startup restore + `cached: false` => `skip_fetch`
- persisted startup restore + `cached: true` => `open_cached`
- candidate restore + `cached: false` => `fetch_remote`

This is the required proof that the new startup-restore policy is correct before relying on any higher-level page flow.

- [ ] **Step 10: Commit**

```bash
git add packages/app/src/pages/layout.tsx packages/app/src/pages/layout/helpers.ts packages/app/src/pages/layout/helpers.test.ts
git commit -m "fix: skip stale last session restore fetch"
```

### Task 3: Verify the change stays narrowly scoped

**Files:**

- Verify: `packages/app/src/pages/layout.tsx`
- Verify: `packages/app/src/pages/layout/helpers.ts`
- Verify: `packages/app/src/pages/layout/helpers.test.ts`

- [ ] **Step 1: Re-run the targeted layout helper test**

Run from `packages/app`:

```bash
bun test --preload ./happydom.ts ./src/pages/layout/helpers.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the focused page test slice**

Run from `packages/app`:

```bash
bun test --preload ./happydom.ts ./src/pages/layout/helpers.test.ts ./src/context/layout.test.ts
```

Expected:

- `helpers.test.ts` proves persisted restore without a cached session now resolves to `skip_fetch`
- `helpers.test.ts` proves candidate restore without a cached session still resolves to `fetch_remote`
- existing layout-related tests still pass

- [ ] **Step 3: Run package type checking**

Run from `packages/app`:

```bash
bun typecheck
```

Expected: PASS.

- [ ] **Step 4: Perform an explicit code-path audit with `read`/`grep`**

Use the code-reading tools, not memory, against `packages/app/src/pages/layout.tsx`.

Run a targeted search for:

```text
openSession(projectSession, "persisted")
openSession(latest, "candidate")
openSession(fetched, "candidate")
globalSDK.client.session.get({ sessionID: target.id })
shouldFetchSessionForRestore(source)
clearLastProjectSession(root)
```

Read the final diff in `packages/app/src/pages/layout.tsx` and confirm these exact observations:

1. In the `projectSession` branch (`store.lastProjectSession[root]`), a missing cached session can no longer fall through to `globalSDK.client.session.get({ sessionID: target.id })`.
2. The same branch still reaches `clearLastProjectSession(root)` when startup restore fails.
3. The `latest` / `fetched` candidate branches still call `openSession(..., "candidate")` (or equivalent) and therefore preserve the remote-resolution path.
4. The cached-session fast path still navigates immediately for valid persisted sessions already present in `globalSync.child(...).session`.

This audit is only complete if each statement can be pointed to in the edited file.

- [ ] **Step 5: Run a final executable verification wave**

Run from `packages/app`:

```bash
bun test --preload ./happydom.ts ./src/pages/layout/helpers.test.ts ./src/context/layout.test.ts && bun typecheck
```

Expected:

- helper policy tests pass
- existing layout context tests pass
- typecheck passes

Treat this combined command as the final QA gate for the change.

- [ ] **Step 6: Optional local-app confirmation using browser storage + network logs**

If a reviewer wants runtime evidence beyond unit tests, use this repo-local checklist:

1. Start the app in a local desktop/web debugging setup.
2. Seed a fake stale entry in the persisted `layout.page` payload for one project root.
3. Reload into the project-open flow that calls `navigateToProject()`.
4. Use browser storage inspection to confirm the stale `lastProjectSession[root]` entry is cleared after the failed persisted restore.
5. Use the browser network panel or sidecar request logs to confirm the stale persisted branch does not emit a `session.get` request for that missing cached session.
6. Repeat with a candidate path and confirm candidate restore still reaches the remote-resolution path when no cached session is present.

This step is optional because the acceptance criteria should already be covered by the targeted decision test plus the code-path audit.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/pages/layout.tsx packages/app/src/pages/layout/helpers.ts packages/app/src/pages/layout/helpers.test.ts
git commit -m "chore: verify stale restore guard"
```

## Out of Scope

- Refactoring `navigateToProject()` into smaller modules
- Changing backend `Session.get()` semantics
- Changing `global-sync/bootstrap.ts` warmup behavior
- Adding timestamps, TTLs, or migrations for old persisted entries
- Broad route-state persistence redesign

## Risks and Guardrails

- Keep the fix inside `packages/app/src/pages/layout.tsx` and `packages/app/src/pages/layout/helpers.*` only.
- Do not change `latestRootSession(...)` ordering.
- Do not change the route-writing effect that calls `rememberSessionRoute()` / `syncSessionRoute()`.
- Do not hide unrelated `Session not found` errors from non-startup code paths.

## Rollback

If the fix regresses valid startup restore behavior:

1. Remove `shouldFetchSessionForRestore(...)`
2. Revert `openSession(..., source)` back to a single-argument function
3. Restore the previous remote-resolution fallback for persisted startup restore
