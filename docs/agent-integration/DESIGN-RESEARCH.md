# LinkMap Agent — Design-Research (spike ledger)

Source-of-truth record for the Phase 0 spikes gating the "Codex-powered browser agent" plan (`~/.claude/plans/deep-skipping-stearns.md`). Mirrors the codex/grok harness DESIGN-RESEARCH discipline: every claim below is a live probe on this machine, version-stamped, with the exact commands so it can be re-run. **No architectural lock-in ahead of a green spike.**

Environment: Windows 11, Node v24.4.1, `codex-cli 0.144.1` (ChatGPT subscription auth), branch `fix/restart-fragility`.

---

## Spike 1 — Does `codex exec` 0.144.1 auto-cancel MCP tool calls? (#24135) — **PASS**

**Date:** 2026-07-18 · **Gates:** the entire codex-as-brain architecture.

**Question.** Issue #24135 reports that headless `codex exec` auto-cancels MCP tool calls (closed stdin ≈ approval rejection), with the only documented workaround being `--dangerously-bypass-approvals-and-sandbox` — which is banned by `codex-worker-safety.md`. Does that reproduce on our 0.144.1?

**Method.** A throwaway stdio echo MCP server (`scratchpad/echo-mcp.mjs`, newline-delimited JSON-RPC 2.0, ~90 lines, zero deps) exposing one tool `echo(text)` that returns `ECHO_OK: <text>` — a server-only prefix, so a genuine round-trip is provable (the model cannot fabricate it). Injected into codex via `-c` overrides (no mutation of the shared global `~/.codex/config.toml`). Auth precheck: `codex login status` → "Logged in using ChatGPT". Calls wrapped in `env -u OPENAI_API_KEY -u CODEX_API_KEY` and `--disable multi_agent` (avoids the gpt-4.1 sub-agent 400).

Exact invocation (Probe A, default approval policy):
```bash
ECHO=".../scratchpad/echo-mcp.mjs"
env -u OPENAI_API_KEY -u CODEX_API_KEY codex exec \
  --disable multi_agent -s read-only \
  -c 'mcp_servers.echo_probe.command="node"' \
  -c "mcp_servers.echo_probe.args=[\"$ECHO\"]" \
  -o probeA.out.txt  - < prompt.txt
# prompt.txt: "Call the echo tool once with text 'spike1-roundtrip', reply RESULT=<what it returned>."
```

**Results.**

| Probe | Config | Bypass flag? | Outcome |
|-------|--------|--------------|---------|
| A | default `approval_policy` | **no** | **PASS** — tool called, `RESULT=ECHO_OK: spike1-roundtrip` |
| B | `-c approval_policy="never"` | **no** | **PASS** — same |

Codex's own telemetry both runs: `mcp: echo_probe/echo started` → `hook: PermissionRequest Completed` → `mcp: echo_probe/echo (completed)`. The clean `-o` output was exactly `RESULT=ECHO_OK: spike1-roundtrip`.

**Verdict: PASS — #24135 does NOT reproduce on 0.144.1** for a read-only `codex exec` MCP call. The bypass flag is not needed. `codex exec` is a viable brain transport; the node-pty fallback (Spike 3) and the M4 no-go branch are **not** triggered.

**Notes / carry-forward.**
- A `PermissionRequest` hook fires and auto-completes even under default policy; the MCP call is not gated to a hanging prompt. Whether a *mutating* MCP tool behaves the same is a Phase 2 (approval-engine) question, not a Spike 1 blocker.
- Startup noise (skill-YAML load errors; `rmcp::transport` auth failures from Dave's *other* global MCP servers — Notion/Linear/Neon/paper) is the documented cosmetic tax, unrelated to the probe. For the agent daemon, consider `--ignore-user-config` + `-c`-injected LinkMap server to cut that noise/latency — but note `--ignore-user-config` breaks workspace-write on Windows (codex-worker-safety), so it's only safe for the read-only brain path. Unverified; flag for a Phase 1 spike.
- The `-c mcp_servers.<name>` injection merges with existing servers (does not replace) — confirmed working.

---

## Spike 2 — Panel-owned WebSocket to `ws://127.0.0.1:<port>` — **PASS**

**Date:** 2026-07-18 · **Decides:** the bridge transport.

**Question.** Can the live unpacked side panel open `new WebSocket('ws://127.0.0.1:PORT')` with **zero manifest changes**, and does the loopback server observe `Origin === chrome-extension://<id>` (the security-critical fact the auth design depends on)?

**Method.** Loopback ws server `scratchpad/ws-probe-server.mjs` (imports `ws@8.19.0` by absolute path via `createRequire`; binds `127.0.0.1` ONLY; logs every connection's `Origin` header synchronously to `ws-probe.log`). Port **8181** (spike-only; a real 8xxx registry port must be allocated for Phase 1 per M9c).

**Part A — server + bidirectional frames (Node client): PASS.**
- `node ws-client-test.mjs` → server sent `{type:'hello'}`, client sent a frame, server echoed `{type:'echo',...}`. 2/2 frames, exit 0.
- Server log for the Node client: `Origin header : (none)` / `isChromeExt : false` — the correct baseline (a non-browser client carries no chrome-extension Origin; this is exactly what the Origin check must reject).

**Part B — chrome-extension Origin from the real panel: PASS (2026-07-18, live).**
- Dave pasted a `new WebSocket('ws://127.0.0.1:8181')` probe into the LinkMap side-panel DevTools console. **No manifest edit.**
- Panel console received both frames: `{"type":"hello",...,"origin":"chrome-extension://cdapceilohcmfobgakfppmpnbnbaioen"}` then `{"type":"echo","received":"hello-from-linkmap-panel"}`.
- Server log recorded: `Origin header : chrome-extension://cdapceilohcmfobgakfppmpnbnbaioen` · `isChromeExt : true` · `Remote addr : 127.0.0.1`.
- The LinkMap extension id `cdapceilohcmfobgakfppmpnbnbaioen` is the exact value the daemon's `Origin === chrome-extension://<id>` check must pin (M9d pairing bootstrap can additionally verify).
- (MV3 note confirmed: extension-page default CSP locks `script-src`/`object-src` but not `connect-src`, so the loopback WS from the panel was allowed with zero manifest changes.)

**Verdict: PASS — the panel-owned loopback WebSocket transport works, is loopback-scoped, and Chrome sends a genuine `chrome-extension://<id>` Origin the daemon can authenticate on.** Native messaging stays rejected per the plan.

---

## Still to run (per plan table)

Spikes 4 (codex→LinkMap MCP round trip + M5 >2-min approval-latency survival), 5 (Neon suspend/reconnect with `pg`), 6 (Notion 2025-09-03 upsert), 7 (@napi-rs/keyring), 8 (tokens-per-task), 9 (page-action fidelity on 3 SPAs — M11). None started this session.
