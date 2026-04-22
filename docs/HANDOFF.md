# Session handoff — 2026-04-21

Quick ramp-up for the next working session.

## Where we are

**Current branch:** `master` (pushed to `https://github.com/michaeldrey/Ariadne`)

**Commits landed this session** (newest first):

```
bdac2ed  ACP step 2 (partial): rmcp tool scaffold + 2 template tools
45e59a5  ACP step 1: design doc + crate deps + stub module
588c1ba  Multi-chat: N threads per scope with picker in drawer
1efd40d  Profile page + profile-scoped chat; streaming fixes; prompt caching
58509a9  Import Ariadne2 profile files; stage-sort by pipeline progress
9a60562  Add per-role agent chat, back/forward nav, role-folder import
7d83396  Initial commit: Tauri v2 desktop app for job-search tracking
```

**App state:** works end-to-end on the direct-Anthropic path. Chat (role + profile scopes), multi-thread per scope, tool calls, streaming, artifact versioning. Sonnet 4.6 with prompt caching on the stable prefix.

**Database schema:** at v5.
- settings (with `search_criteria` column)
- roles / tasks / contacts / interactions
- conversations (scope_type, nullable role_id, no UNIQUE constraints)
- messages (JSON content blocks)
- artifacts (versioned, FK to role + conversation + message)

## What's in-flight

**ACP migration** — following [ACP-MIGRATION.md](./ACP-MIGRATION.md). Steps 1 + 2 (partial) done. Step 2 needs the remaining 7 tools. Steps 3–6 untouched.

### Step 2 remaining work

File: [src-tauri/src/commands/acp/tools.rs](../src-tauri/src/commands/acp/tools.rs)

Port these 7 tools, each following the same pattern as `update_stage` and `save_work_stories` already there:

**Role tools** (check via `self.require_role()?`):
- `update_notes(notes: String)` → `UPDATE roles SET notes=?1 WHERE id=?2`
- `update_next_action(next_action: String)` → `UPDATE roles SET next_action=?1 WHERE id=?2`
- `update_fit_score(fit_score: i32)` → validate `0..=100`, `UPDATE roles SET fit_score=?1`
- `save_artifact(kind: String, content: String)` → `INSERT INTO artifacts (role_id, kind, content, conversation_id) VALUES ...`. `kind` ∈ `resume | analysis | research | outreach`
- `create_task(content: String, due_date: Option<String>)` → `INSERT INTO tasks (id, content, due_date, role_id) VALUES (nanoid, ?1, ?2, role_id)`

**Profile tools** (check via `self.require_profile()?`):
- `update_search_criteria(content: String)` → `UPDATE settings SET search_criteria=?1 WHERE id=1`
- `update_profile_about(content: String)` → `UPDATE settings SET profile_json=?1 WHERE id=1`

Each is ~30 LOC. The existing template code in `tools.rs` shows the exact `spawn_blocking` / `Parameters<T>` / `CallToolResult::success` shape.

### Steps 3–6

See [ACP-MIGRATION.md](./ACP-MIGRATION.md) "Migration plan" section. High level:

- **Step 3:** spawn `claude-agent-acp` subprocess + first-run install-detection UI. New module `commands/acp/client.rs`. Must bind an HTTP MCP server on `127.0.0.1:<random>` with a per-run bearer token and pass its URL as `NewSessionRequest.mcp_servers`.
- **Step 4:** `run_turn_for_conversation_acp()` parallel to the direct-API `run_turn_for_conversation`. Event mapping from `SessionUpdate::*` to `agent:event`. Behind env flag or setting at first.
- **Step 5:** Settings UI: backend dropdown (direct / ACP claude / custom command). Settings table gets `agent_backend TEXT DEFAULT 'direct'` column.
- **Step 6:** Log cache hits from `unstable_session_usage` notifications to verify caching works through the adapter.
- **Step 7 (later):** delete direct-API path after 2 weeks of dogfooding on ACP.

## Critical facts to carry forward

1. **`Client.builder()` has NO `.with_mcp_server()`.** "Only applicable to proxies" per `src/jsonrpc.rs`. Our path: HTTP MCP server in-process, URL passed via `NewSessionRequest.mcp_servers`. See ACP-MIGRATION.md day-one-uncertainty section.

2. **Database is now `Arc<Mutex<Connection>>` (cloneable).** Don't construct `Database(Mutex::new(conn))` — use `Database(Arc::new(Mutex::new(conn)))`. Existing `db.0.lock()` callers are unchanged.

3. **Tauri v2 permissions.** Anything calling `window.__TAURI__.event.listen/emit` needs `core:event:*` permissions in `src-tauri/capabilities/default.json`. Already there for the event channel — if you add new channels or new plugins (shell, dialog, fs), their permissions must be added too.

4. **Model in use:** `claude-sonnet-4-6`. Prompt caching: `cache_control: {type: "ephemeral"}` on the stable prefix of the system prompt (user corpus + guidelines). Split logic is in `commands/agent.rs` → `build_role_system_prompt` / `build_profile_system_prompt`.

5. **Data import:** role folders + profile files all live under `~/Development/Ariadne2/Ariadne/data`. Re-run Settings → Import from Ariadne2 if needed; dedups by content.

6. **Committer identity:** local config on this repo is `Mike Dreyfus <michaeldrey825@gmail.com>`. Global git config is untouched so other repos use their own settings.

## Running it

```sh
cd ~/Development/ariadne-app
source "$HOME/.cargo/env"
cargo tauri dev
```

First-run data locations:
- SQLite DB: `~/Library/Application Support/com.ariadne.app/ariadne.db`
- No API key needed just to launch; Chat features fail gracefully with "Add your API key in Settings" until one is set.

## What's explicitly NOT done

- Steps 3–6 of ACP migration (see above).
- Remaining 7 rmcp tools in step 2.
- The 3 pre-existing dead-code warnings on unused `TrackerEntry.folder` / `TrackerClosed.folder` / `TaskEntry.linked_contacts|linked_jobs` import fields — harmless.
- Icon generation (`cargo tauri icon`) — still using placeholder blue squares from an early session.
- Rename of `master` → `main` — left as `master` for now.
- Dependabot alerts on the repo (surfaced at last push; not investigated).

## Files to read first in a new session

- [docs/ACP-MIGRATION.md](./ACP-MIGRATION.md) — the design doc.
- [src-tauri/src/commands/acp/tools.rs](../src-tauri/src/commands/acp/tools.rs) — the current WIP. Scaffold + 2 tools as templates.
- [src-tauri/src/commands/agent.rs](../src-tauri/src/commands/agent.rs) — the direct-API path. Source of truth for the remaining 7 tool implementations to port (see `run_role_tool` and `run_profile_tool`).
- [ui/views/chat.js](../ui/views/chat.js) — frontend event consumer. Won't need to change during ACP migration.
