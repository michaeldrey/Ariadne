use rusqlite::{Connection, Result};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use std::path::PathBuf;

pub struct Database(pub Mutex<Connection>);

pub fn db_path(app: &AppHandle) -> PathBuf {
    let data_dir = app
        .path()
        .app_data_dir()
        .expect("failed to resolve app data dir");
    std::fs::create_dir_all(&data_dir).expect("failed to create app data dir");
    data_dir.join("ariadne.db")
}

pub fn init(path: &PathBuf) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            anthropic_api_key TEXT,
            jobbot_endpoint TEXT,
            jobbot_api_key TEXT,
            search_backend TEXT DEFAULT 'jobbot',
            resume_content TEXT,
            work_stories TEXT,
            profile_name TEXT,
            profile_json TEXT,
            resume_filename TEXT DEFAULT 'Resume.pdf',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        INSERT OR IGNORE INTO settings (id) VALUES (1);

        CREATE TABLE IF NOT EXISTS roles (
            id TEXT PRIMARY KEY,
            company TEXT NOT NULL,
            title TEXT NOT NULL,
            url TEXT,
            stage TEXT NOT NULL DEFAULT 'Sourced',
            status TEXT NOT NULL DEFAULT 'active',
            outcome TEXT,
            skip_reason TEXT,
            fit_score INTEGER,
            jd_content TEXT,
            resume_draft TEXT,
            comparison_analysis TEXT,
            research_packet TEXT,
            notes TEXT,
            next_action TEXT,
            added_date TEXT DEFAULT (date('now')),
            updated_date TEXT DEFAULT (date('now')),
            closed_date TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_roles_status ON roles(status);
        CREATE INDEX IF NOT EXISTS idx_roles_stage ON roles(stage);

        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            due_date TEXT,
            role_id TEXT REFERENCES roles(id) ON DELETE SET NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT DEFAULT (date('now')),
            completed_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

        CREATE TABLE IF NOT EXISTS contacts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            company TEXT,
            title TEXT,
            email TEXT,
            linkedin_url TEXT,
            source TEXT,
            introduced_by TEXT,
            notes TEXT,
            added_date TEXT DEFAULT (date('now'))
        );

        CREATE TABLE IF NOT EXISTS interactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
            interaction_type TEXT NOT NULL,
            summary TEXT NOT NULL,
            interaction_date TEXT DEFAULT (date('now')),
            linked_roles TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_interactions_contact ON interactions(contact_id);
        ",
    )?;
    Ok(())
}
