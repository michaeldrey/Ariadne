//! ACP runtime: long-lived agent subprocess + per-conversation sessions.
//!
//! One `claude-code-acp` subprocess runs for the lifetime of the app,
//! wrapped in a `ConnectionTo<Agent>` kept in Tauri state. Each chat
//! conversation gets its own ACP session on first send, backed by a fresh
//! in-process HTTP MCP server scoped to that conversation's (scope,
//! conversation_id) — so tools called over ACP mutate the right role /
//! profile row.
//!
//! Events from the agent (`SessionUpdate`) are mapped onto the existing
//! `agent:event` shape consumed by [ui/views/chat.js], so the frontend
//! doesn't change.

use crate::db::Database;
use agent_client_protocol::{
    Agent, Client, ConnectionTo,
    schema::{
        ContentBlock, HttpHeader, InitializeRequest, McpServer, McpServerHttp, NewSessionRequest,
        PromptRequest, ProtocolVersion, RequestPermissionOutcome, RequestPermissionRequest,
        RequestPermissionResponse, SelectedPermissionOutcome, SessionId, SessionNotification,
        SessionUpdate, TextContent,
    },
};
use agent_client_protocol_tokio::AcpAgent;
use rusqlite::params;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, oneshot};
use tokio_util::sync::CancellationToken;

use super::mcp_server::spawn_mcp_server;
use super::tools::Scope;

const EVENT_CHANNEL: &str = "agent:event";

/// Reverse index: ACP session id -> (conversation id, scope). The
/// notification handler (which doesn't have access to the main runtime's maps
/// without deadlocking) uses this to route `SessionUpdate`s onto the right
/// chat view and to fire data-changed events with the right scope.
type SessionIndex = Arc<StdMutex<HashMap<String, (i64, Scope)>>>;

/// Ongoing tool-call state, keyed by tool_call_id. Populated on the first
/// `ToolCall` notification; merged + cleared on the terminal `ToolCallUpdate`
/// (status=Completed|Failed) so the `tool_call_result` event has the name +
/// input the update alone doesn't carry.
#[derive(Clone)]
struct ToolCallState {
    name: String,
    input: Value,
    started_emitted: bool,
}
type ToolCallIndex = Arc<StdMutex<HashMap<String, ToolCallState>>>;

pub struct AcpRuntime {
    connection: Mutex<Option<ConnectionTo<Agent>>>,
    sessions: Mutex<HashMap<i64, ConversationSession>>,
    session_index: SessionIndex,
    tool_calls: ToolCallIndex,
    /// Accumulated assistant text for the in-flight turn, keyed by
    /// conversation_id. Reset at prompt-send and drained at turn-end so the
    /// final text can be persisted to the messages table.
    turn_text: Arc<StdMutex<HashMap<i64, String>>>,
}

struct ConversationSession {
    session_id: SessionId,
    /// Cancel the MCP server bound for this conversation on drop. Kept alive
    /// for the life of the runtime — the app exiting is what stops them.
    _mcp_cancel: CancellationToken,
    /// ACP has no client-side system-prompt hook — the agent uses its own.
    /// We work around this by prepending the user's profile/role corpus to
    /// the FIRST user message of each session. Subsequent turns inherit it
    /// via the agent's own chat history. Reset when a new session is made.
    primed: bool,
}

impl AcpRuntime {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            connection: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            session_index: Arc::new(StdMutex::new(HashMap::new())),
            tool_calls: Arc::new(StdMutex::new(HashMap::new())),
            turn_text: Arc::new(StdMutex::new(HashMap::new())),
        })
    }

    /// Spawn the agent subprocess and hold its `ConnectionTo` in state if not
    /// already. Safe to call concurrently; only one connection is spawned.
    /// Forwards `ANTHROPIC_API_KEY` from the process environment into the
    /// subprocess — if not set there, we fall back to the user's settings
    /// row (same source the direct-API path uses).
    async fn ensure_connected(
        &self,
        app: AppHandle,
        db: Database,
    ) -> Result<ConnectionTo<Agent>, String> {
        let mut guard = self.connection.lock().await;
        if let Some(conn) = guard.as_ref() {
            return Ok(conn.clone());
        }

        // API key is OPTIONAL: if set, we forward it so claude-code-acp uses
        // pay-per-token via the Anthropic API. If unset, we spawn without it
        // and the subprocess uses the user's Claude Pro/Max subscription
        // credentials (stored by `claude /login` from the Claude Code CLI).
        let api_key = resolve_api_key_opt(&db);
        let auth_mode = if api_key.is_some() { "API key" } else { "Claude Pro/Max subscription" };
        eprintln!("[acp] auth: {}", auth_mode);

        // Prefer a globally-installed binary over `npx -y @latest` — npx
        // checks the npm registry every launch (adds ~1–30s). If the user
        // hasn't run the install wizard we fall back to npx so the app
        // still works out of the box.
        let mut args: Vec<String> = vec![];
        if let Some(key) = &api_key {
            args.push(format!("ANTHROPIC_API_KEY={}", key));
        }
        match super::install::detect_acp_install().await.ok() {
            Some(status) if status.installed && status.path.is_some() => {
                eprintln!(
                    "[acp] using installed binary {} (v{})",
                    status.path.as_deref().unwrap_or("?"),
                    status.version.as_deref().unwrap_or("?")
                );
                args.push(status.path.clone().unwrap());
            }
            _ => {
                eprintln!("[acp] claude-code-acp not installed globally — falling back to npx (slower cold starts)");
                args.push("npx".to_string());
                args.push("-y".to_string());
                args.push("@zed-industries/claude-code-acp@latest".to_string());
            }
        }

        let agent = AcpAgent::from_args(args)
            .map_err(|e| format!("building acp agent: {}", e))?
            .with_debug(|line, direction| {
                eprintln!("[acp {:?}] {}", direction, line);
            });
        let index = self.session_index.clone();
        let tool_calls = self.tool_calls.clone();
        let turn_text = self.turn_text.clone();
        let app_for_handler = app.clone();

        let (conn_tx, conn_rx) = oneshot::channel::<ConnectionTo<Agent>>();

        tokio::spawn(async move {
            let result = Client
                .builder()
                .name("ariadne")
                .on_receive_notification(
                    async move |notification: SessionNotification, _cx| {
                        route_session_update(
                            &app_for_handler,
                            &index,
                            &tool_calls,
                            &turn_text,
                            notification,
                        );
                        Ok(())
                    },
                    agent_client_protocol::on_receive_notification!(),
                )
                .on_receive_request(
                    async move |req: RequestPermissionRequest, responder, _cx| {
                        // Auto-approve by selecting the first option. For
                        // Ariadne's local tools this is safe — the user owns
                        // both sides of the chat.
                        let option_id = req.options.first().map(|o| o.option_id.clone());
                        if let Some(id) = option_id {
                            responder.respond(RequestPermissionResponse::new(
                                RequestPermissionOutcome::Selected(
                                    SelectedPermissionOutcome::new(id),
                                ),
                            ))
                        } else {
                            responder.respond(RequestPermissionResponse::new(
                                RequestPermissionOutcome::Cancelled,
                            ))
                        }
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .connect_with(agent, async move |connection| {
                    let init = connection
                        .send_request(InitializeRequest::new(ProtocolVersion::V1))
                        .block_task()
                        .await?;
                    eprintln!(
                        "[acp] initialized agent: {:?} v{:?}",
                        init.agent_info, init.protocol_version
                    );
                    let _ = conn_tx.send(connection.clone());
                    // Park forever — the subprocess lives while we do.
                    std::future::pending::<()>().await;
                    Ok(())
                })
                .await;
            if let Err(e) = result {
                eprintln!("[acp] connection exited: {}", e);
            }
        });

        let conn = conn_rx
            .await
            .map_err(|_| "ACP agent failed to initialize".to_string())?;
        *guard = Some(conn.clone());
        Ok(conn)
    }

    /// Create an ACP session for this conversation if one doesn't exist.
    /// Spawns a fresh MCP server scoped to the conversation.
    async fn ensure_session(
        &self,
        app: AppHandle,
        db: Database,
        conversation_id: i64,
        scope: Scope,
    ) -> Result<SessionId, String> {
        {
            let sessions = self.sessions.lock().await;
            if let Some(s) = sessions.get(&conversation_id) {
                return Ok(s.session_id.clone());
            }
        }

        let connection = self.ensure_connected(app.clone(), db.clone()).await?;

        let scope_for_index = scope.clone();
        let (url, token, cancel) = spawn_mcp_server(db, scope, conversation_id, app).await?;

        let cwd = std::env::current_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("/"));
        let mcp = McpServer::Http(
            McpServerHttp::new("ariadne-tools", url).headers(vec![HttpHeader::new(
                "Authorization",
                format!("Bearer {}", token),
            )]),
        );

        let resp = connection
            .send_request(NewSessionRequest::new(cwd).mcp_servers(vec![mcp]))
            .block_task()
            .await
            .map_err(|e| format!("new session failed: {}", e))?;

        let session_id = resp.session_id;

        self.session_index
            .lock()
            .unwrap()
            .insert(session_id_to_string(&session_id), (conversation_id, scope_for_index));

        self.sessions.lock().await.insert(
            conversation_id,
            ConversationSession {
                session_id: session_id.clone(),
                _mcp_cancel: cancel,
                primed: false,
            },
        );

        Ok(session_id)
    }

    /// Send a user prompt on this conversation's ACP session. Streams back
    /// `agent:event` events to the frontend and persists the user message +
    /// the final assistant text.
    pub async fn send_prompt(
        self: &Arc<Self>,
        app: AppHandle,
        db: Database,
        conversation_id: i64,
        scope: Scope,
        user_text: String,
    ) -> Result<(), String> {
        // Persist user message + emit user_message_saved (mirrors the direct path).
        {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            let content = json!([{"type": "text", "text": user_text}]);
            conn.execute(
                "INSERT INTO messages (conversation_id, role, content) VALUES (?1, 'user', ?2)",
                params![conversation_id, content.to_string()],
            )
            .map_err(|e| e.to_string())?;
            let id = conn.last_insert_rowid();
            emit(
                &app,
                json!({
                    "type": "user_message_saved",
                    "conversation_id": conversation_id,
                    "message_id": id,
                    "content": content,
                }),
            );
        }

        let session_id = self
            .ensure_session(app.clone(), db.clone(), conversation_id, scope.clone())
            .await?;
        let connection = self.ensure_connected(app.clone(), db.clone()).await?;

        // On the first turn of a fresh ACP session, prepend the user's
        // profile / role context as a preamble. ACP provides no client
        // system-prompt hook, so this is how the agent learns about the
        // user's resume, stories, search criteria, etc.
        let is_first_turn = {
            let mut sessions = self.sessions.lock().await;
            if let Some(s) = sessions.get_mut(&conversation_id) {
                let first = !s.primed;
                s.primed = true;
                first
            } else {
                false
            }
        };
        let effective_user_text = if is_first_turn {
            let preamble = build_context_preamble(&db, &scope).unwrap_or_default();
            if preamble.is_empty() {
                user_text.clone()
            } else {
                format!("{}\n\n---\n\n{}", preamble, user_text)
            }
        } else {
            user_text.clone()
        };

        // Fresh accumulator for this turn so notification handlers collect
        // only this turn's text (not leftover from a prior one).
        self.turn_text
            .lock()
            .unwrap()
            .insert(conversation_id, String::new());

        emit(
            &app,
            json!({"type": "turn_started", "conversation_id": conversation_id}),
        );

        let prompt = PromptRequest::new(
            session_id,
            vec![ContentBlock::Text(TextContent::new(effective_user_text))],
        );

        let result = connection.send_request(prompt).block_task().await;

        // Drain whatever text the notification handler accumulated this turn.
        let accumulated = self
            .turn_text
            .lock()
            .unwrap()
            .remove(&conversation_id)
            .unwrap_or_default();

        match result {
            Ok(_resp) => {
                if !accumulated.is_empty() {
                    let content = json!([{"type": "text", "text": accumulated}]);
                    let saved: rusqlite::Result<i64> = (|| {
                        let conn = db.0.lock().map_err(|e| {
                            rusqlite::Error::InvalidPath(e.to_string().into())
                        })?;
                        conn.execute(
                            "INSERT INTO messages (conversation_id, role, content) VALUES (?1, 'assistant', ?2)",
                            params![conversation_id, content.to_string()],
                        )?;
                        Ok(conn.last_insert_rowid())
                    })();
                    if let Ok(id) = saved {
                        emit(
                            &app,
                            json!({
                                "type": "assistant_message_saved",
                                "conversation_id": conversation_id,
                                "message_id": id,
                                "content": content,
                            }),
                        );
                    }
                }
                emit(
                    &app,
                    json!({"type": "turn_done", "conversation_id": conversation_id}),
                );
                Ok(())
            }
            Err(e) => {
                let msg = format!("acp prompt failed: {}", e);
                emit(
                    &app,
                    json!({
                        "type": "error",
                        "conversation_id": conversation_id,
                        "message": msg.clone(),
                    }),
                );
                Err(msg)
            }
        }
    }
}

/// Turn a `SessionNotification` into the `agent:event` shape consumed by
/// [ui/views/chat.js]. Silently drops updates we don't render yet (plan,
/// modes, etc.).
fn route_session_update(
    app: &AppHandle,
    index: &SessionIndex,
    tool_calls: &ToolCallIndex,
    turn_text: &Arc<StdMutex<HashMap<i64, String>>>,
    notification: SessionNotification,
) {
    let session_key = session_id_to_string(&notification.session_id);
    let (conversation_id, scope) = match index.lock().unwrap().get(&session_key) {
        Some((id, s)) => (*id, s.clone()),
        None => return,
    };

    match notification.update {
        SessionUpdate::AgentMessageChunk(chunk) => {
            if let ContentBlock::Text(t) = chunk.content {
                turn_text
                    .lock()
                    .unwrap()
                    .entry(conversation_id)
                    .or_default()
                    .push_str(&t.text);
                emit(
                    app,
                    json!({
                        "type": "text_delta",
                        "conversation_id": conversation_id,
                        "text": t.text,
                    }),
                );
            }
        }
        SessionUpdate::ToolCall(tc) => {
            // The agent may emit the same ToolCall twice — once with empty
            // rawInput, once with the populated args. Dedupe `tool_call_start`
            // by id, but keep updating the cached input on each emission.
            let id = tc.tool_call_id.0.to_string();
            let display_name = strip_mcp_prefix(&tc.title);
            let input = tc.raw_input.clone().unwrap_or(Value::Null);

            let should_emit_start = {
                let mut map = tool_calls.lock().unwrap();
                let entry = map.entry(id.clone()).or_insert_with(|| ToolCallState {
                    name: display_name.clone(),
                    input: Value::Null,
                    started_emitted: false,
                });
                entry.name = display_name.clone();
                entry.input = input.clone();
                let first = !entry.started_emitted;
                entry.started_emitted = true;
                first
            };

            if should_emit_start {
                emit(
                    app,
                    json!({
                        "type": "tool_call_start",
                        "conversation_id": conversation_id,
                        "tool_use_id": id,
                        "name": display_name,
                    }),
                );
            }
        }
        SessionUpdate::ToolCallUpdate(update) => {
            use agent_client_protocol::schema::ToolCallStatus;
            let status = update.fields.status;
            let done = matches!(status, Some(ToolCallStatus::Completed | ToolCallStatus::Failed));
            if !done {
                return;
            }
            let ok = matches!(status, Some(ToolCallStatus::Completed));
            let id = update.tool_call_id.0.to_string();

            let (cached_name, cached_input) = {
                let mut map = tool_calls.lock().unwrap();
                match map.remove(&id) {
                    Some(s) => (s.name, s.input),
                    None => (String::new(), Value::Null),
                }
            };

            let summary = update
                .fields
                .content
                .as_ref()
                .and_then(|c| c.iter().find_map(first_text_from_tool_content))
                .unwrap_or_else(|| if ok { "done".to_string() } else { "failed".to_string() });
            let name = update
                .fields
                .title
                .map(|t| strip_mcp_prefix(&t))
                .filter(|s| !s.is_empty())
                .unwrap_or(cached_name);
            let input = update
                .fields
                .raw_input
                .clone()
                .unwrap_or(cached_input);

            emit(
                app,
                json!({
                    "type": "tool_call_result",
                    "conversation_id": conversation_id,
                    "tool_use_id": id,
                    "name": name,
                    "input": input,
                    "ok": ok,
                    "summary": summary,
                }),
            );

            if ok {
                let (label, role_id) = match &scope {
                    Scope::Role(id) => ("role", Some(id.as_str())),
                    Scope::Profile => ("profile", None),
                };
                emit_data_changed(app, label, role_id, &name);
            }
        }
        SessionUpdate::UsageUpdate(usage) => {
            // Log context-window usage + any cache info the adapter surfaces
            // via _meta. Helps verify prompt caching survives the ACP layer
            // (direct-API path had cache hits on the stable prefix — we
            // want to confirm the same end-state here).
            let meta = usage
                .meta
                .as_ref()
                .map(|m| serde_json::to_string(m).unwrap_or_default())
                .unwrap_or_default();
            eprintln!(
                "[acp usage] conv={} used={} size={} cost={:?} meta={}",
                conversation_id, usage.used, usage.size, usage.cost, meta
            );
        }
        _ => {}
    }
}

/// Fire `data:changed` so open views (role detail, profile, tasks list) can
/// re-fetch after a tool mutated their data. Scoped to the conversation's
/// scope + the role_id (if role-scoped) so views don't over-refresh.
/// Takes stringly-typed args so both the ACP path and the direct-API path
/// can call this without sharing a `Scope` enum (the two paths have
/// structurally-identical but distinct `Scope` types).
pub fn emit_data_changed(
    app: &AppHandle,
    scope_label: &str,
    role_id: Option<&str>,
    tool_name: &str,
) {
    let _ = app.emit(
        "data:changed",
        json!({
            "scope": scope_label,
            "role_id": role_id,
            "tool": tool_name,
        }),
    );
}

/// Strip the `mcp__<server>__` prefix claude-code-acp prepends to tool names
/// so the UI bubble says `update_stage` instead of
/// `mcp__ariadne-tools__update_stage`.
fn strip_mcp_prefix(name: &str) -> String {
    if let Some(rest) = name.strip_prefix("mcp__") {
        if let Some((_server, tool)) = rest.split_once("__") {
            return tool.to_string();
        }
    }
    name.to_string()
}

fn first_text_from_tool_content(
    content: &agent_client_protocol::schema::ToolCallContent,
) -> Option<String> {
    use agent_client_protocol::schema::ToolCallContent;
    match content {
        ToolCallContent::Content(c) => match &c.content {
            ContentBlock::Text(t) => Some(t.text.clone()),
            _ => None,
        },
        _ => None,
    }
}

fn session_id_to_string(id: &SessionId) -> String {
    id.0.to_string()
}

/// Build a preamble injected into the first user message of a new ACP
/// session so the agent learns about the user's profile/role context.
/// Returns empty string on any DB error — the chat still works, just
/// without context, which is preferable to hard-failing the send.
fn build_context_preamble(db: &Database, scope: &Scope) -> Option<String> {
    let conn = db.0.lock().ok()?;

    let (resume, stories, name, about, criteria): (
        Option<String>, Option<String>, Option<String>, Option<String>, Option<String>,
    ) = conn.query_row(
        "SELECT resume_content, work_stories, profile_name, profile_json, search_criteria
         FROM settings WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    ).ok()?;

    let mut parts = Vec::new();
    parts.push("This message is Ariadne context from the user's local app. Use it to ground your responses. The user has NOT typed this part — the app attaches it on the first turn of each session. Subsequent turns don't repeat it; rely on chat history.".to_string());

    if let Some(n) = name.filter(|s| !s.trim().is_empty()) {
        parts.push(format!("## About the user\nName: {}", n.trim()));
    }
    if let Some(a) = about.filter(|s| !s.trim().is_empty()) {
        parts.push(format!("## Profile\n{}", a.trim()));
    }
    if let Some(r) = resume.filter(|s| !s.trim().is_empty()) {
        parts.push(format!("## Master Resume\n{}", r.trim()));
    }
    if let Some(s) = stories.filter(|s| !s.trim().is_empty()) {
        parts.push(format!("## Work Stories (STAR)\n{}", s.trim()));
    }
    if let Some(c) = criteria.filter(|s| !s.trim().is_empty()) {
        parts.push(format!("## Search Criteria\n{}", c.trim()));
    }

    if let Scope::Role(role_id) = scope {
        let row: rusqlite::Result<(String, String, String, Option<String>, Option<String>, Option<String>, Option<i32>)> = conn.query_row(
            "SELECT company, title, stage, jd_content, notes, next_action, fit_score
             FROM roles WHERE id = ?1",
            params![role_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        );
        if let Ok((company, title, stage, jd, notes, next_action, fit)) = row {
            let mut role_section = format!(
                "## This Role\nCompany: {}\nTitle: {}\nStage: {}",
                company, title, stage,
            );
            if let Some(f) = fit {
                role_section.push_str(&format!("\nFit Score: {}", f));
            }
            if let Some(n) = next_action.filter(|s| !s.trim().is_empty()) {
                role_section.push_str(&format!("\nNext Action: {}", n.trim()));
            }
            if let Some(n) = notes.filter(|s| !s.trim().is_empty()) {
                role_section.push_str(&format!("\n\n### Notes\n{}", n.trim()));
            }
            if let Some(j) = jd.filter(|s| !s.trim().is_empty()) {
                role_section.push_str(&format!("\n\n### Job Description\n{}", j.trim()));
            }
            parts.push(role_section);
        }
    }

    if parts.len() <= 1 {
        return None; // Only the header — nothing useful to say.
    }
    Some(parts.join("\n\n"))
}

/// Resolve the Anthropic API key if the user has one. Returns None to signal
/// "use subscription auth" — we spawn claude-code-acp without
/// ANTHROPIC_API_KEY and it uses Claude Pro/Max credentials from the
/// Claude Code CLI login instead. Process env wins if set.
fn resolve_api_key_opt(db: &Database) -> Option<String> {
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
        if !key.is_empty() {
            return Some(key);
        }
    }
    let conn = db.0.lock().ok()?;
    let key: Option<String> = conn
        .query_row("SELECT anthropic_api_key FROM settings WHERE id = 1", [], |r| r.get(0))
        .ok()?;
    key.filter(|k| !k.is_empty())
}

fn emit(app: &AppHandle, payload: Value) {
    let _ = app.emit(EVENT_CHANNEL, payload);
}

#[tauri::command]
pub async fn send_to_conversation_acp(
    db: tauri::State<'_, Database>,
    runtime: tauri::State<'_, Arc<AcpRuntime>>,
    app: AppHandle,
    conversation_id: i64,
    user_text: String,
) -> Result<(), String> {
    let scope = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let (scope_type, role_id): (String, Option<String>) = conn
            .query_row(
                "SELECT scope_type, role_id FROM conversations WHERE id = ?1",
                params![conversation_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        match scope_type.as_str() {
            "role" => Scope::Role(role_id.ok_or("Role conversation has no role_id")?),
            "profile" => Scope::Profile,
            other => return Err(format!("Unknown scope_type: {}", other)),
        }
    };

    let runtime = (*runtime).clone();
    let db = (*db).clone();
    runtime
        .send_prompt(app, db, conversation_id, scope, user_text)
        .await
}
