use crate::db::Database;
use crate::models::*;
use rusqlite::params;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
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

// ── Role detail folders (per-role JD, resume-draft, analysis, research, notes) ──

#[derive(Debug, Serialize)]
pub struct RoleArtifactsImportResult {
    pub matched: i32,
    pub artifacts_created: i32,
    pub jd_updates: i32,
    pub notes_updates: i32,
    pub unmatched: Vec<String>,
}

#[tauri::command]
pub fn import_role_artifacts(
    db: State<'_, Database>,
    base_dir: String,
) -> Result<RoleArtifactsImportResult, String> {
    let base = expand_home(&base_dir);
    if !base.is_dir() {
        return Err(format!("Path is not a directory: {}", base.display()));
    }

    let conn = db.0.lock().map_err(|e| e.to_string())?;

    // Index existing roles by normalized (company, title).
    // Normalization strips punctuation + collapses whitespace so tracker.json
    // titles like "SE, Production Engineering" match folder names like
    // "SE Production Engineering."
    let mut role_lookup: HashMap<(String, String), String> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, company, title FROM roles")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, company, title) = row.map_err(|e| e.to_string())?;
            role_lookup.insert((normalize(&company), normalize(&title)), id);
        }
    }

    let mut matched = 0;
    let mut artifacts_created = 0;
    let mut jd_updates = 0;
    let mut notes_updates = 0;
    let mut unmatched: Vec<String> = Vec::new();

    // Ariadne2 lays out role folders under state subdirs.
    for state_dir in &["Applied", "Closed", "InProgress", "Rejected"] {
        let state_path = base.join(state_dir);
        if !state_path.is_dir() {
            continue;
        }

        let entries = std::fs::read_dir(&state_path).map_err(|e| e.to_string())?;
        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let folder_name = entry.file_name().to_string_lossy().to_string();

            let Some((company, title)) = folder_name.split_once(" - ") else {
                unmatched.push(folder_name);
                continue;
            };

            let key = (normalize(company), normalize(title));
            let Some(role_id) = role_lookup.get(&key).cloned() else {
                unmatched.push(folder_name);
                continue;
            };

            matched += 1;

            // Files we care about. (filename, dest)
            // dest: "jd" updates roles.jd_content only if currently empty;
            //       "notes" updates roles.notes only if empty;
            //       artifact kinds insert a new artifact row (deduped by content).
            let files: &[(&str, &str)] = &[
                ("JD.md", "jd"),
                ("notes.md", "notes"),
                ("resume-draft.md", "resume"),
                ("comparison-analysis.md", "analysis"),
                ("research-packet.md", "research"),
            ];

            for (filename, dest) in files {
                let file_path = path.join(filename);
                if !file_path.is_file() {
                    continue;
                }
                let content = match std::fs::read_to_string(&file_path) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                if content.trim().is_empty() {
                    continue;
                }

                match *dest {
                    "jd" => {
                        let rows = conn
                            .execute(
                                "UPDATE roles SET jd_content = ?1
                                 WHERE id = ?2 AND (jd_content IS NULL OR jd_content = '')",
                                params![content, role_id],
                            )
                            .map_err(|e| e.to_string())?;
                        if rows > 0 {
                            jd_updates += 1;
                        }
                    }
                    "notes" => {
                        let rows = conn
                            .execute(
                                "UPDATE roles SET notes = ?1
                                 WHERE id = ?2 AND (notes IS NULL OR notes = '')",
                                params![content, role_id],
                            )
                            .map_err(|e| e.to_string())?;
                        if rows > 0 {
                            notes_updates += 1;
                        }
                    }
                    kind => {
                        // Dedup by content — avoid duplicates on re-import.
                        let exists: i32 = conn
                            .query_row(
                                "SELECT COUNT(*) FROM artifacts
                                 WHERE role_id = ?1 AND kind = ?2 AND content = ?3",
                                params![role_id, kind, content],
                                |r| r.get(0),
                            )
                            .unwrap_or(0);
                        if exists == 0 {
                            conn.execute(
                                "INSERT INTO artifacts (role_id, kind, content) VALUES (?1, ?2, ?3)",
                                params![role_id, kind, content],
                            )
                            .map_err(|e| e.to_string())?;
                            artifacts_created += 1;
                        }
                    }
                }
            }
        }
    }

    unmatched.sort();

    Ok(RoleArtifactsImportResult {
        matched,
        artifacts_created,
        jd_updates,
        notes_updates,
        unmatched,
    })
}

/// Lowercase + keep only alphanumerics + collapse whitespace.
/// Used to match folder names against DB role titles despite punctuation differences.
fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_was_space = true;
    for ch in s.chars() {
        if ch.is_alphanumeric() {
            for lc in ch.to_lowercase() {
                out.push(lc);
            }
            last_was_space = false;
        } else if !last_was_space {
            out.push(' ');
            last_was_space = true;
        }
    }
    out.trim().to_string()
}

fn expand_home(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(p)
}
