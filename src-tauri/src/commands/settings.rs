use crate::db::Database;
use crate::models::*;
use rusqlite::params;
use tauri::State;

#[tauri::command]
pub fn get_settings(db: State<Database>) -> Result<Settings, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT anthropic_api_key, jobbot_endpoint, jobbot_api_key, search_backend,
                resume_content, work_stories, profile_name, profile_json,
                search_criteria, resume_filename
         FROM settings WHERE id = 1",
        [],
        |row| {
            Ok(Settings {
                anthropic_api_key: row.get(0)?,
                jobbot_endpoint: row.get(1)?,
                jobbot_api_key: row.get(2)?,
                search_backend: row.get(3)?,
                resume_content: row.get(4)?,
                work_stories: row.get(5)?,
                profile_name: row.get(6)?,
                profile_json: row.get(7)?,
                search_criteria: row.get(8)?,
                resume_filename: row.get::<_, Option<String>>(9)?.unwrap_or_else(|| "Resume.pdf".into()),
            })
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_settings(db: State<Database>, data: UpdateSettings) -> Result<Settings, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    if let Some(ref v) = data.anthropic_api_key { conn.execute("UPDATE settings SET anthropic_api_key = ?1, updated_at = datetime('now') WHERE id = 1", params![v]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.jobbot_endpoint { conn.execute("UPDATE settings SET jobbot_endpoint = ?1, updated_at = datetime('now') WHERE id = 1", params![v]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.jobbot_api_key { conn.execute("UPDATE settings SET jobbot_api_key = ?1, updated_at = datetime('now') WHERE id = 1", params![v]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.search_backend { conn.execute("UPDATE settings SET search_backend = ?1, updated_at = datetime('now') WHERE id = 1", params![v]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.resume_content { conn.execute("UPDATE settings SET resume_content = ?1, updated_at = datetime('now') WHERE id = 1", params![v]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.work_stories { conn.execute("UPDATE settings SET work_stories = ?1, updated_at = datetime('now') WHERE id = 1", params![v]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.profile_name { conn.execute("UPDATE settings SET profile_name = ?1, updated_at = datetime('now') WHERE id = 1", params![v]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.profile_json { conn.execute("UPDATE settings SET profile_json = ?1, updated_at = datetime('now') WHERE id = 1", params![v]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.search_criteria { conn.execute("UPDATE settings SET search_criteria = ?1, updated_at = datetime('now') WHERE id = 1", params![v]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.resume_filename { conn.execute("UPDATE settings SET resume_filename = ?1, updated_at = datetime('now') WHERE id = 1", params![v]).map_err(|e| e.to_string())?; }

    drop(conn);
    get_settings(db)
}

#[tauri::command]
pub fn clear_api_key(db: State<Database>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("UPDATE settings SET anthropic_api_key = NULL, updated_at = datetime('now') WHERE id = 1", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}
