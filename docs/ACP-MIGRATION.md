# ACP Migration Design

Migrating Ariadne from direct Anthropic Messages API calls to **Zed's Agent Client Protocol** (ACP). The Rust app becomes an ACP client; agents run as subprocesses.

**Why:** multi-vendor pluggability (Claude / Gemini / GPT / custom), optional Claude Pro/Max subscription auth (no API-key requirement for Claude users), cleaner separation between "agent harness" and "agent runtime," alignment with a protocol Zed and others are actively investing in.

**Estimate:** 5–7 days of focused work for steps 1–6, then 2 weeks of dogfooding before deleting the direct-API path (step 7).

---

## Agent choice

Default agent: **`@agentclientprotocol/claude-agent-acp`** (npm, Apache-2.0, ~15 MB installed).

- Actively maintained by the `agentclientprotocol` GitHub org (Zed-led) — 13 releases in the 6 weeks preceding this decision.
- Wraps `@anthropic-ai/claude-agent-sdk` which wraps Anthropic's Messages API.
- **Two auth modes**, selectable via ACP's `authenticate` method:
  - `claude-ai-login` — Claude Pro/Max subscription (no API key needed).
  - `console-login` — Anthropic API key from console.anthropic.com.
- Preserves Anthropic prompt caching internally (delete our hand-rolled cache-split logic).

### Alternative agents (user-installable, no extra Rust code needed)

| Agent | Model backend | Install | Auth |
|---|---|---|---|
| `claude-agent-acp` (default) | Claude via Anthropic API or Claude.ai | `npm i -g @agentclientprotocol/claude-agent-acp` | Subscription or API key |
| Gemini CLI (`--experimental-acp`) | Gemini | `npm i -g @google/gemini-cli` | Google API key |
| Codex CLI in ACP mode | OpenAI | via OpenAI CLI release | OpenAI API key |
| Kiro / Cline / Cursor Agent | coding-focused; not our primary use | various | various |
| Custom | any model | write a tiny ACP shim (Rust / TS / Python SDKs available) | whatever |

Settings UI will expose a **backend dropdown** (default: Claude) + a **custom command** field for advanced users.

### What's lost when going cross-vendor

- **Prompt caching** is Anthropic-specific. Non-Claude users pay full-context cost every turn.
- **Tool-use quality** depends on the model. Frontier-class (Claude Sonnet/Opus, GPT-4, Gemini Pro) handle multi-step tool loops fine. Smaller models struggle.
- **System-prompt tuning.** Our prompts are written for Claude. Behavior drifts on other models.
- **Day-1 Anthropic features** land for Claude adapter first (24–72h lag typical).

---

## Architecture

```
┌─────────────────────────────────┐         ┌──────────────────────────────┐
│ Ariadne (Tauri + Rust + JS)     │         │ claude-agent-acp (Node)      │
│                                 │  stdio  │                              │
│  ┌────────────────────────┐     │  JSON-  │  ┌────────────────────────┐  │
│  │ Frontend (chat.js)     │     │  RPC    │  │ Claude Agent SDK       │  │
│  │  agent:event listener  │     │         │  │  (Anthropic API calls) │  │
│  └──────────┬─────────────┘     │         │  └────────────────────────┘  │
│             │ Tauri IPC         │         │                              │
│  ┌──────────▼─────────────┐     │         │                              │
│  │ ACP client (Rust)      │◄────┼─────────┼──                            │
│  │  - session/prompt      │     │         │                              │
│  │  - session/update      │     │         │                              │
│  │  - embedded MCP server │     │         │                              │
│  │    exposes our tools   │     │         │                              │
│  └────────────────────────┘     │         │                              │
│         │                       │         │                              │
│  ┌──────▼──────────────────┐   │         │                              │
│  │ SQLite (rusqlite)       │   │         │                              │
│  │  conversations/messages │   │         │                              │
│  └─────────────────────────┘   │         │                              │
└─────────────────────────────────┘         └──────────────────────────────┘
```

Key decisions:

- **Subprocess lifecycle:** one `claude-agent-acp` per Tauri app instance, spawned on first chat message, killed on app quit. Multiplex N ACP sessions over the single subprocess.
- **Session model:** one ACP session per open conversation view. SQLite remains source of truth. On reopening a conversation, replay history as a single preamble `PromptRequest` with historical turns serialized as text — the adapter's 5-minute prompt cache absorbs the cost.
- **Tool exposure:** in-process MCP server via `rmcp` + `agent-client-protocol-rmcp`. The agent calls our tools via MCP; we keep the existing `run_tool` logic, just annotate with `#[tool]` macros.

---

## Event mapping

| Today (`agent:event`) | ACP equivalent |
|---|---|
| `text_start` | First `SessionUpdate::AgentMessageChunk` of a turn |
| `text_delta { text }` | Subsequent `SessionUpdate::AgentMessageChunk` |
| `tool_call_start` | `SessionUpdate::ToolCall` with `status: Pending` |
| `tool_call_result` | `SessionUpdate::ToolCallUpdate` with `status: Completed`/`Failed` |
| `turn_started` | Local synthetic — fire on `session/prompt` dispatch |
| `turn_done` | `PromptResponse::stop_reason` returned by the request future |
| `error` | JSON-RPC error OR `StopReason::Refusal` |
| `user_message_saved` / `assistant_message_saved` | Still local — persistence happens in Rust around the call |

Net effect for frontend: **zero changes.** chat.js consumes the same event vocabulary.

---

## Session + persistence

- **One ACP session = one open conversation view.** Created via `session/new`, scoped to our `conversations.id`.
- **Multi-turn within a session.** Subsequent `session/prompt` calls on the same `session_id` extend the conversation inside the agent.
- **Restart / reopen.** SQLite has full history. On reopening a conversation, concatenate historical messages into a single preamble `PromptRequest` (as one big `ContentBlock::Text` starting with "## Conversation history"), then live turns use the same session. Lossy for tool-result rendering inside the preamble but acceptable — it's only for the agent's context, not for UI display.
- **ACP-native resume** (`session/resume`) exists but is gated behind `unstable_session_resume`. Don't rely on it; re-send history.

---

## Bundling strategy

**Auto-install on first run with user consent. Fall back to bundled Node only if needed.**

- App startup: check for `claude-agent-acp` on PATH and in `~/.ariadne/bin/`.
- On first chat if missing: modal dialog — "Ariadne needs the Claude Agent (v0.30+, ~15 MB). Install now?" On yes, shell out to `npm i -g @agentclientprotocol/claude-agent-acp`.
- On `npm`-missing: show dialog pointing to nodejs.org.
- Don't bundle Node in our Tauri package — would blow installer from ~10 MB to ~60 MB.

This matches how Zed itself distributes ACP agents.

---

## Migration plan (7 commits)

| # | Step | ~LOC | Risk | Reversible |
|---|---|---|---|---|
| 1 | Add crate deps (`agent-client-protocol`, `-tokio`, `-rmcp`, `rmcp`, `schemars`), stub `commands/acp/` module | +10 | compile-time only | ✓ |
| 2 | Port 9 tools to `rmcp` `#[tool]` macros, wrapping existing `run_role_tool` / `run_profile_tool`. Keep old code alive. | +350 | DB deadlock via std::sync::Mutex in async — wrap with `spawn_blocking` | ✓ |
| 3 | Subprocess spawn + first-run install detection via `tauri-plugin-shell` | +120 | orphan process on crash — register Drop kill | ✓ |
| 4 | Parallel `run_turn_for_conversation_acp` alongside existing, wired via MCP, feature-flagged off | +220 | event mapping mismatch — add compat layer preserving existing event names | ✓ |
| 5 | Settings: `agent_backend TEXT DEFAULT 'direct'`; `send_to_conversation` dispatches | +40 | wrong branch — test both paths | ✓ |
| 6 | Cache-hit logging (`cache_read_input_tokens` via `unstable_session_usage`) | +20 | `unstable_*` feature flag may move | ✓ |
| 7 | Delete direct-API path (`consume_stream`, `tool_definitions`, `run_tool`, cache split) | −450 | regresses users on `agent_backend='direct'`. Gate on 2 weeks dogfood | via git |

---

## What we lose

- **Prompt-cache control granularity.** We hand off to the adapter's policy. Net equal-or-better in practice.
- **~50–150 ms per-app-launch latency** (subprocess spawn). Imperceptible during turns.
- **Anthropic-specific stop reasons.** Map `stop_sequence → EndTurn`; gain `MaxTurnRequests` and `Refusal`.
- **Day-1 Anthropic features** (typical 24–72h adapter lag).
- **Debug surface doubled.** Bug could be in our Rust OR the Node adapter. Mitigation: `.with_debug()` hook logs raw JSON-RPC; Zed ships an ACP trace viewer crate.
- **~160 LOC of SSE parser** deleted — small emotional cost, real maintenance win.

---

## Day-one uncertainty — RESOLVED

Question was: can `Client.builder()` register an in-process MCP server via `.with_mcp_server()`?

**Answer: no.** Quoting `src/agent-client-protocol/src/jsonrpc.rs`: *"Only applicable to proxies."* The Client role must advertise MCP servers via `NewSessionRequest.mcp_servers`, meaning a separate transport — either:

- **Subprocess (stdio MCP):** spawn a second binary running our tools. Ugly for a single-binary Tauri app.
- **In-process HTTP MCP server** bound to `127.0.0.1:<random>`: we run an `rmcp`-backed HTTP server inside our Rust process, pass the URL to the agent at `session/new`. **This is the chosen path.**

Requirements on the agent: must support `type: "http"` MCP servers. `claude-agent-acp` does (per the adapter's capability advertisement; verify on first integration test).

Security: bind to loopback only; generate a per-run session token, include as bearer header on all MCP requests, verify on the server side. Mitigates the case where another local process on the user's machine tries to hit our MCP endpoint.

---

## Reference files

- Our current agent module: [src-tauri/src/commands/agent.rs](../src-tauri/src/commands/agent.rs)
- rust-sdk reference client: [`agentclientprotocol/rust-sdk/examples/yolo_one_shot_client.rs`](https://github.com/agentclientprotocol/rust-sdk/blob/main/src/agent-client-protocol/examples/yolo_one_shot_client.rs)
- rust-sdk MCP integration: [`agentclientprotocol/rust-sdk/src/agent-client-protocol-rmcp/examples/with_mcp_server.rs`](https://github.com/agentclientprotocol/rust-sdk/tree/main/src/agent-client-protocol-rmcp)
- claude-agent-acp adapter: [`agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp)
- ACP spec: [agentclientprotocol.com](https://agentclientprotocol.com)
