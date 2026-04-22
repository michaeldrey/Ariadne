use crate::db::Database;
use crate::models::*;
use rusqlite::params;
use tauri::State;

#[tauri::command]
pub fn import_tracker(db: State<Database>, json_str: String) -> Result<ImportResult, String> {
    let tracker: TrackerJson = serde_json::from_str(&json_str)
        .map_err(|e| format!("Invalid tracker.json: {}", e))?;

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut imported = 0;
    let mut skipped = 0;

    // Import active roles
    for entry in &tracker.active {
        if role_exists(&conn, &entry.company, &entry.role) {
            skipped += 1;
            continue;
        }
        let id = nanoid::nanoid!(10);
        conn.execute(
            "INSERT INTO roles (id, company, title, url, stage, status, next_action, added_date, updated_date)
             VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?8)",
            params![
                id,
                entry.company,
                entry.role,
                entry.url,
                entry.stage.as_deref().unwrap_or("Sourced"),
                entry.next,
                entry.added.as_deref().unwrap_or("2026-01-01"),
                entry.updated.as_deref().unwrap_or("2026-01-01"),
            ],
        )
        .map_err(|e| e.to_string())?;
        imported += 1;
    }

    // Import skipped
    for entry in &tracker.skipped {
        if role_exists(&conn, &entry.company, &entry.role) {
            skipped += 1;
            continue;
        }
        let id = nanoid::nanoid!(10);
        conn.execute(
            "INSERT INTO roles (id, company, title, url, stage, status, skip_reason, added_date, updated_date)
             VALUES (?1, ?2, ?3, ?4, 'Sourced', 'skipped', ?5, ?6, ?6)",
            params![
                id, entry.company, entry.role, entry.url,
                entry.reason, entry.added.as_deref().unwrap_or("2026-01-01"),
            ],
        )
        .map_err(|e| e.to_string())?;
        imported += 1;
    }

    // Import closed
    for entry in &tracker.closed {
        if role_exists(&conn, &entry.company, &entry.role) {
            skipped += 1;
            continue;
        }
        let id = nanoid::nanoid!(10);
        conn.execute(
            "INSERT INTO roles (id, company, title, url, stage, status, outcome, added_date, updated_date, closed_date)
             VALUES (?1, ?2, ?3, ?4, ?5, 'closed', ?6, ?7, ?7, ?8)",
            params![
                id, entry.company, entry.role, entry.url,
                entry.stage.as_deref().unwrap_or("Applied"),
                entry.outcome.as_deref().unwrap_or("Rejected"),
                entry.added.as_deref().unwrap_or("2026-01-01"),
                entry.closed,
            ],
        )
        .map_err(|e| e.to_string())?;
        imported += 1;
    }

    Ok(ImportResult {
        imported,
        skipped,
        source: "tracker.json".into(),
    })
}

#[tauri::command]
pub fn import_contacts(db: State<Database>, json_str: String) -> Result<ImportResult, String> {
    let network: NetworkJson = serde_json::from_str(&json_str)
        .map_err(|e| format!("Invalid network.json: {}", e))?;

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut imported = 0;
    let mut skipped = 0;

    for contact in &network.contacts {
        let exists: bool = conn
            .query_row("SELECT COUNT(*) > 0 FROM contacts WHERE id = ?1", params![contact.id], |r| r.get(0))
            .unwrap_or(false);

        if exists {
            skipped += 1;
            continue;
        }

        conn.execute(
            "INSERT INTO contacts (id, name, company, title, email, linkedin_url, source, introduced_by, added_date)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                contact.id, contact.name, contact.company, contact.title,
                contact.email, contact.linkedin, contact.source,
                contact.introduced_by, contact.added.as_deref().unwrap_or("2026-01-01"),
            ],
        )
        .map_err(|e| e.to_string())?;

        // Import interactions
        if let Some(ref interactions) = contact.interactions {
            for ix in interactions {
                let linked = ix.linked_jobs.as_ref().map(|j| serde_json::to_string(j).unwrap_or_default());
                conn.execute(
                    "INSERT INTO interactions (contact_id, interaction_type, summary, interaction_date, linked_roles)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        contact.id,
                        ix.interaction_type.as_deref().unwrap_or("note"),
                        ix.summary.as_deref().unwrap_or(""),
                        ix.date.as_deref().unwrap_or("2026-01-01"),
                        linked,
                    ],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        imported += 1;
    }

    Ok(ImportResult {
        imported,
        skipped,
        source: "network.json".into(),
    })
}

#[tauri::command]
pub fn import_tasks(db: State<Database>, json_str: String) -> Result<ImportResult, String> {
    let tasks_file: TasksJson = serde_json::from_str(&json_str)
        .map_err(|e| format!("Invalid tasks.json: {}", e))?;

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut imported = 0;
    let mut skipped = 0;

    for task in &tasks_file.tasks {
        let exists: bool = conn
            .query_row("SELECT COUNT(*) > 0 FROM tasks WHERE id = ?1", params![task.id], |r| r.get(0))
            .unwrap_or(false);

        if exists {
            skipped += 1;
            continue;
        }

        let status = task.status.as_deref().unwrap_or("pending");
        conn.execute(
            "INSERT INTO tasks (id, content, due_date, status, created_at, completed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                task.id, task.task, task.due, status,
                task.created.as_deref().unwrap_or("2026-01-01"),
                task.completed,
            ],
        )
        .map_err(|e| e.to_string())?;
        imported += 1;
    }

    Ok(ImportResult {
        imported,
        skipped,
        source: "tasks.json".into(),
    })
}

#[derive(Debug, serde::Serialize)]
pub struct ImportResult {
    pub imported: i32,
    pub skipped: i32,
    pub source: String,
}

fn role_exists(conn: &rusqlite::Connection, company: &str, title: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) > 0 FROM roles WHERE LOWER(company) = LOWER(?1) AND LOWER(title) = LOWER(?2)",
        params![company, title],
        |r| r.get(0),
    )
    .unwrap_or(false)
}
