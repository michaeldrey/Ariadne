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
use futures_util::future::join_all;
use rusqlite::params;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

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
    pub app: AppHandle,
    pub tool_router: ToolRouter<AriadneTools>,
}

impl AriadneTools {
    pub fn new(db: Database, scope: Scope, conversation_id: i64, app: AppHandle) -> Self {
        Self {
            db,
            scope,
            conversation_id,
            app,
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

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct UpdateNotesParams {
    /// Full new notes content. Overwrites the field.
    notes: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct UpdateNextActionParams {
    /// Short one-liner about what the user should do next.
    next_action: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct UpdateFitScoreParams {
    /// Fit assessment 0-100.
    fit_score: i32,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct SaveArtifactParams {
    /// One of: `resume`, `analysis`, `research`, `outreach`.
    kind: String,
    /// Artifact content, typically markdown.
    content: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct CreateTaskParams {
    /// Task description.
    content: String,
    /// Optional YYYY-MM-DD due date.
    #[serde(default)]
    due_date: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct UpdateSearchCriteriaParams {
    /// Full markdown for search criteria (companies, levels, must-haves, dealbreakers).
    content: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct UpdateProfileAboutParams {
    /// Full markdown for the user's profile 'about' section.
    content: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, Clone)]
struct JobMatch {
    /// Role title, e.g. "Staff Software Engineer, Platform".
    title: String,
    /// Company name.
    company: String,
    /// Direct URL to the job posting. Must be a real posting URL, not a search page.
    url: String,
    /// City / country / "Remote" string, if available.
    #[serde(default)]
    location: Option<String>,
    /// True if the role is explicitly remote; false if explicitly on-site; omit if unclear.
    #[serde(default)]
    remote: Option<bool>,
    /// Salary range string, e.g. "$250k-$320k + equity". Omit if not posted.
    #[serde(default)]
    salary: Option<String>,
    /// Posted date in YYYY-MM-DD if visible on the page; omit if unknown.
    #[serde(default)]
    posted_date: Option<String>,
    /// One-sentence rationale tying the match to the user's criteria.
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
struct ReportJobMatchesParams {
    /// All matches found in this search, ordered best-fit first.
    matches: Vec<JobMatch>,
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

    #[tool(description = "Overwrite the role's notes field. Pass the full new notes content. Role-scoped chats only.")]
    async fn update_notes(
        &self,
        Parameters(p): Parameters<UpdateNotesParams>,
    ) -> Result<CallToolResult, McpError> {
        let role_id = self.require_role()?.to_string();
        let db = self.db.clone();
        let notes = p.notes;

        let res: rusqlite::Result<usize> = tokio::task::spawn_blocking(move || {
            let conn = db.0.lock().map_err(|e| rusqlite::Error::InvalidPath(e.to_string().into()))?;
            conn.execute(
                "UPDATE roles SET notes = ?1, updated_date = date('now') WHERE id = ?2",
                params![notes, role_id],
            )
        })
        .await
        .map_err(|e| McpError::internal_error(format!("task join: {}", e), None))?;

        res.map_err(|e| McpError::internal_error(format!("sql: {}", e), None))?;

        Ok(CallToolResult::success(vec![Content::text("Notes updated".to_string())]))
    }

    #[tool(description = "Set the role's next_action — a short one-liner about what the user should do next. Role-scoped chats only.")]
    async fn update_next_action(
        &self,
        Parameters(p): Parameters<UpdateNextActionParams>,
    ) -> Result<CallToolResult, McpError> {
        let role_id = self.require_role()?.to_string();
        let db = self.db.clone();
        let action = p.next_action.clone();

        let res: rusqlite::Result<usize> = tokio::task::spawn_blocking(move || {
            let conn = db.0.lock().map_err(|e| rusqlite::Error::InvalidPath(e.to_string().into()))?;
            conn.execute(
                "UPDATE roles SET next_action = ?1, updated_date = date('now') WHERE id = ?2",
                params![action, role_id],
            )
        })
        .await
        .map_err(|e| McpError::internal_error(format!("task join: {}", e), None))?;

        res.map_err(|e| McpError::internal_error(format!("sql: {}", e), None))?;

        Ok(CallToolResult::success(vec![Content::text(format!(
            "Next action: {}",
            p.next_action
        ))]))
    }

    #[tool(description = "Set the role's fit score (0-100). Use this when producing a tailored resume or analysis so the UI's fit badge reflects your assessment. Role-scoped chats only.")]
    async fn update_fit_score(
        &self,
        Parameters(p): Parameters<UpdateFitScoreParams>,
    ) -> Result<CallToolResult, McpError> {
        let role_id = self.require_role()?.to_string();
        if !(0..=100).contains(&p.fit_score) {
            return Err(McpError::invalid_params(
                format!("fit_score must be 0-100, got {}", p.fit_score),
                None,
            ));
        }
        let db = self.db.clone();
        let score = p.fit_score;

        let res: rusqlite::Result<usize> = tokio::task::spawn_blocking(move || {
            let conn = db.0.lock().map_err(|e| rusqlite::Error::InvalidPath(e.to_string().into()))?;
            conn.execute(
                "UPDATE roles SET fit_score = ?1, updated_date = date('now') WHERE id = ?2",
                params![score, role_id],
            )
        })
        .await
        .map_err(|e| McpError::internal_error(format!("task join: {}", e), None))?;

        res.map_err(|e| McpError::internal_error(format!("sql: {}", e), None))?;

        Ok(CallToolResult::success(vec![Content::text(format!(
            "Fit score set to {}",
            score
        ))]))
    }

    #[tool(description = "Save a generated artifact for this role. Creates a new versioned entry; previous versions remain accessible. Kinds: 'resume' for tailored resume drafts, 'analysis' for fit/comparison analysis, 'research' for company/interview research, 'outreach' for drafted messages to contacts. Role-scoped chats only.")]
    async fn save_artifact(
        &self,
        Parameters(p): Parameters<SaveArtifactParams>,
    ) -> Result<CallToolResult, McpError> {
        let role_id = self.require_role()?.to_string();
        match p.kind.as_str() {
            "resume" | "analysis" | "research" | "outreach" => {}
            other => {
                return Err(McpError::invalid_params(
                    format!("kind must be one of resume|analysis|research|outreach, got '{}'", other),
                    None,
                ));
            }
        }
        let db = self.db.clone();
        let kind = p.kind.clone();
        let content = p.content;
        let conversation_id = self.conversation_id;

        let res: rusqlite::Result<i64> = tokio::task::spawn_blocking(move || {
            let conn = db.0.lock().map_err(|e| rusqlite::Error::InvalidPath(e.to_string().into()))?;
            conn.execute(
                "INSERT INTO artifacts (role_id, kind, content, conversation_id) VALUES (?1, ?2, ?3, ?4)",
                params![role_id, kind, content, conversation_id],
            )?;
            Ok(conn.last_insert_rowid())
        })
        .await
        .map_err(|e| McpError::internal_error(format!("task join: {}", e), None))?;

        let id = res.map_err(|e| McpError::internal_error(format!("sql: {}", e), None))?;

        Ok(CallToolResult::success(vec![Content::text(format!(
            "Saved {} artifact (id={})",
            p.kind, id
        ))]))
    }

    #[tool(description = "Create a new task linked to this role (e.g. 'Follow up with recruiter,' 'Prep system design question'). Role-scoped chats only.")]
    async fn create_task(
        &self,
        Parameters(p): Parameters<CreateTaskParams>,
    ) -> Result<CallToolResult, McpError> {
        let role_id = self.require_role()?.to_string();
        let db = self.db.clone();
        let content = p.content.clone();
        let due = p.due_date.clone();
        let id = nanoid::nanoid!(10);
        let id_for_sql = id.clone();

        let res: rusqlite::Result<usize> = tokio::task::spawn_blocking(move || {
            let conn = db.0.lock().map_err(|e| rusqlite::Error::InvalidPath(e.to_string().into()))?;
            conn.execute(
                "INSERT INTO tasks (id, content, due_date, role_id) VALUES (?1, ?2, ?3, ?4)",
                params![id_for_sql, content, due, role_id],
            )
        })
        .await
        .map_err(|e| McpError::internal_error(format!("task join: {}", e), None))?;

        res.map_err(|e| McpError::internal_error(format!("sql: {}", e), None))?;

        Ok(CallToolResult::success(vec![Content::text(format!(
            "Task created (id={}): {}",
            id, p.content
        ))]))
    }

    #[tool(description = "Overwrite the user's search criteria (companies, levels, must-haves, dealbreakers). Pass complete markdown. Profile-scoped chats only.")]
    async fn update_search_criteria(
        &self,
        Parameters(p): Parameters<UpdateSearchCriteriaParams>,
    ) -> Result<CallToolResult, McpError> {
        self.require_profile()?;
        let db = self.db.clone();
        let content = p.content;

        let res: rusqlite::Result<usize> = tokio::task::spawn_blocking(move || {
            let conn = db.0.lock().map_err(|e| rusqlite::Error::InvalidPath(e.to_string().into()))?;
            conn.execute(
                "UPDATE settings SET search_criteria = ?1, updated_at = datetime('now') WHERE id = 1",
                params![content],
            )
        })
        .await
        .map_err(|e| McpError::internal_error(format!("task join: {}", e), None))?;

        res.map_err(|e| McpError::internal_error(format!("sql: {}", e), None))?;

        Ok(CallToolResult::success(vec![Content::text(
            "Search criteria updated".to_string(),
        )]))
    }

    #[tool(description = "Overwrite the user's profile 'about' markdown (background, target roles, comp goals). Pass complete markdown. Profile-scoped chats only.")]
    async fn update_profile_about(
        &self,
        Parameters(p): Parameters<UpdateProfileAboutParams>,
    ) -> Result<CallToolResult, McpError> {
        self.require_profile()?;
        let db = self.db.clone();
        let content = p.content;

        let res: rusqlite::Result<usize> = tokio::task::spawn_blocking(move || {
            let conn = db.0.lock().map_err(|e| rusqlite::Error::InvalidPath(e.to_string().into()))?;
            conn.execute(
                "UPDATE settings SET profile_json = ?1, updated_at = datetime('now') WHERE id = 1",
                params![content],
            )
        })
        .await
        .map_err(|e| McpError::internal_error(format!("task join: {}", e), None))?;

        res.map_err(|e| McpError::internal_error(format!("sql: {}", e), None))?;

        Ok(CallToolResult::success(vec![Content::text(
            "Profile 'about' updated".to_string(),
        )]))
    }

    #[tool(description = "Report job matches found during web search. Populates the Job Search results table in the UI with a row per match. Pass ALL matches in a single call (don't call incrementally). Each URL is server-verified with a live GET — any URL that doesn't load is DROPPED before reaching the UI, and a list of dropped URLs is returned so you know which matches were rejected. Profile-scoped chats only.")]
    async fn report_job_matches(
        &self,
        Parameters(p): Parameters<ReportJobMatchesParams>,
    ) -> Result<CallToolResult, McpError> {
        self.require_profile()?;
        let submitted = p.matches.len();

        // Parallel URL verification. Anything that doesn't respond with 2xx
        // within the timeout is dropped — covers hallucinated URLs and
        // stale/removed postings. The agent gets a list of rejections in
        // the tool result so it can retry or report the gap.
        let checks = p.matches.iter().map(|m| async move {
            let ok = url_is_live(&m.url).await;
            (ok, m.clone())
        });
        let results = join_all(checks).await;
        let mut verified = Vec::new();
        let mut rejected = Vec::new();
        for (ok, m) in results {
            if ok { verified.push(m); } else { rejected.push(m); }
        }

        let count = verified.len();
        let payload = serde_json::to_value(&verified)
            .unwrap_or_else(|_| serde_json::json!([]));
        let _ = self.app.emit("jobs:matched", payload);

        let mut msg = format!(
            "Reported {} verified match{} (of {} submitted) to the UI.",
            count, if count == 1 { "" } else { "es" }, submitted,
        );
        if !rejected.is_empty() {
            msg.push_str("\n\nRejected URLs (failed live check — likely hallucinated or stale):\n");
            for r in &rejected {
                msg.push_str(&format!("- {} ({} — {})\n", r.url, r.company, r.title));
            }
            msg.push_str("\nIf this leaves too few matches, try different WebSearch queries — prefer ATS domains (boards.greenhouse.io, jobs.lever.co, jobs.ashbyhq.com) and verify each URL with WebFetch before including it.");
        }
        Ok(CallToolResult::success(vec![Content::text(msg)]))
    }
}

/// Live-URL check used by report_job_matches to weed out hallucinated or
/// stale links before they reach the UI. Uses GET (not HEAD — too many
/// sites 405 on HEAD), short timeout, realistic UA to avoid trivial 403s.
async fn url_is_live(url: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("Mozilla/5.0 (Macintosh; Ariadne Job Tracker) AppleWebKit/605.1.15")
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client.get(url).send().await {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    }
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
