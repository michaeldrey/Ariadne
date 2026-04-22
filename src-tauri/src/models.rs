use serde::{Deserialize, Serialize};

// ── Roles ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Role {
    pub id: String,
    pub company: String,
    pub title: String,
    pub url: Option<String>,
    pub stage: String,
    pub status: String, // active, skipped, closed
    pub outcome: Option<String>,
    pub skip_reason: Option<String>,
    pub fit_score: Option<i32>,
    pub jd_content: Option<String>,
    pub resume_draft: Option<String>,
    pub comparison_analysis: Option<String>,
    pub research_packet: Option<String>,
    pub notes: Option<String>,
    pub next_action: Option<String>,
    pub added_date: String,
    pub updated_date: String,
    pub closed_date: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateRole {
    pub company: String,
    pub title: String,
    pub url: Option<String>,
    pub jd_content: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateRole {
    pub company: Option<String>,
    pub title: Option<String>,
    pub url: Option<String>,
    pub stage: Option<String>,
    pub status: Option<String>,
    pub outcome: Option<String>,
    pub skip_reason: Option<String>,
    pub fit_score: Option<i32>,
    pub jd_content: Option<String>,
    pub resume_draft: Option<String>,
    pub comparison_analysis: Option<String>,
    pub research_packet: Option<String>,
    pub notes: Option<String>,
    pub next_action: Option<String>,
    pub closed_date: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PipelineStats {
    pub total: i32,
    pub by_stage: Vec<StageCount>,
}

#[derive(Debug, Serialize)]
pub struct StageCount {
    pub stage: String,
    pub count: i32,
}

// ── Tasks ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub content: String,
    pub due_date: Option<String>,
    pub role_id: Option<String>,
    pub role_label: Option<String>, // "Company - Title" for display
    pub status: String,
    pub created_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateTask {
    pub content: String,
    pub due_date: Option<String>,
    pub role_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTask {
    pub content: Option<String>,
    pub due_date: Option<String>,
    pub role_id: Option<String>,
    pub completed: Option<bool>,
}

// ── Contacts ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contact {
    pub id: String,
    pub name: String,
    pub company: Option<String>,
    pub title: Option<String>,
    pub email: Option<String>,
    pub linkedin_url: Option<String>,
    pub source: Option<String>,
    pub introduced_by: Option<String>,
    pub notes: Option<String>,
    pub added_date: String,
    pub interaction_count: Option<i32>,
    pub last_interaction: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateContact {
    pub name: String,
    pub company: Option<String>,
    pub title: Option<String>,
    pub email: Option<String>,
    pub linkedin_url: Option<String>,
    pub source: Option<String>,
    pub introduced_by: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateContact {
    pub name: Option<String>,
    pub company: Option<String>,
    pub title: Option<String>,
    pub email: Option<String>,
    pub linkedin_url: Option<String>,
    pub source: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Interaction {
    pub id: i64,
    pub contact_id: String,
    pub interaction_type: String,
    pub summary: String,
    pub interaction_date: String,
    pub linked_roles: Option<String>, // JSON array of role IDs
}

#[derive(Debug, Deserialize)]
pub struct CreateInteraction {
    pub interaction_type: String,
    pub summary: String,
    pub interaction_date: Option<String>,
    pub linked_roles: Option<Vec<String>>,
}

// ── Settings ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub anthropic_api_key: Option<String>,
    pub jobbot_endpoint: Option<String>,
    pub jobbot_api_key: Option<String>,
    pub search_backend: Option<String>,
    pub resume_content: Option<String>,
    pub work_stories: Option<String>,
    pub profile_name: Option<String>,
    pub profile_json: Option<String>,
    pub resume_filename: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSettings {
    pub anthropic_api_key: Option<String>,
    pub jobbot_endpoint: Option<String>,
    pub jobbot_api_key: Option<String>,
    pub search_backend: Option<String>,
    pub resume_content: Option<String>,
    pub work_stories: Option<String>,
    pub profile_name: Option<String>,
    pub profile_json: Option<String>,
    pub resume_filename: Option<String>,
}

// ── Claude API ──

#[derive(Debug, Serialize)]
pub struct TailorResult {
    pub resume_draft: String,
    pub analysis: String,
    pub fit_score: Option<i32>,
}

#[derive(Debug, Serialize)]
pub struct ResearchResult {
    pub research_packet: String,
}

// ── Agent Chat ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: i64,
    pub role_id: String,
    pub title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: i64,
    pub conversation_id: i64,
    pub role: String,          // "user" | "assistant"
    pub content: serde_json::Value, // JSON array of content blocks
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artifact {
    pub id: i64,
    pub role_id: String,
    pub kind: String,          // "resume" | "analysis" | "research" | "outreach"
    pub content: String,
    pub conversation_id: Option<i64>,
    pub message_id: Option<i64>,
    pub created_at: String,
}

// ── Job Search ──

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchJob {
    pub id: String,
    pub title: String,
    pub company: String,
    pub location: String,
    pub url: String,
    pub description: Option<String>,
    pub posted_date: Option<String>,
    pub department: Option<String>,
    pub source: Option<String>,
    pub relevance_score: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchMeta {
    pub companies_searched: Vec<String>,
    pub companies_not_supported: Vec<String>,
    pub total_collected: i32,
    pub after_exclusion: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub jobs: Vec<SearchJob>,
    pub meta: SearchMeta,
}

// ── Import (from existing JSON files) ──

#[derive(Debug, Deserialize)]
pub struct TrackerJson {
    pub active: Vec<TrackerEntry>,
    pub skipped: Vec<TrackerSkipped>,
    pub closed: Vec<TrackerClosed>,
}

#[derive(Debug, Deserialize)]
pub struct TrackerEntry {
    pub company: String,
    pub role: String,
    pub stage: Option<String>,
    pub next: Option<String>,
    pub url: Option<String>,
    pub added: Option<String>,
    pub updated: Option<String>,
    pub folder: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TrackerSkipped {
    pub company: String,
    pub role: String,
    pub reason: Option<String>,
    pub url: Option<String>,
    pub added: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TrackerClosed {
    pub company: String,
    pub role: String,
    pub stage: Option<String>,
    pub outcome: Option<String>,
    pub url: Option<String>,
    pub added: Option<String>,
    pub closed: Option<String>,
    pub folder: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct NetworkJson {
    pub contacts: Vec<NetworkContact>,
}

#[derive(Debug, Deserialize)]
pub struct NetworkContact {
    pub id: String,
    pub name: String,
    pub company: Option<String>,
    pub title: Option<String>,
    pub email: Option<String>,
    pub linkedin: Option<String>,
    pub source: Option<String>,
    #[serde(rename = "introducedBy")]
    pub introduced_by: Option<String>,
    pub added: Option<String>,
    pub interactions: Option<Vec<NetworkInteraction>>,
}

#[derive(Debug, Deserialize)]
pub struct NetworkInteraction {
    pub date: Option<String>,
    #[serde(rename = "type")]
    pub interaction_type: Option<String>,
    pub summary: Option<String>,
    #[serde(rename = "linkedJobs")]
    pub linked_jobs: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct TasksJson {
    pub tasks: Vec<TaskEntry>,
}

#[derive(Debug, Deserialize)]
pub struct TaskEntry {
    pub id: String,
    pub task: String,
    pub due: Option<String>,
    #[serde(rename = "linkedContacts")]
    pub linked_contacts: Option<Vec<String>>,
    #[serde(rename = "linkedJobs")]
    pub linked_jobs: Option<Vec<String>>,
    pub status: Option<String>,
    pub created: Option<String>,
    pub completed: Option<String>,
}
