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

    // Versioned migrations. Use PRAGMA user_version so data migrations run once.
    let current: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;

    if current < 2 {
        // v2: agent chat — conversations, messages, versioned artifacts.
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role_id TEXT NOT NULL UNIQUE REFERENCES roles(id) ON DELETE CASCADE,
                title TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);

            CREATE TABLE IF NOT EXISTS artifacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,
                content TEXT NOT NULL,
                conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
                message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
                created_at TEXT DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_artifacts_role_kind ON artifacts(role_id, kind, created_at DESC);

            INSERT INTO artifacts (role_id, kind, content, created_at)
            SELECT id, 'resume', resume_draft, COALESCE(updated_date, date('now'))
            FROM roles WHERE resume_draft IS NOT NULL AND resume_draft != '';

            INSERT INTO artifacts (role_id, kind, content, created_at)
            SELECT id, 'analysis', comparison_analysis, COALESCE(updated_date, date('now'))
            FROM roles WHERE comparison_analysis IS NOT NULL AND comparison_analysis != '';

            INSERT INTO artifacts (role_id, kind, content, created_at)
            SELECT id, 'research', research_packet, COALESCE(updated_date, date('now'))
            FROM roles WHERE research_packet IS NOT NULL AND research_packet != '';

            PRAGMA user_version = 2;
            ",
        )?;
    }

    if current < 3 {
        // v3: profile content fields imported from Ariadne2 top-level files.
        // profile_md reuses the existing profile_json column; search_criteria is new.
        conn.execute_batch(
            "
            ALTER TABLE settings ADD COLUMN search_criteria TEXT;
            PRAGMA user_version = 3;
            ",
        )?;
    }

    if current < 4 {
        // v4: conversations gains scope_type ('role' | 'profile'); role_id becomes nullable.
        // SQLite can't ALTER COLUMN — rebuild table preserving ids so messages FK stays valid.
        conn.execute_batch(
            "
            PRAGMA foreign_keys=OFF;

            CREATE TABLE conversations_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scope_type TEXT NOT NULL DEFAULT 'role',
                role_id TEXT REFERENCES roles(id) ON DELETE CASCADE,
                title TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );

            INSERT INTO conversations_new (id, scope_type, role_id, title, created_at, updated_at)
            SELECT id, 'role', role_id, title, created_at, updated_at FROM conversations;

            DROP TABLE conversations;
            ALTER TABLE conversations_new RENAME TO conversations;

            CREATE UNIQUE INDEX idx_conv_role ON conversations(role_id) WHERE role_id IS NOT NULL;
            CREATE UNIQUE INDEX idx_conv_profile ON conversations(scope_type) WHERE scope_type = 'profile';

            PRAGMA foreign_keys=ON;
            PRAGMA user_version = 4;
            ",
        )?;
    }

    Ok(())
}
