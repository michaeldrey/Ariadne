use crate::db::Database;
use crate::models::*;
use rusqlite::params;
use tauri::State;

#[tauri::command]
pub fn list_contacts(db: State<Database>) -> Result<Vec<Contact>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.name, c.company, c.title, c.email, c.linkedin_url,
                    c.source, c.introduced_by, c.notes, c.added_date,
                    COUNT(i.id) as interaction_count,
                    MAX(i.interaction_date) as last_interaction
             FROM contacts c
             LEFT JOIN interactions i ON c.id = i.contact_id
             GROUP BY c.id
             ORDER BY last_interaction DESC NULLS LAST, c.added_date DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Contact {
                id: row.get(0)?,
                name: row.get(1)?,
                company: row.get(2)?,
                title: row.get(3)?,
                email: row.get(4)?,
                linkedin_url: row.get(5)?,
                source: row.get(6)?,
                introduced_by: row.get(7)?,
                notes: row.get(8)?,
                added_date: row.get(9)?,
                interaction_count: row.get(10)?,
                last_interaction: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_contact(db: State<Database>, id: String) -> Result<Contact, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT c.id, c.name, c.company, c.title, c.email, c.linkedin_url,
                c.source, c.introduced_by, c.notes, c.added_date,
                COUNT(i.id), MAX(i.interaction_date)
         FROM contacts c
         LEFT JOIN interactions i ON c.id = i.contact_id
         WHERE c.id = ?1
         GROUP BY c.id",
        params![id],
        |row| {
            Ok(Contact {
                id: row.get(0)?,
                name: row.get(1)?,
                company: row.get(2)?,
                title: row.get(3)?,
                email: row.get(4)?,
                linkedin_url: row.get(5)?,
                source: row.get(6)?,
                introduced_by: row.get(7)?,
                notes: row.get(8)?,
                added_date: row.get(9)?,
                interaction_count: row.get(10)?,
                last_interaction: row.get(11)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_contact(db: State<Database>, data: CreateContact) -> Result<Contact, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let id = slug_from_name(&data.name);
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    // Check for duplicate
    let exists: bool = conn
        .query_row("SELECT COUNT(*) > 0 FROM contacts WHERE id = ?1", params![id], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let final_id = if exists {
        format!("{}-{}", id, nanoid::nanoid!(4))
    } else {
        id
    };

    conn.execute(
        "INSERT INTO contacts (id, name, company, title, email, linkedin_url, source, introduced_by, notes, added_date)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            final_id, data.name, data.company, data.title, data.email,
            data.linkedin_url, data.source, data.introduced_by, data.notes, today
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(Contact {
        id: final_id,
        name: data.name,
        company: data.company,
        title: data.title,
        email: data.email,
        linkedin_url: data.linkedin_url,
        source: data.source,
        introduced_by: data.introduced_by,
        notes: data.notes,
        added_date: today,
        interaction_count: Some(0),
        last_interaction: None,
    })
}

#[tauri::command]
pub fn update_contact(db: State<Database>, id: String, data: UpdateContact) -> Result<Contact, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    if let Some(ref v) = data.name { conn.execute("UPDATE contacts SET name = ?1 WHERE id = ?2", params![v, id]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.company { conn.execute("UPDATE contacts SET company = ?1 WHERE id = ?2", params![v, id]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.title { conn.execute("UPDATE contacts SET title = ?1 WHERE id = ?2", params![v, id]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.email { conn.execute("UPDATE contacts SET email = ?1 WHERE id = ?2", params![v, id]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.linkedin_url { conn.execute("UPDATE contacts SET linkedin_url = ?1 WHERE id = ?2", params![v, id]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.source { conn.execute("UPDATE contacts SET source = ?1 WHERE id = ?2", params![v, id]).map_err(|e| e.to_string())?; }
    if let Some(ref v) = data.notes { conn.execute("UPDATE contacts SET notes = ?1 WHERE id = ?2", params![v, id]).map_err(|e| e.to_string())?; }

    drop(conn);
    get_contact(db, id)
}

#[tauri::command]
pub fn delete_contact(db: State<Database>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM contacts WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_interactions(db: State<Database>, contact_id: String) -> Result<Vec<Interaction>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, contact_id, interaction_type, summary, interaction_date, linked_roles
             FROM interactions WHERE contact_id = ?1
             ORDER BY interaction_date DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![contact_id], |row| {
            Ok(Interaction {
                id: row.get(0)?,
                contact_id: row.get(1)?,
                interaction_type: row.get(2)?,
                summary: row.get(3)?,
                interaction_date: row.get(4)?,
                linked_roles: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_interaction(db: State<Database>, contact_id: String, data: CreateInteraction) -> Result<Interaction, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let date = data.interaction_date.unwrap_or(today);
    let linked = data.linked_roles.map(|r| serde_json::to_string(&r).unwrap_or_default());

    conn.execute(
        "INSERT INTO interactions (contact_id, interaction_type, summary, interaction_date, linked_roles)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![contact_id, data.interaction_type, data.summary, date, linked],
    )
    .map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid();
    Ok(Interaction {
        id,
        contact_id,
        interaction_type: data.interaction_type,
        summary: data.summary,
        interaction_date: date,
        linked_roles: linked,
    })
}

fn slug_from_name(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}
