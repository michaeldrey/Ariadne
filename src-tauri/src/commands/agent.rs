use crate::db::Database;
use crate::models::*;
use futures_util::StreamExt;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

const CLAUDE_MODEL: &str = "claude-sonnet-4-20250514";
const API_URL: &str = "https://api.anthropic.com/v1/messages";
const MAX_TOOL_ITERATIONS: usize = 8;
const EVENT_CHANNEL: &str = "agent:event";

// ── Commands ──

#[tauri::command]
pub fn get_or_create_conversation(
    db: State<'_, Database>,
    role_id: String,
) -> Result<Conversation, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    if let Ok(c) = load_conversation_by_role(&conn, &role_id) {
        return Ok(c);
    }

    conn.execute(
        "INSERT INTO conversations (role_id) VALUES (?1)",
        params![role_id],
    )
    .map_err(|e| e.to_string())?;

    load_conversation_by_role(&conn, &role_id).map_err(|e| e.to_string())
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
pub async fn send_message(
    db: State<'_, Database>,
    app: AppHandle,
    role_id: String,
    user_text: String,
) -> Result<(), String> {
    // 1. Persist user message, load history & API key.
    let (conversation_id, api_key, mut api_messages) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let conv = load_conversation_by_role(&conn, &role_id)
            .or_else(|_| {
                conn.execute(
                    "INSERT INTO conversations (role_id) VALUES (?1)",
                    params![role_id],
                )?;
                load_conversation_by_role(&conn, &role_id)
            })
            .map_err(|e: rusqlite::Error| e.to_string())?;

        let user_content = json!([{"type": "text", "text": user_text}]);
        let user_msg_id =
            save_message(&conn, conv.id, "user", &user_content).map_err(|e| e.to_string())?;

        emit(
            &app,
            json!({"type": "user_message_saved", "message_id": user_msg_id, "content": user_content}),
        );

        let key: Option<String> = conn
            .query_row("SELECT anthropic_api_key FROM settings WHERE id = 1", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;

        let api_msgs = load_messages_as_api_format(&conn, conv.id).map_err(|e| e.to_string())?;

        (conv.id, key, api_msgs)
    };

    let api_key = api_key.ok_or_else(|| {
        "No Anthropic API key configured. Add one in Settings.".to_string()
    })?;

    emit(&app, json!({"type": "turn_started", "conversation_id": conversation_id}));

    let client = reqwest::Client::new();

    for iteration in 0..MAX_TOOL_ITERATIONS {
        // Fresh system prompt on every iteration so tool mutations are reflected.
        let system = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            build_system_prompt(&conn, &role_id).map_err(|e| e.to_string())?
        };

        let body = json!({
            "model": CLAUDE_MODEL,
            "max_tokens": 4096,
            "system": system,
            "tools": tool_definitions(),
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
                emit(&app, json!({"type": "error", "message": msg.clone()}));
                msg
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            let msg = format!("Claude API error ({}): {}", status, text);
            emit(&app, json!({"type": "error", "message": msg.clone()}));
            return Err(msg);
        }

        // Parse SSE stream, accumulate content blocks.
        let (assistant_content, stop_reason) =
            consume_stream(resp, &app, &db, &role_id, conversation_id).await?;

        // Save assistant message.
        let assistant_msg_id = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            save_message(&conn, conversation_id, "assistant", &assistant_content)
                .map_err(|e| e.to_string())?
        };

        emit(
            &app,
            json!({
                "type": "assistant_message_saved",
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
                // Build tool_result user message from the accumulated tool results.
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
                        "message_id": user_msg_id,
                        "content": user_content,
                    }),
                );
                api_messages.push(json!({"role": "user", "content": user_content}));
                if iteration == MAX_TOOL_ITERATIONS - 1 {
                    let msg = "Stopped after max tool iterations".to_string();
                    emit(&app, json!({"type": "error", "message": msg.clone()}));
                    return Err(msg);
                }
            }
            Some(other) => {
                let msg = format!("Unexpected stop_reason: {}", other);
                emit(&app, json!({"type": "error", "message": msg.clone()}));
                return Err(msg);
            }
        }
    }

    Ok(())
}

// ── Stream parsing ──

/// Consume the SSE stream. Emits incremental events to the UI and executes
/// tools inline. Returns the full assistant content-block array plus stop_reason.
///
/// Tool results are attached to their tool_use blocks via an internal
/// `_result` field so the caller can reconstruct the tool_result user message.
async fn consume_stream(
    resp: reqwest::Response,
    app: &AppHandle,
    db: &State<'_, Database>,
    role_id: &str,
    conversation_id: i64,
) -> Result<(Value, Option<String>), String> {
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    // In-progress per-block state.
    let mut blocks: HashMap<i64, Value> = HashMap::new();
    let mut tool_json_partials: HashMap<i64, String> = HashMap::new();
    let mut order: Vec<i64> = Vec::new();
    // Map tool_use_id → tool_result content so we can build the tool_result message.
    let mut tool_results: HashMap<String, Value> = HashMap::new();

    let mut stop_reason: Option<String> = None;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream error: {}", e))?;
        let s = std::str::from_utf8(&chunk).map_err(|e| e.to_string())?;
        buffer.push_str(s);

        // Process complete SSE events (separated by blank lines).
        loop {
            let Some(end) = buffer.find("\n\n") else { break };
            let raw_event = buffer[..end].to_string();
            buffer.drain(..end + 2);

            // Extract data payload (may be split across multiple `data:` lines).
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
                                "tool_use_id": block["id"],
                                "name": block["name"],
                            }),
                        );
                    } else if block_type == "text" {
                        emit(app, json!({"type": "text_start"}));
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
                            emit(app, json!({"type": "text_delta", "text": text}));
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

                            // Execute tool synchronously.
                            let (ok, summary, result_content) = {
                                let conn = db.0.lock().map_err(|e| e.to_string())?;
                                run_tool(&conn, role_id, conversation_id, &tool_name, &input)
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
                                    "tool_use_id": tool_use_id,
                                    "name": tool_name,
                                    "input": input,
                                    "ok": ok,
                                    "summary": summary,
                                }),
                            );
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

    // Assemble content blocks in order. Attach tool results onto tool_use blocks
    // so the caller can extract them to build the follow-up user message.
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

fn tool_definitions() -> Value {
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

fn run_tool(
    conn: &Connection,
    role_id: &str,
    conversation_id: i64,
    name: &str,
    input: &Value,
) -> (bool, String, String) {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
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

// ── Helpers ──

fn build_system_prompt(conn: &Connection, role_id: &str) -> rusqlite::Result<String> {
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

    let (resume_content, work_stories, profile_name): (Option<String>, Option<String>, Option<String>) =
        conn.query_row(
            "SELECT resume_content, work_stories, profile_name FROM settings WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;

    // Latest artifact of each kind.
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

    Ok(format!(
        r#"You are Ariadne, a job-search assistant embedded in the user's desktop app. This conversation is scoped to ONE specific role; use the context below and the available tools.

{me_section}
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
{notes}{artifact_summary}{resume_section}{stories_section}

## Guidelines
- Be concise. The user is moving fast through many roles.
- When you generate artifacts (tailored resume, research packet, etc.), call `save_artifact` — don't paste them into chat text. The UI has dedicated viewers.
- When the user reports a stage change, call `update_stage`.
- When the user commits to a next step, call `update_next_action`.
- Don't summarize what you just did — the UI shows tool calls.
- You cannot close, delete, or reject roles. Those actions stay with the user.
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
        resume_section = resume_section,
        stories_section = stories_section,
        me_section = me_section,
    ))
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
        // Strip any attached `_result` fields from historical tool_use blocks —
        // Anthropic's API doesn't accept that extension.
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

fn load_conversation_by_role(conn: &Connection, role_id: &str) -> rusqlite::Result<Conversation> {
    conn.query_row(
        "SELECT id, role_id, title, created_at, updated_at FROM conversations WHERE role_id = ?1",
        params![role_id],
        |r| {
            Ok(Conversation {
                id: r.get(0)?,
                role_id: r.get(1)?,
                title: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
            })
        },
    )
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
