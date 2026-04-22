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

/// Reverse index: ACP session id -> Ariadne conversation id. The notification
/// handler (which doesn't have access to the main runtime's maps without
/// deadlocking) uses this to route `SessionUpdate`s onto the right chat view.
type SessionIndex = Arc<StdMutex<HashMap<String, i64>>>;

pub struct AcpRuntime {
    connection: Mutex<Option<ConnectionTo<Agent>>>,
    sessions: Mutex<HashMap<i64, ConversationSession>>,
    session_index: SessionIndex,
}

struct ConversationSession {
    session_id: SessionId,
    /// Cancel the MCP server bound for this conversation on drop. Kept alive
    /// for the life of the runtime — the app exiting is what stops them.
    _mcp_cancel: CancellationToken,
}

impl AcpRuntime {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            connection: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            session_index: Arc::new(StdMutex::new(HashMap::new())),
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

        let api_key = resolve_api_key(&db)?;

        let agent = AcpAgent::from_args([
            format!("ANTHROPIC_API_KEY={}", api_key),
            "npx".to_string(),
            "-y".to_string(),
            "@zed-industries/claude-code-acp@latest".to_string(),
        ])
        .map_err(|e| format!("building acp agent: {}", e))?
        .with_debug(|line, direction| {
            eprintln!("[acp {:?}] {}", direction, line);
        });
        let index = self.session_index.clone();
        let app_for_handler = app.clone();

        let (conn_tx, conn_rx) = oneshot::channel::<ConnectionTo<Agent>>();

        tokio::spawn(async move {
            let result = Client
                .builder()
                .name("ariadne")
                .on_receive_notification(
                    async move |notification: SessionNotification, _cx| {
                        route_session_update(&app_for_handler, &index, notification);
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

        let connection = self.ensure_connected(app, db.clone()).await?;

        let (url, token, cancel) = spawn_mcp_server(db, scope, conversation_id).await?;

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
            .insert(session_id_to_string(&session_id), conversation_id);

        self.sessions.lock().await.insert(
            conversation_id,
            ConversationSession {
                session_id: session_id.clone(),
                _mcp_cancel: cancel,
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
            .ensure_session(app.clone(), db.clone(), conversation_id, scope)
            .await?;
        let connection = self.ensure_connected(app.clone(), db.clone()).await?;

        emit(
            &app,
            json!({"type": "turn_started", "conversation_id": conversation_id}),
        );

        let prompt = PromptRequest::new(
            session_id,
            vec![ContentBlock::Text(TextContent::new(user_text))],
        );

        let result = connection.send_request(prompt).block_task().await;

        match result {
            Ok(_resp) => {
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
    notification: SessionNotification,
) {
    let session_key = session_id_to_string(&notification.session_id);
    let conversation_id = match index.lock().unwrap().get(&session_key) {
        Some(&id) => id,
        None => return,
    };

    match notification.update {
        SessionUpdate::AgentMessageChunk(chunk) => {
            if let ContentBlock::Text(t) = chunk.content {
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
            emit(
                app,
                json!({
                    "type": "tool_call_start",
                    "conversation_id": conversation_id,
                    "tool_use_id": tc.tool_call_id.0.to_string(),
                    "name": tc.title,
                }),
            );
        }
        SessionUpdate::ToolCallUpdate(update) => {
            use agent_client_protocol::schema::ToolCallStatus;
            let status = update.fields.status;
            let done = matches!(status, Some(ToolCallStatus::Completed | ToolCallStatus::Failed));
            if !done {
                return;
            }
            let ok = matches!(status, Some(ToolCallStatus::Completed));
            let summary = update
                .fields
                .content
                .as_ref()
                .and_then(|c| c.iter().find_map(first_text_from_tool_content))
                .unwrap_or_else(|| if ok { "done".to_string() } else { "failed".to_string() });
            let input = update
                .fields
                .raw_input
                .clone()
                .unwrap_or(Value::Null);
            emit(
                app,
                json!({
                    "type": "tool_call_result",
                    "conversation_id": conversation_id,
                    "tool_use_id": update.tool_call_id.0.to_string(),
                    "name": update.fields.title.unwrap_or_default(),
                    "input": input,
                    "ok": ok,
                    "summary": summary,
                }),
            );
        }
        _ => {}
    }
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

/// Resolve the Anthropic API key. Process env wins if set; otherwise we fall
/// back to the key the user stored via Settings (same source the direct-API
/// path uses).
fn resolve_api_key(db: &Database) -> Result<String, String> {
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
        if !key.is_empty() {
            return Ok(key);
        }
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let key: Option<String> = conn
        .query_row("SELECT anthropic_api_key FROM settings WHERE id = 1", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    key.filter(|k| !k.is_empty())
        .ok_or_else(|| "No Anthropic API key — set one in Settings".to_string())
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
