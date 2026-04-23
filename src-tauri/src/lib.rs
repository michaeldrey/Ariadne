mod commands;
mod db;
mod models;

use commands::acp::runtime::AcpRuntime;
use db::Database;
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let db_path = db::db_path(app.handle());
            let conn = db::init(&db_path).expect("failed to initialize database");
            app.manage(Database(Arc::new(Mutex::new(conn))));
            app.manage(AcpRuntime::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Roles
            commands::roles::list_roles,
            commands::roles::get_role,
            commands::roles::create_role,
            commands::roles::update_role,
            commands::roles::update_stage,
            commands::roles::skip_role,
            commands::roles::delete_role,
            commands::roles::get_pipeline_stats,
            // Tasks
            commands::tasks::list_tasks,
            commands::tasks::create_task,
            commands::tasks::update_task,
            commands::tasks::complete_task,
            commands::tasks::delete_task,
            // Contacts
            commands::contacts::list_contacts,
            commands::contacts::get_contact,
            commands::contacts::create_contact,
            commands::contacts::update_contact,
            commands::contacts::delete_contact,
            commands::contacts::list_interactions,
            commands::contacts::add_interaction,
            // Settings
            commands::settings::get_settings,
            commands::settings::update_settings,
            commands::settings::clear_api_key,
            // Claude AI
            commands::claude::tailor_resume,
            commands::claude::fetch_jd_from_url,
            commands::claude::summarize_for_title,
            commands::claude::generate_research,
            commands::claude::generate_work_stories,
            // Job Search
            commands::search::run_job_search,
            commands::search::quick_add_from_search,
            // Agent chat
            commands::agent::get_or_create_conversation,
            commands::agent::get_or_create_profile_conversation,
            commands::agent::list_conversations,
            commands::agent::list_recent_conversations,
            commands::agent::create_conversation,
            commands::agent::delete_conversation,
            commands::agent::rename_conversation,
            commands::agent::list_messages,
            commands::agent::list_artifacts,
            commands::agent::send_to_conversation,
            commands::acp::runtime::send_to_conversation_acp,
            commands::acp::install::detect_acp_install,
            commands::acp::install::install_acp,
            commands::acp::install::detect_claude_cli,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
