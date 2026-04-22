//! rmcp tool implementations exposed to the ACP agent over an in-process
//! HTTP MCP server. Tools wrap the existing direct-API logic in
//! `commands::agent::run_role_tool` / `run_profile_tool`.
//!
//! Scope is checked per-tool: role tools return an error in profile scope,
//! profile tools return an error in role scope. We expose ONE server with
//! ALL tools rather than running two different servers per scope — the
//! agent learns which tools work via error feedback. Simpler than dynamic
//! registration.

use crate::db::Database;
use rmcp::{
    ErrorData as McpError, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    tool, tool_handler, tool_router,
};
use rusqlite::params;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone)]
pub enum Scope {
    Role(String),
    Profile,
}

/// Shared state for all tool handlers. Cloneable so the router can fan out.
#[derive(Clone)]
pub struct AriadneTools {
    pub db: Database,
    pub scope: Scope,
    pub conversation_id: i64,
    pub tool_router: ToolRouter<AriadneTools>,
}

impl AriadneTools {
    pub fn new(db: Database, scope: Scope, conversation_id: i64) -> Self {
        Self {
            db,
            scope,
            conversation_id,
            tool_router: Self::tool_router(),
        }
    }

    fn require_role(&self) -> Result<&str, McpError> {
        match &self.scope {
            Scope::Role(id) => Ok(id.as_str()),
            Scope::Profile => Err(McpError::invalid_request(
                "This tool only works in role-scoped chats.".to_string(),
                None,
            )),
        }
    }

    fn require_profile(&self) -> Result<(), McpError> {
        match &self.scope {
            Scope::Profile => Ok(()),
            Scope::Role(_) => Err(McpError::invalid_request(
                "This tool only works in the Profile Coach chat.".to_string(),
                None,
            )),
        }
    }
}

// ── Tool parameter types ──

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct UpdateStageParams {
    /// Pipeline stage. One of: Sourced, Applied, Recruiter Screen, HM Interview, Onsite, Offer, Negotiating.
    stage: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct SaveWorkStoriesParams {
    /// Complete markdown for ALL stories (this tool overwrites).
    /// Format: `## Title` headers with either `**Situation:** / **Task:** / **Action:** / **Result:**` inline labels OR `### Situation / ### Task / ### Action / ### Result` subheaders.
    content: String,
}

// ── Tool implementations ──

#[tool_router]
impl AriadneTools {
    #[tool(description = "Update the pipeline stage of the current role. Use when the user reports progress (e.g. 'I applied,' 'had a recruiter screen'). Role-scoped chats only.")]
    async fn update_stage(
        &self,
        Parameters(p): Parameters<UpdateStageParams>,
    ) -> Result<CallToolResult, McpError> {
        let role_id = self.require_role()?.to_string();
        let db = self.db.clone();
        let stage = p.stage.clone();

        let affected: rusqlite::Result<usize> = tokio::task::spawn_blocking(move || {
            let conn = db.0.lock().map_err(|e| rusqlite::Error::InvalidPath(e.to_string().into()))?;
            conn.execute(
                "UPDATE roles SET stage = ?1, updated_date = date('now') WHERE id = ?2",
                params![stage, role_id],
            )
        })
        .await
        .map_err(|e| McpError::internal_error(format!("task join: {}", e), None))?;

        affected.map_err(|e| McpError::internal_error(format!("sql: {}", e), None))?;

        Ok(CallToolResult::success(vec![Content::text(format!(
            "Stage set to {}",
            p.stage
        ))]))
    }

    #[tool(description = "Overwrite the user's Work Stories corpus (STAR format). Pass the COMPLETE updated markdown — this tool overwrites everything. Profile-scoped chats only.")]
    async fn save_work_stories(
        &self,
        Parameters(p): Parameters<SaveWorkStoriesParams>,
    ) -> Result<CallToolResult, McpError> {
        self.require_profile()?;
        let db = self.db.clone();
        let content = p.content.clone();

        let count = content.lines().filter(|l| l.starts_with("## ")).count();

        let res: rusqlite::Result<usize> = tokio::task::spawn_blocking(move || {
            let conn = db.0.lock().map_err(|e| rusqlite::Error::InvalidPath(e.to_string().into()))?;
            conn.execute(
                "UPDATE settings SET work_stories = ?1, updated_at = datetime('now') WHERE id = 1",
                params![content],
            )
        })
        .await
        .map_err(|e| McpError::internal_error(format!("task join: {}", e), None))?;

        res.map_err(|e| McpError::internal_error(format!("sql: {}", e), None))?;

        Ok(CallToolResult::success(vec![Content::text(format!(
            "Saved {} stories",
            count
        ))]))
    }

    // TODO(step 2 follow-up): port the remaining 7 tools from
    // commands::agent::run_role_tool and run_profile_tool. Each follows the
    // same spawn_blocking + params pattern as the two above.
    //
    // Role tools:
    //   - update_notes(notes: String)
    //   - update_next_action(next_action: String)
    //   - update_fit_score(fit_score: i32)  [validate 0..=100]
    //   - save_artifact(kind: String, content: String)  [insert into artifacts table with conversation_id]
    //   - create_task(content: String, due_date: Option<String>)
    // Profile tools:
    //   - update_search_criteria(content: String)
    //   - update_profile_about(content: String)  [writes to settings.profile_json]
}

#[tool_handler]
impl ServerHandler for AriadneTools {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.server_info = Implementation::new("ariadne-tools", env!("CARGO_PKG_VERSION"));
        info.protocol_version = ProtocolVersion::V_2024_11_05;
        info.instructions = Some(
            "Ariadne's job-search tools. Role-scoped tools mutate a specific role; \
             profile-scoped tools update the user's resume/stories/search criteria."
                .into(),
        );
        info
    }
}

/// Marker to ensure Arc<Database> usage survives the tools file even if unused
/// before step 3 wires everything up.
#[allow(dead_code)]
fn _ensure_db_is_sendable(db: Arc<Database>) -> Arc<Database> {
    db
}
