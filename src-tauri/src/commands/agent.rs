use crate::db::Database;
use crate::models::*;
use futures_util::StreamExt;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

const CLAUDE_MODEL: &str = "claude-sonnet-4-6";
const API_URL: &str = "https://api.anthropic.com/v1/messages";
const MAX_TOOL_ITERATIONS: usize = 8;
const EVENT_CHANNEL: &str = "agent:event";

// A conversation is scoped to one Role or to the Profile (user-wide).
#[derive(Debug, Clone)]
enum Scope {
    Role(String),
    Profile,
}

impl Scope {
    fn type_str(&self) -> &'static str {
        match self {
            Scope::Role(_) => "role",
            Scope::Profile => "profile",
        }
    }
}

// ── Commands ──

#[tauri::command]
pub fn get_or_create_conversation(
    db: State<'_, Database>,
    role_id: String,
) -> Result<Conversation, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    most_recent_or_create_role_conversation(&conn, &role_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_or_create_profile_conversation(
    db: State<'_, Database>,
) -> Result<Conversation, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    most_recent_or_create_profile_conversation(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_conversations(
    db: State<'_, Database>,
    scope_type: String,
    role_id: Option<String>,
) -> Result<Vec<Conversation>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let (sql, rows): (&str, rusqlite::Result<Vec<Conversation>>) = match scope_type.as_str() {
        "role" => {
            let role_id = role_id.ok_or("role_id required for scope_type='role'")?;
            let sql = "SELECT id, scope_type, role_id, title, created_at, updated_at
                       FROM conversations WHERE scope_type = 'role' AND role_id = ?1
                       ORDER BY updated_at DESC, id DESC";
            let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![role_id], row_to_conversation)
                .map_err(|e| e.to_string())?
                .collect();
            (sql, rows)
        }
        "profile" => {
            let sql = "SELECT id, scope_type, role_id, title, created_at, updated_at
                       FROM conversations WHERE scope_type = 'profile'
                       ORDER BY updated_at DESC, id DESC";
            let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], row_to_conversation)
                .map_err(|e| e.to_string())?
                .collect();
            (sql, rows)
        }
        other => return Err(format!("Unknown scope_type: {}", other)),
    };

    let _ = sql;
    rows.map_err(|e| e.to_string())
}

/// Most recently updated conversations across all scopes, for the dashboard's
/// "Recent Chats" band. Joins to roles so the caller can render something
/// like "Role: Acme — Staff SWE" without a second round-trip.
#[tauri::command]
pub fn list_recent_conversations(
    db: State<'_, Database>,
    limit: Option<i64>,
) -> Result<Vec<RecentConversation>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(5);
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.scope_type, c.role_id, c.title, c.updated_at,
                    r.company, r.title AS role_title
             FROM conversations c
             LEFT JOIN roles r ON c.role_id = r.id
             ORDER BY c.updated_at DESC, c.id DESC
             LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit], |r| {
            Ok(RecentConversation {
                id: r.get(0)?,
                scope_type: r.get(1)?,
                role_id: r.get(2)?,
                title: r.get(3)?,
                updated_at: r.get(4)?,
                role_company: r.get(5)?,
                role_title: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_conversation(
    db: State<'_, Database>,
    scope_type: String,
    role_id: Option<String>,
    title: Option<String>,
) -> Result<Conversation, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    match scope_type.as_str() {
        "role" => {
            let role_id = role_id.ok_or("role_id required for scope_type='role'")?;
            conn.execute(
                "INSERT INTO conversations (scope_type, role_id, title) VALUES ('role', ?1, ?2)",
                params![role_id, title],
            )
            .map_err(|e| e.to_string())?;
        }
        "profile" => {
            conn.execute(
                "INSERT INTO conversations (scope_type, role_id, title) VALUES ('profile', NULL, ?1)",
                params![title],
            )
            .map_err(|e| e.to_string())?;
        }
        other => return Err(format!("Unknown scope_type: {}", other)),
    }

    let id = conn.last_insert_rowid();
    conn.query_row(
        "SELECT id, scope_type, role_id, title, created_at, updated_at
         FROM conversations WHERE id = ?1",
        params![id],
        row_to_conversation,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_conversation(
    db: State<'_, Database>,
    conversation_id: i64,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM conversations WHERE id = ?1", params![conversation_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn rename_conversation(
    db: State<'_, Database>,
    conversation_id: i64,
    title: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE conversations SET title = ?1, updated_at = datetime('now') WHERE id = ?2",
        params![title, conversation_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_messages(
    db: State<'_, Database>,
    conversation_id: i64,
) -> Result<Vec<Message>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, conversation_id, role, content, created_at
             FROM messages WHERE conversation_id = ?1 ORDER BY id ASC",
        )
        .map_err(|e| e.to_string())?;

    let messages: Vec<Message> = stmt
        .query_map(params![conversation_id], row_to_message)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(messages)
}

#[tauri::command]
pub fn list_artifacts(
    db: State<'_, Database>,
    role_id: String,
) -> Result<Vec<Artifact>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, role_id, kind, content, conversation_id, message_id, created_at
             FROM artifacts WHERE role_id = ?1 ORDER BY created_at DESC, id DESC",
        )
        .map_err(|e| e.to_string())?;

    let artifacts: Vec<Artifact> = stmt
        .query_map(params![role_id], row_to_artifact)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(artifacts)
}

#[tauri::command]
pub async fn send_to_conversation(
    db: State<'_, Database>,
    app: AppHandle,
    conversation_id: i64,
    user_text: String,
) -> Result<(), String> {
    // Resolve scope from the conversation row — lets the frontend pass just
    // conversation_id and we figure out role/profile internally.
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
            "role" => {
                let role_id = role_id.ok_or("Role conversation has no role_id")?;
                Scope::Role(role_id)
            }
            "profile" => Scope::Profile,
            other => return Err(format!("Unknown scope_type: {}", other)),
        }
    };

    run_turn_for_conversation(db, app, scope, conversation_id, user_text).await
}

// ── Turn runner (shared between role + profile scopes) ──

async fn run_turn_for_conversation(
    db: State<'_, Database>,
    app: AppHandle,
    scope: Scope,
    conversation_id: i64,
    user_text: String,
) -> Result<(), String> {
    let (api_key, mut api_messages) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;

        let user_content = json!([{"type": "text", "text": user_text}]);
        let user_msg_id =
            save_message(&conn, conversation_id, "user", &user_content).map_err(|e| e.to_string())?;

        emit(
            &app,
            json!({
                "type": "user_message_saved",
                "conversation_id": conversation_id,
                "message_id": user_msg_id,
                "content": user_content,
            }),
        );

        let key: Option<String> = conn
            .query_row("SELECT anthropic_api_key FROM settings WHERE id = 1", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;

        let api_msgs = load_messages_as_api_format(&conn, conversation_id).map_err(|e| e.to_string())?;

        (key, api_msgs)
    };

    let api_key = api_key.ok_or_else(|| {
        "No Anthropic API key configured. Add one in Settings.".to_string()
    })?;

    emit(&app, json!({"type": "turn_started", "conversation_id": conversation_id}));

    let client = reqwest::Client::new();

    for iteration in 0..MAX_TOOL_ITERATIONS {
        // Rebuild system prompt each iteration so tool mutations are reflected.
        // Split into stable prefix (user corpus — cached for 5min by Anthropic) and
        // dynamic tail (role-specific context that may have just changed).
        let (stable, dynamic) = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            build_system_prompt(&conn, &scope).map_err(|e| e.to_string())?
        };

        let system_blocks = if stable.len() > 1024 {
            // Cache the stable prefix; the dynamic tail streams fresh every time.
            json!([
                {"type": "text", "text": stable, "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": dynamic},
            ])
        } else {
            json!([{"type": "text", "text": format!("{}\n{}", stable, dynamic)}])
        };

        let body = json!({
            "model": CLAUDE_MODEL,
            "max_tokens": 4096,
            "system": system_blocks,
            "tools": tool_definitions(&scope),
            "messages": api_messages,
            "stream": true,
        });

        let resp = client
            .post(API_URL)
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                let msg = format!("API request failed: {}", e);
                emit(&app, json!({"type": "error", "conversation_id": conversation_id, "message": msg.clone()}));
                msg
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            let msg = format!("Claude API error ({}): {}", status, text);
            emit(&app, json!({"type": "error", "conversation_id": conversation_id, "message": msg.clone()}));
            return Err(msg);
        }

        let (assistant_content, stop_reason) =
            consume_stream(resp, &app, &db, &scope, conversation_id).await?;

        let assistant_msg_id = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            save_message(&conn, conversation_id, "assistant", &assistant_content)
                .map_err(|e| e.to_string())?
        };

        emit(
            &app,
            json!({
                "type": "assistant_message_saved",
                "conversation_id": conversation_id,
                "message_id": assistant_msg_id,
                "content": assistant_content,
            }),
        );

        api_messages.push(json!({"role": "assistant", "content": assistant_content}));

        match stop_reason.as_deref() {
            Some("end_turn") | Some("stop_sequence") | Some("max_tokens") | None => {
                emit(&app, json!({"type": "turn_done", "conversation_id": conversation_id}));
                return Ok(());
            }
            Some("tool_use") => {
                let tool_results = extract_tool_results(&assistant_content);
                let user_content = Value::Array(tool_results);
                let user_msg_id = {
                    let conn = db.0.lock().map_err(|e| e.to_string())?;
                    save_message(&conn, conversation_id, "user", &user_content)
                        .map_err(|e| e.to_string())?
                };
                emit(
                    &app,
                    json!({
                        "type": "tool_results_saved",
                        "conversation_id": conversation_id,
                        "message_id": user_msg_id,
                        "content": user_content,
                    }),
                );
                api_messages.push(json!({"role": "user", "content": user_content}));
                if iteration == MAX_TOOL_ITERATIONS - 1 {
                    let msg = "Stopped after max tool iterations".to_string();
                    emit(&app, json!({"type": "error", "conversation_id": conversation_id, "message": msg.clone()}));
                    return Err(msg);
                }
            }
            Some(other) => {
                let msg = format!("Unexpected stop_reason: {}", other);
                emit(&app, json!({"type": "error", "conversation_id": conversation_id, "message": msg.clone()}));
                return Err(msg);
            }
        }
    }

    Ok(())
}

// ── Stream parsing ──

async fn consume_stream(
    resp: reqwest::Response,
    app: &AppHandle,
    db: &State<'_, Database>,
    scope: &Scope,
    conversation_id: i64,
) -> Result<(Value, Option<String>), String> {
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    let mut blocks: HashMap<i64, Value> = HashMap::new();
    let mut tool_json_partials: HashMap<i64, String> = HashMap::new();
    let mut order: Vec<i64> = Vec::new();
    let mut tool_results: HashMap<String, Value> = HashMap::new();

    let mut stop_reason: Option<String> = None;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream error: {}", e))?;
        let s = std::str::from_utf8(&chunk).map_err(|e| e.to_string())?;
        buffer.push_str(s);

        loop {
            let Some(end) = buffer.find("\n\n") else { break };
            let raw_event = buffer[..end].to_string();
            buffer.drain(..end + 2);

            let mut data = String::new();
            for line in raw_event.lines() {
                if let Some(rest) = line.strip_prefix("data: ") {
                    if !data.is_empty() {
                        data.push('\n');
                    }
                    data.push_str(rest);
                } else if let Some(rest) = line.strip_prefix("data:") {
                    if !data.is_empty() {
                        data.push('\n');
                    }
                    data.push_str(rest);
                }
            }
            if data.is_empty() {
                continue;
            }

            let payload: Value = match serde_json::from_str(&data) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let event_type = payload["type"].as_str().unwrap_or("").to_string();

            match event_type.as_str() {
                "content_block_start" => {
                    let index = payload["index"].as_i64().unwrap_or(0);
                    let block = payload["content_block"].clone();
                    let block_type = block["type"].as_str().unwrap_or("").to_string();
                    blocks.insert(index, block.clone());
                    order.push(index);
                    if block_type == "tool_use" {
                        tool_json_partials.insert(index, String::new());
                        emit(
                            app,
                            json!({
                                "type": "tool_call_start",
                                "conversation_id": conversation_id,
                                "tool_use_id": block["id"],
                                "name": block["name"],
                            }),
                        );
                    } else if block_type == "text" {
                        emit(app, json!({"type": "text_start", "conversation_id": conversation_id}));
                    }
                }
                "content_block_delta" => {
                    let index = payload["index"].as_i64().unwrap_or(0);
                    let delta = &payload["delta"];
                    let delta_type = delta["type"].as_str().unwrap_or("");
                    match delta_type {
                        "text_delta" => {
                            let text = delta["text"].as_str().unwrap_or("");
                            if let Some(block) = blocks.get_mut(&index) {
                                let existing = block["text"].as_str().unwrap_or("").to_string();
                                block["text"] = Value::String(existing + text);
                            }
                            emit(app, json!({"type": "text_delta", "conversation_id": conversation_id, "text": text}));
                        }
                        "input_json_delta" => {
                            let partial = delta["partial_json"].as_str().unwrap_or("");
                            if let Some(buf) = tool_json_partials.get_mut(&index) {
                                buf.push_str(partial);
                            }
                        }
                        _ => {}
                    }
                }
                "content_block_stop" => {
                    let index = payload["index"].as_i64().unwrap_or(0);
                    if let Some(block) = blocks.get_mut(&index) {
                        if block["type"].as_str() == Some("tool_use") {
                            let raw = tool_json_partials.remove(&index).unwrap_or_default();
                            let input: Value =
                                serde_json::from_str(&raw).unwrap_or(Value::Object(Default::default()));
                            block["input"] = input.clone();

                            let tool_use_id = block["id"].as_str().unwrap_or("").to_string();
                            let tool_name = block["name"].as_str().unwrap_or("").to_string();

                            let (ok, summary, result_content) = {
                                let conn = db.0.lock().map_err(|e| e.to_string())?;
                                run_tool(&conn, scope, conversation_id, &tool_name, &input)
                            };

                            let tool_result_block = json!({
                                "type": "tool_result",
                                "tool_use_id": tool_use_id,
                                "content": result_content,
                                "is_error": !ok,
                            });
                            tool_results.insert(tool_use_id.clone(), tool_result_block);

                            emit(
                                app,
                                json!({
                                    "type": "tool_call_result",
                                    "conversation_id": conversation_id,
                                    "tool_use_id": tool_use_id,
                                    "name": tool_name,
                                    "input": input,
                                    "ok": ok,
                                    "summary": summary,
                                }),
                            );

                            if ok {
                                let (label, role_id) = match scope {
                                    Scope::Role(id) => ("role", Some(id.as_str())),
                                    Scope::Profile => ("profile", None),
                                };
                                crate::commands::acp::runtime::emit_data_changed(
                                    app, label, role_id, &tool_name,
                                );
                            }
                        }
                    }
                }
                "message_delta" => {
                    if let Some(sr) = payload["delta"]["stop_reason"].as_str() {
                        stop_reason = Some(sr.to_string());
                    }
                }
                "message_stop" => {}
                _ => {}
            }
        }
    }

    let mut content = Vec::new();
    let mut seen: Vec<i64> = Vec::new();
    for idx in order {
        if seen.contains(&idx) {
            continue;
        }
        seen.push(idx);
        if let Some(mut block) = blocks.remove(&idx) {
            if block["type"].as_str() == Some("tool_use") {
                let id = block["id"].as_str().unwrap_or("").to_string();
                if let Some(result) = tool_results.remove(&id) {
                    block["_result"] = result;
                }
            }
            content.push(block);
        }
    }

    Ok((Value::Array(content), stop_reason))
}

fn extract_tool_results(assistant_content: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(arr) = assistant_content.as_array() {
        for block in arr {
            if block["type"].as_str() == Some("tool_use") {
                if let Some(result) = block.get("_result") {
                    out.push(result.clone());
                }
            }
        }
    }
    out
}

// ── Tools ──

fn tool_definitions(scope: &Scope) -> Value {
    match scope {
        Scope::Role(_) => role_tool_definitions(),
        Scope::Profile => profile_tool_definitions(),
    }
}

fn role_tool_definitions() -> Value {
    json!([
        {
            "name": "update_stage",
            "description": "Update the pipeline stage of this role. Use this when the user reports progress (e.g. 'I applied,' 'had a recruiter screen').",
            "input_schema": {
                "type": "object",
                "properties": {
                    "stage": {
                        "type": "string",
                        "enum": ["Sourced", "Applied", "Recruiter Screen", "HM Interview", "Onsite", "Offer", "Negotiating"],
                    },
                },
                "required": ["stage"],
            },
        },
        {
            "name": "update_notes",
            "description": "Overwrite the role's notes field. Pass the full new notes content.",
            "input_schema": {
                "type": "object",
                "properties": {"notes": {"type": "string"}},
                "required": ["notes"],
            },
        },
        {
            "name": "update_next_action",
            "description": "Set the role's next_action — a short one-liner about what the user should do next.",
            "input_schema": {
                "type": "object",
                "properties": {"next_action": {"type": "string"}},
                "required": ["next_action"],
            },
        },
        {
            "name": "save_artifact",
            "description": "Save a generated artifact for this role. Creates a new versioned entry; previous versions remain accessible. Use kinds: 'resume' for tailored resume drafts, 'analysis' for fit/comparison analysis, 'research' for company/interview research packets, 'outreach' for drafted messages to contacts.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["resume", "analysis", "research", "outreach"]},
                    "content": {"type": "string", "description": "The artifact content, typically in markdown."},
                },
                "required": ["kind", "content"],
            },
        },
        {
            "name": "update_fit_score",
            "description": "Set the role's fit score (0-100). Use this when producing a tailored resume or analysis so the UI's fit badge reflects your assessment.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "fit_score": {"type": "integer", "minimum": 0, "maximum": 100},
                },
                "required": ["fit_score"],
            },
        },
        {
            "name": "create_task",
            "description": "Create a new task linked to this role (e.g. 'Follow up with recruiter,' 'Prep system design question').",
            "input_schema": {
                "type": "object",
                "properties": {
                    "content": {"type": "string"},
                    "due_date": {"type": "string", "description": "Optional YYYY-MM-DD date."},
                },
                "required": ["content"],
            },
        },
    ])
}

fn profile_tool_definitions() -> Value {
    json!([
        {
            "name": "save_work_stories",
            "description": "Overwrite the user's Work Stories (STAR format, used for interview prep and resume tailoring). Pass the COMPLETE markdown for all stories — this replaces anything currently saved. Use `## Story Title` headers with either `**Situation:** / **Task:** / **Action:** / **Result:**` inline labels OR `### Situation / ### Task / ### Action / ### Result` subheaders. Include `**Company:** / **Timeframe:** / **Role:**` metadata lines under each title when available.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "content": {"type": "string"},
                },
                "required": ["content"],
            },
        },
        {
            "name": "update_search_criteria",
            "description": "Overwrite the user's search criteria (companies, levels, must-haves, dealbreakers). Pass complete markdown.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "content": {"type": "string"},
                },
                "required": ["content"],
            },
        },
        {
            "name": "update_profile_about",
            "description": "Overwrite the user's profile 'about' markdown (background, target roles, comp goals). Pass complete markdown.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "content": {"type": "string"},
                },
                "required": ["content"],
            },
        },
    ])
}

fn run_tool(
    conn: &Connection,
    scope: &Scope,
    conversation_id: i64,
    name: &str,
    input: &Value,
) -> (bool, String, String) {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    match scope {
        Scope::Role(role_id) => run_role_tool(conn, role_id, conversation_id, name, input, &today),
        Scope::Profile => run_profile_tool(conn, name, input),
    }
}

fn run_role_tool(
    conn: &Connection,
    role_id: &str,
    conversation_id: i64,
    name: &str,
    input: &Value,
    today: &str,
) -> (bool, String, String) {
    match name {
        "update_stage" => {
            let stage = input["stage"].as_str().unwrap_or("");
            match conn.execute(
                "UPDATE roles SET stage = ?1, updated_date = ?2 WHERE id = ?3",
                params![stage, today, role_id],
            ) {
                Ok(_) => (true, format!("Stage set to {}", stage), format!("Updated stage to {}", stage)),
                Err(e) => (false, format!("Failed: {}", e), e.to_string()),
            }
        }
        "update_notes" => {
            let notes = input["notes"].as_str().unwrap_or("");
            match conn.execute(
                "UPDATE roles SET notes = ?1, updated_date = ?2 WHERE id = ?3",
                params![notes, today, role_id],
            ) {
                Ok(_) => (true, "Notes updated".into(), "Notes updated".into()),
                Err(e) => (false, format!("Failed: {}", e), e.to_string()),
            }
        }
        "update_next_action" => {
            let action = input["next_action"].as_str().unwrap_or("");
            match conn.execute(
                "UPDATE roles SET next_action = ?1, updated_date = ?2 WHERE id = ?3",
                params![action, today, role_id],
            ) {
                Ok(_) => (true, format!("Next action: {}", action), "Next action set".into()),
                Err(e) => (false, format!("Failed: {}", e), e.to_string()),
            }
        }
        "update_fit_score" => {
            let score = input["fit_score"].as_i64().unwrap_or(-1);
            if !(0..=100).contains(&score) {
                return (false, format!("Invalid fit_score: {}", score), "fit_score must be 0-100".into());
            }
            match conn.execute(
                "UPDATE roles SET fit_score = ?1, updated_date = ?2 WHERE id = ?3",
                params![score as i32, today, role_id],
            ) {
                Ok(_) => (true, format!("Fit score set to {}", score), format!("Fit score set to {}", score)),
                Err(e) => (false, format!("Failed: {}", e), e.to_string()),
            }
        }
        "save_artifact" => {
            let kind = input["kind"].as_str().unwrap_or("");
            let content = input["content"].as_str().unwrap_or("");
            match conn.execute(
                "INSERT INTO artifacts (role_id, kind, content, conversation_id) VALUES (?1, ?2, ?3, ?4)",
                params![role_id, kind, content, conversation_id],
            ) {
                Ok(_) => {
                    let id = conn.last_insert_rowid();
                    (true, format!("Saved {} artifact", kind), format!("artifact_id={}", id))
                }
                Err(e) => (false, format!("Failed: {}", e), e.to_string()),
            }
        }
        "create_task" => {
            let content = input["content"].as_str().unwrap_or("");
            let due = input["due_date"].as_str();
            let id = nanoid::nanoid!(10);
            match conn.execute(
                "INSERT INTO tasks (id, content, due_date, role_id) VALUES (?1, ?2, ?3, ?4)",
                params![id, content, due, role_id],
            ) {
                Ok(_) => (true, format!("Task created: {}", content), format!("task_id={}", id)),
                Err(e) => (false, format!("Failed: {}", e), e.to_string()),
            }
        }
        _ => (false, format!("Unknown tool: {}", name), format!("Unknown tool: {}", name)),
    }
}

fn run_profile_tool(conn: &Connection, name: &str, input: &Value) -> (bool, String, String) {
    match name {
        "save_work_stories" => {
            let content = input["content"].as_str().unwrap_or("");
            let count = content.lines().filter(|l| l.starts_with("## ")).count();
            match conn.execute(
                "UPDATE settings SET work_stories = ?1, updated_at = datetime('now') WHERE id = 1",
                params![content],
            ) {
                Ok(_) => (true, format!("Saved {} stories", count), format!("Saved {} stories", count)),
                Err(e) => (false, format!("Failed: {}", e), e.to_string()),
            }
        }
        "update_search_criteria" => {
            let content = input["content"].as_str().unwrap_or("");
            match conn.execute(
                "UPDATE settings SET search_criteria = ?1, updated_at = datetime('now') WHERE id = 1",
                params![content],
            ) {
                Ok(_) => (true, "Search criteria updated".into(), "Search criteria updated".into()),
                Err(e) => (false, format!("Failed: {}", e), e.to_string()),
            }
        }
        "update_profile_about" => {
            let content = input["content"].as_str().unwrap_or("");
            match conn.execute(
                "UPDATE settings SET profile_json = ?1, updated_at = datetime('now') WHERE id = 1",
                params![content],
            ) {
                Ok(_) => (true, "Profile 'about' updated".into(), "Profile 'about' updated".into()),
                Err(e) => (false, format!("Failed: {}", e), e.to_string()),
            }
        }
        _ => (false, format!("Unknown tool: {}", name), format!("Unknown tool: {}", name)),
    }
}

// ── System prompts ──

/// Returns (stable_prefix, dynamic_tail). The stable prefix is cache-marked so
/// Anthropic reuses it across turns within the 5-minute TTL.
fn build_system_prompt(conn: &Connection, scope: &Scope) -> rusqlite::Result<(String, String)> {
    match scope {
        Scope::Role(role_id) => build_role_system_prompt(conn, role_id),
        Scope::Profile => build_profile_system_prompt(conn),
    }
}

fn build_role_system_prompt(conn: &Connection, role_id: &str) -> rusqlite::Result<(String, String)> {
    let (company, title, stage, status, jd, notes, next_action, fit_score): (
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i32>,
    ) = conn.query_row(
        "SELECT company, title, stage, status, jd_content, notes, next_action, fit_score
         FROM roles WHERE id = ?1",
        params![role_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
    )?;

    let (resume_content, work_stories, profile_name, search_criteria): (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = conn.query_row(
        "SELECT resume_content, work_stories, profile_name, search_criteria
         FROM settings WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;

    let mut artifact_summary = String::new();
    for kind in &["resume", "analysis", "research", "outreach"] {
        let latest: Option<(i64, String)> = conn
            .query_row(
                "SELECT id, content FROM artifacts WHERE role_id = ?1 AND kind = ?2
                 ORDER BY created_at DESC, id DESC LIMIT 1",
                params![role_id, kind],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        if let Some((id, content)) = latest {
            artifact_summary.push_str(&format!(
                "\n\n### Latest {} artifact (id={})\n{}",
                kind, id, content
            ));
        }
    }

    let me_section = match profile_name {
        Some(name) => format!("The user's name is {}.\n", name),
        None => String::new(),
    };
    let resume_section = resume_content
        .map(|r| format!("\n\n## Master Resume\n{}", r))
        .unwrap_or_default();
    let stories_section = work_stories
        .map(|s| format!("\n\n## Work Stories (STAR)\n{}", s))
        .unwrap_or_default();
    let criteria_section = search_criteria
        .map(|s| format!("\n\n## Search Criteria\n{}", s))
        .unwrap_or_default();

    // Stable prefix: user's personal corpus + standing instructions. Changes only
    // when the user edits their profile/resume/stories/criteria — not on every turn.
    let stable = format!(
        r#"You are Ariadne, a job-search assistant embedded in the user's desktop app. This conversation is scoped to ONE specific role; use the context below and the available tools.

{me_section}

## Guidelines
- Be concise. The user is moving fast through many roles.
- When you generate artifacts (tailored resume, research packet, etc.), call `save_artifact` — don't paste them into chat text. The UI has dedicated viewers.
- When the user reports a stage change, call `update_stage`.
- When the user commits to a next step, call `update_next_action`.
- Don't summarize what you just did — the UI shows tool calls.
- You cannot close, delete, or reject roles. Those actions stay with the user.
{resume_section}{stories_section}{criteria_section}
"#
    );

    // Dynamic tail: per-role state that may have changed this turn (stage updates,
    // newly-saved artifacts, edited notes, etc.). Re-sent uncached every iteration.
    let dynamic = format!(
        r#"
## Current Role
- Company: {company}
- Title: {title}
- Stage: {stage}
- Status: {status}
- Fit Score: {fit}
- Next Action: {next_action}

## Job Description
{jd}

## User Notes
{notes}{artifact_summary}
"#,
        company = company,
        title = title,
        stage = stage,
        status = status,
        fit = fit_score.map(|s| s.to_string()).unwrap_or_else(|| "—".into()),
        next_action = next_action.as_deref().unwrap_or("—"),
        jd = jd.as_deref().unwrap_or("(no JD provided)"),
        notes = notes.as_deref().unwrap_or("(none)"),
        artifact_summary = artifact_summary,
    );

    Ok((stable, dynamic))
}

fn build_profile_system_prompt(conn: &Connection) -> rusqlite::Result<(String, String)> {
    let (resume_content, work_stories, profile_name, profile_about, search_criteria): (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = conn.query_row(
        "SELECT resume_content, work_stories, profile_name, profile_json, search_criteria
         FROM settings WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;

    let name_line = match profile_name.as_deref() {
        Some(n) if !n.is_empty() => format!("The user's name is {}.\n", n),
        _ => String::new(),
    };
    let resume_block = resume_content
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!("\n## Master Resume\n{}", s))
        .unwrap_or_else(|| "\n## Master Resume\n(empty — ask the user to paste their resume before proceeding with stories)".to_string());
    let stories_block = work_stories
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!("\n\n## Current Work Stories\n{}", s))
        .unwrap_or_else(|| "\n\n## Current Work Stories\n(none yet)".to_string());
    let about_block = profile_about
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!("\n\n## Profile About\n{}", s))
        .unwrap_or_default();
    let criteria_block = search_criteria
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!("\n\n## Search Criteria\n{}", s))
        .unwrap_or_default();

    // Stable: instructions + resume (these don't change within a session).
    let stable = format!(
        r#"You are Ariadne's Profile Coach, an interviewer/career coach embedded in the user's desktop app. This conversation is scoped to the USER'S PROFILE — resume, STAR stories, search criteria, and self-description. It is NOT scoped to any particular job.

{name_line}
## Your Job
Help the user build a strong personal corpus that the role-scoped chat will later draw on. Specifically:
1. **Build STAR stories** from their resume by interviewing them. For each story you want to create, ask ONE focused question at a time (e.g., "What was the measurable outcome?"). When you have enough, call `save_work_stories` with the FULL updated markdown for ALL stories (not a diff — the tool overwrites).
2. **Refine search criteria** — help articulate target companies, level, comp, must-haves, dealbreakers. Persist with `update_search_criteria`.
3. **Improve profile 'about'** — background summary, career arc, current focus. Persist with `update_profile_about`.

## Story Format
Use this markdown shape. If the user already has stories in a different shape, preserve their format.
```
## Short Story Title

**Company:** X
**Timeframe:** YYYY–YYYY
**Role:** Title

**Situation:** 2–3 sentences
**Task:** 1–2 sentences
**Action:** 4–8 bullets using "I" not "we"
**Result:** 2–4 bullets, quantified where possible
```

## Guidelines
- Ask ONE question per turn. Do not batch questions.
- When you have enough for a story, draft it, show it to the user, and ask if they want to save. Only call `save_work_stories` after explicit approval (or if they asked you to just do it).
- `save_work_stories` OVERWRITES everything. Always pass the COMPLETE updated corpus (existing stories + any new/edited ones), never a partial.
- Prefer quantified outcomes (percentages, dollar amounts, team sizes, time saved) — push the user to provide them.
- Don't invent numbers or achievements. If the user says "I don't remember the number," write "[TBD]" in the story and move on.
- Be concise. The user is busy.
{resume_block}
"#
    );

    // Dynamic: current stories/about/criteria (these can change via tool calls).
    let dynamic = format!("{stories_block}{about_block}{criteria_block}");

    Ok((stable, dynamic))
}

// ── Helpers ──

fn most_recent_or_create_role_conversation(
    conn: &Connection,
    role_id: &str,
) -> rusqlite::Result<Conversation> {
    if let Ok(c) = most_recent_role_conversation(conn, role_id) {
        return Ok(c);
    }
    conn.execute(
        "INSERT INTO conversations (scope_type, role_id) VALUES ('role', ?1)",
        params![role_id],
    )?;
    most_recent_role_conversation(conn, role_id)
}

fn most_recent_or_create_profile_conversation(
    conn: &Connection,
) -> rusqlite::Result<Conversation> {
    if let Ok(c) = most_recent_profile_conversation(conn) {
        return Ok(c);
    }
    conn.execute(
        "INSERT INTO conversations (scope_type, role_id) VALUES ('profile', NULL)",
        [],
    )?;
    most_recent_profile_conversation(conn)
}

fn most_recent_role_conversation(
    conn: &Connection,
    role_id: &str,
) -> rusqlite::Result<Conversation> {
    conn.query_row(
        "SELECT id, scope_type, role_id, title, created_at, updated_at
         FROM conversations WHERE role_id = ?1 AND scope_type = 'role'
         ORDER BY updated_at DESC, id DESC LIMIT 1",
        params![role_id],
        row_to_conversation,
    )
}

fn most_recent_profile_conversation(conn: &Connection) -> rusqlite::Result<Conversation> {
    conn.query_row(
        "SELECT id, scope_type, role_id, title, created_at, updated_at
         FROM conversations WHERE scope_type = 'profile'
         ORDER BY updated_at DESC, id DESC LIMIT 1",
        [],
        row_to_conversation,
    )
}

fn row_to_conversation(r: &rusqlite::Row) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: r.get(0)?,
        scope_type: r.get(1)?,
        role_id: r.get(2)?,
        title: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
    })
}

fn load_messages_as_api_format(
    conn: &Connection,
    conversation_id: i64,
) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT role, content FROM messages WHERE conversation_id = ?1 ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![conversation_id], |r| {
        let role: String = r.get(0)?;
        let content_str: String = r.get(1)?;
        let content: Value = serde_json::from_str(&content_str).unwrap_or(Value::Null);
        let clean_content = strip_internal_fields(&content);
        Ok(json!({"role": role, "content": clean_content}))
    })?;
    rows.collect()
}

fn strip_internal_fields(content: &Value) -> Value {
    match content {
        Value::Array(arr) => {
            let cleaned: Vec<Value> = arr
                .iter()
                .map(|block| {
                    let mut b = block.clone();
                    if let Some(obj) = b.as_object_mut() {
                        obj.remove("_result");
                    }
                    b
                })
                .collect();
            Value::Array(cleaned)
        }
        other => other.clone(),
    }
}

fn save_message(
    conn: &Connection,
    conversation_id: i64,
    role: &str,
    content: &Value,
) -> rusqlite::Result<i64> {
    let clean = strip_internal_fields(content);
    conn.execute(
        "INSERT INTO messages (conversation_id, role, content) VALUES (?1, ?2, ?3)",
        params![conversation_id, role, clean.to_string()],
    )?;
    let id = conn.last_insert_rowid();
    conn.execute(
        "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?1",
        params![conversation_id],
    )?;
    Ok(id)
}

fn row_to_message(row: &rusqlite::Row) -> rusqlite::Result<Message> {
    let content_str: String = row.get(3)?;
    let content: Value = serde_json::from_str(&content_str).unwrap_or(Value::Null);
    Ok(Message {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        role: row.get(2)?,
        content,
        created_at: row.get(4)?,
    })
}

fn row_to_artifact(row: &rusqlite::Row) -> rusqlite::Result<Artifact> {
    Ok(Artifact {
        id: row.get(0)?,
        role_id: row.get(1)?,
        kind: row.get(2)?,
        content: row.get(3)?,
        conversation_id: row.get(4)?,
        message_id: row.get(5)?,
        created_at: row.get(6)?,
    })
}

fn emit(app: &AppHandle, payload: Value) {
    let _ = app.emit(EVENT_CHANNEL, payload);
}
