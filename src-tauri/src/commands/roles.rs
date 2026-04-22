use crate::db::Database;
use crate::models::*;
use rusqlite::params;
use tauri::State;

#[tauri::command]
pub fn list_roles(db: State<Database>, status: Option<String>) -> Result<Vec<Role>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut sql = String::from(
        "SELECT id, company, title, url, stage, status, outcome, skip_reason,
                fit_score, jd_content, resume_draft, comparison_analysis,
                research_packet, notes, next_action, added_date, updated_date, closed_date
         FROM roles"
    );
    let status_filter = status.unwrap_or_default();
    if !status_filter.is_empty() {
        sql.push_str(" WHERE status = ?1");
    }
    sql.push_str(" ORDER BY updated_date DESC");

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

    let roles: Vec<Role> = if !status_filter.is_empty() {
        stmt.query_map(params![status_filter], row_to_role)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    } else {
        stmt.query_map([], row_to_role)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };

    Ok(roles)
}

#[tauri::command]
pub fn get_role(db: State<Database>, id: String) -> Result<Role, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id, company, title, url, stage, status, outcome, skip_reason,
                fit_score, jd_content, resume_draft, comparison_analysis,
                research_packet, notes, next_action, added_date, updated_date, closed_date
         FROM roles WHERE id = ?1",
        params![id],
        row_to_role,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_role(db: State<Database>, data: CreateRole) -> Result<Role, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let id = nanoid::nanoid!(10);
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    conn.execute(
        "INSERT INTO roles (id, company, title, url, jd_content, notes, stage, status, added_date, updated_date)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'Sourced', 'active', ?7, ?7)",
        params![id, data.company, data.title, data.url, data.jd_content, data.notes, today],
    )
    .map_err(|e| e.to_string())?;

    get_role_internal(&conn, &id)
}

#[tauri::command]
pub fn update_role(db: State<Database>, id: String, data: UpdateRole) -> Result<Role, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    // Update each provided field individually
    if let Some(ref v) = data.company { conn.execute("UPDATE roles SET company = ?1, updated_date = ?2 WHERE id = ?3", params![v, today, id]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.title { conn.execute("UPDATE roles SET title = ?1, updated_date = ?2 WHERE id = ?3", params![v, today, id]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.url { conn.execute("UPDATE roles SET url = ?1, updated_date = ?2 WHERE id = ?3", params![v, today, id]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.stage { conn.execute("UPDATE roles SET stage = ?1, updated_date = ?2 WHERE id = ?3", params![v, today, id]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.status { conn.execute("UPDATE roles SET status = ?1, updated_date = ?2 WHERE id = ?3", params![v, today, id]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.outcome { conn.execute("UPDATE roles SET outcome = ?1, updated_date = ?2 WHERE id = ?3", params![v, today, id]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.skip_reason { conn.execute("UPDATE roles SET skip_reason = ?1, updated_date = ?2 WHERE id = ?3", params![v, today, id]).map_err(|e| e.to_string())?; }
    if let Some(v) = data.fit_score { conn.execute("UPDATE roles SET fit_score = ?1, updated_date = ?2 WHERE id = ?3", params![v, today, id]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.jd_content { conn.execute("UPDATE roles SET jd_content = ?1, updated_date = ?2 WHERE id = ?3", params![v, today, id]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.resume_draft { conn.execute("UPDATE roles SET resume_draft = ?1, updated_date = ?2 WHERE id = ?3", params![v, today, id]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.comparison_analysis { conn.execute("UPDATE roles SET comparison_analysis = ?1, updated_date = ?2 WHERE id = ?3", params![v, today, id]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.research_packet { conn.execute("UPDATE roles SET research_packet = ?1, updated_date = ?2 WHERE id = ?3", params![v, today, id]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.notes { conn.execute("UPDATE roles SET notes = ?1, updated_date = ?2 WHERE id = ?3", params![v, today, id]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.next_action { conn.execute("UPDATE roles SET next_action = ?1, updated_date = ?2 WHERE id = ?3", params![v, today, id]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.closed_date { conn.execute("UPDATE roles SET closed_date = ?1, updated_date = ?2 WHERE id = ?3", params![v, today, id]).map_err(|e| e.to_string())?; }

    // If no specific fields, just touch updated_date
    conn.execute(
        "UPDATE roles SET updated_date = ?1 WHERE id = ?2 AND updated_date != ?1",
        params![today, id],
    ).map_err(|e| e.to_string())?;

    get_role_internal(&conn, &id)
}

#[tauri::command]
pub fn update_stage(db: State<Database>, id: String, stage: String, outcome: Option<String>) -> Result<Role, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    let closed_stages = ["Rejected", "Withdrew", "Accepted", "Expired"];
    if closed_stages.contains(&stage.as_str()) {
        let outcome_value = outcome.unwrap_or_else(|| stage.clone());
        conn.execute(
            "UPDATE roles SET status = 'closed', outcome = ?1, closed_date = ?2, updated_date = ?2 WHERE id = ?3",
            params![outcome_value, today, id],
        ).map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "UPDATE roles SET stage = ?1, status = 'active', updated_date = ?2 WHERE id = ?3",
            params![stage, today, id],
        ).map_err(|e| e.to_string())?;
    }

    get_role_internal(&conn, &id)
}

#[tauri::command]
pub fn skip_role(db: State<Database>, id: String, reason: Option<String>) -> Result<Role, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    conn.execute(
        "UPDATE roles SET status = 'skipped', skip_reason = ?1, updated_date = ?2 WHERE id = ?3",
        params![reason.unwrap_or_default(), today, id],
    ).map_err(|e| e.to_string())?;

    get_role_internal(&conn, &id)
}

#[tauri::command]
pub fn delete_role(db: State<Database>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM roles WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_pipeline_stats(db: State<Database>) -> Result<PipelineStats, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let total: i32 = conn
        .query_row("SELECT COUNT(*) FROM roles WHERE status = 'active'", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT stage, COUNT(*) FROM roles WHERE status = 'active' GROUP BY stage ORDER BY stage")
        .map_err(|e| e.to_string())?;

    let by_stage = stmt
        .query_map([], |row| {
            Ok(StageCount {
                stage: row.get(0)?,
                count: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(PipelineStats { total, by_stage })
}

fn get_role_internal(conn: &rusqlite::Connection, id: &str) -> Result<Role, String> {
    conn.query_row(
        "SELECT id, company, title, url, stage, status, outcome, skip_reason,
                fit_score, jd_content, resume_draft, comparison_analysis,
                research_packet, notes, next_action, added_date, updated_date, closed_date
         FROM roles WHERE id = ?1",
        params![id],
        row_to_role,
    )
    .map_err(|e| e.to_string())
}

fn row_to_role(row: &rusqlite::Row) -> rusqlite::Result<Role> {
    Ok(Role {
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
}

