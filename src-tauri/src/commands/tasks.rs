use crate::db::Database;
use crate::models::*;
use rusqlite::params;
use tauri::State;

#[tauri::command]
pub fn list_tasks(db: State<Database>, status: Option<String>, role_id: Option<String>) -> Result<Vec<Task>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let mut conditions = Vec::new();
    if let Some(ref s) = status {
        conditions.push(format!("t.status = '{}'", s.replace('\'', "''")));
    }
    if let Some(ref rid) = role_id {
        conditions.push(format!("t.role_id = '{}'", rid.replace('\'', "''")));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };

    let sql = format!(
        "SELECT t.id, t.content, t.due_date, t.role_id, t.status, t.created_at, t.completed_at,
                CASE WHEN r.id IS NOT NULL THEN r.company || ' - ' || r.title ELSE NULL END as role_label
         FROM tasks t
         LEFT JOIN roles r ON t.role_id = r.id
         {}
         ORDER BY
           CASE WHEN t.status = 'pending' THEN 0 ELSE 1 END,
           t.due_date ASC NULLS LAST,
           t.created_at DESC",
        where_clause
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Task {
                id: row.get(0)?,
                content: row.get(1)?,
                due_date: row.get(2)?,
                role_id: row.get(3)?,
                status: row.get(4)?,
                created_at: row.get(5)?,
                completed_at: row.get(6)?,
                role_label: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_task(db: State<Database>, data: CreateTask) -> Result<Task, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let id = format!("task-{}", nanoid::nanoid!(6));
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    conn.execute(
        "INSERT INTO tasks (id, content, due_date, role_id, status, created_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', ?5)",
        params![id, data.content, data.due_date, data.role_id, today],
    )
    .map_err(|e| e.to_string())?;

    // Fetch back with join
    conn.query_row(
        "SELECT t.id, t.content, t.due_date, t.role_id, t.status, t.created_at, t.completed_at,
                CASE WHEN r.id IS NOT NULL THEN r.company || ' - ' || r.title ELSE NULL END
         FROM tasks t LEFT JOIN roles r ON t.role_id = r.id WHERE t.id = ?1",
        params![id],
        |row| Ok(Task {
            id: row.get(0)?,
            content: row.get(1)?,
            due_date: row.get(2)?,
            role_id: row.get(3)?,
            status: row.get(4)?,
            created_at: row.get(5)?,
            completed_at: row.get(6)?,
            role_label: row.get(7)?,
        }),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_task(db: State<Database>, id: String, data: UpdateTask) -> Result<Task, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    if let Some(ref v) = data.content {
        conn.execute("UPDATE tasks SET content = ?1 WHERE id = ?2", params![v, id])
            .map_err(|e| e.to_string())?;
    }
    if let Some(ref v) = data.due_date {
        conn.execute("UPDATE tasks SET due_date = ?1 WHERE id = ?2", params![v, id])
            .map_err(|e| e.to_string())?;
    }
    if let Some(ref v) = data.role_id {
        conn.execute("UPDATE tasks SET role_id = ?1 WHERE id = ?2", params![v, id])
            .map_err(|e| e.to_string())?;
    }
    if let Some(completed) = data.completed {
        if completed {
            let today = chrono::Local::now().format("%Y-%m-%d").to_string();
            conn.execute(
                "UPDATE tasks SET status = 'completed', completed_at = ?1 WHERE id = ?2",
                params![today, id],
            )
            .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "UPDATE tasks SET status = 'pending', completed_at = NULL WHERE id = ?1",
                params![id],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    conn.query_row(
        "SELECT t.id, t.content, t.due_date, t.role_id, t.status, t.created_at, t.completed_at,
                CASE WHEN r.id IS NOT NULL THEN r.company || ' - ' || r.title ELSE NULL END
         FROM tasks t LEFT JOIN roles r ON t.role_id = r.id WHERE t.id = ?1",
        params![id],
        |row| Ok(Task {
            id: row.get(0)?,
            content: row.get(1)?,
            due_date: row.get(2)?,
            role_id: row.get(3)?,
            status: row.get(4)?,
            created_at: row.get(5)?,
            completed_at: row.get(6)?,
            role_label: row.get(7)?,
        }),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn complete_task(db: State<Database>, id: String) -> Result<Task, String> {
    update_task(db, id, UpdateTask {
        content: None,
        due_date: None,
        role_id: None,
        completed: Some(true),
    })
}

#[tauri::command]
pub fn delete_task(db: State<Database>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
