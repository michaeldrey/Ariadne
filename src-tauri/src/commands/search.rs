use crate::db::Database;
use crate::models::*;
use rusqlite::params;
use tauri::State;

#[tauri::command]
pub async fn run_job_search(db: State<'_, Database>) -> Result<SearchResult, String> {
    let (endpoint, api_key, exclude_urls) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;

        let (ep, ak): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT jobbot_endpoint, jobbot_api_key FROM settings WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;

        // Collect all existing URLs to exclude
        let mut stmt = conn
            .prepare("SELECT url FROM roles WHERE url IS NOT NULL")
            .map_err(|e| e.to_string())?;
        let urls: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        (ep, ak, urls)
    };

    let endpoint = endpoint.ok_or("JobBot endpoint not configured. Set it in Settings.")?;
    let api_key = api_key.ok_or("JobBot API key not configured. Set it in Settings.")?;

    let body = serde_json::json!({
        "companies": [],
        "roleLevels": [],
        "locations": [],
        "maxAgeDays": 14,
        "excludeUrls": exclude_urls
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .header("x-api-key", &api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("JobBot API error: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("JobBot API error ({}): {}", status, text));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let jobs: Vec<SearchJob> = json["jobs"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(|j| SearchJob {
            id: j["id"].as_str().unwrap_or("").to_string(),
            title: j["title"].as_str().unwrap_or("").to_string(),
            company: j["company"].as_str().unwrap_or("").to_string(),
            location: j["location"].as_str().unwrap_or("").to_string(),
            url: j["url"].as_str().unwrap_or("").to_string(),
            description: j["description"].as_str().map(|s| s.to_string()),
            posted_date: j["postedDate"].as_str().map(|s| s.to_string()),
            department: j["department"].as_str().map(|s| s.to_string()),
            source: j["source"].as_str().map(|s| s.to_string()),
            relevance_score: None,
        })
        .collect();

    let meta = SearchMeta {
        companies_searched: json["meta"]["companiesSearched"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        companies_not_supported: json["meta"]["companiesNotSupported"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        total_collected: json["meta"]["totalCollected"].as_i64().unwrap_or(0) as i32,
        after_exclusion: json["meta"]["afterExclusion"].as_i64().unwrap_or(0) as i32,
    };

    Ok(SearchResult { jobs, meta })
}

#[tauri::command]
pub fn quick_add_from_search(db: State<Database>, job: SearchJob) -> Result<crate::models::Role, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let id = nanoid::nanoid!(10);
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    conn.execute(
        "INSERT INTO roles (id, company, title, url, jd_content, stage, status, added_date, updated_date)
         VALUES (?1, ?2, ?3, ?4, ?5, 'Sourced', 'active', ?6, ?6)",
        params![id, job.company, job.title, job.url, job.description, today],
    )
    .map_err(|e| e.to_string())?;

    conn.query_row(
        "SELECT id, company, title, url, stage, status, outcome, skip_reason,
                fit_score, jd_content, resume_draft, comparison_analysis,
                research_packet, notes, next_action, added_date, updated_date, closed_date
         FROM roles WHERE id = ?1",
        params![id],
        |row| {
            Ok(crate::models::Role {
                id: row.get(0)?,
                company: row.get(1)?,
                title: row.get(2)?,
                url: row.get(3)?,
                stage: row.get(4)?,
                status: row.get(5)?,
                outcome: row.get(6)?,
                skip_reason: row.get(7)?,
                fit_score: row.get(8)?,
                jd_content: row.get(9)?,
                resume_draft: row.get(10)?,
                comparison_analysis: row.get(11)?,
                research_packet: row.get(12)?,
                notes: row.get(13)?,
                next_action: row.get(14)?,
                added_date: row.get(15)?,
                updated_date: row.get(16)?,
                closed_date: row.get(17)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}
