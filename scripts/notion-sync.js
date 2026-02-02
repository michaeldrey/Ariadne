#!/usr/bin/env node
/**
 * notion-sync.js - Sync Ariadne data to Notion
 * 
 * Phase 1: One-way sync from local files to Notion.
 * Local files remain the source of truth; this script pushes changes to Notion.
 * 
 * Usage:
 *   node scripts/notion-sync.js [--dry-run]
 * 
 * Requires data/config.json with:
 * {
 *   "notion": {
 *     "apiKey": "ntn_xxx or secret_xxx",
 *     "databases": {
 *       "jobs": "database-id",
 *       "contacts": "database-id", 
 *       "tasks": "database-id"
 *     }
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const TRACKER_PATH = path.join(DATA_DIR, 'tracker.json');
const NETWORK_PATH = path.join(DATA_DIR, 'network.json');
const TASKS_PATH = path.join(DATA_DIR, 'tasks.json');
const SYNC_MAP_PATH = path.join(DATA_DIR, '.notion-sync-map.json');

const NOTION_VERSION = '2025-09-03';

// Parse args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

// Load config
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('Error: data/config.json not found');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!config.notion?.apiKey) {
    console.error('Error: notion.apiKey not configured in data/config.json');
    process.exit(1);
  }
  if (!config.notion?.databases) {
    console.error('Error: notion.databases not configured in data/config.json');
    process.exit(1);
  }
  return config;
}

// Load sync map (tracks local ID -> Notion page ID mapping)
function loadSyncMap() {
  if (fs.existsSync(SYNC_MAP_PATH)) {
    return JSON.parse(fs.readFileSync(SYNC_MAP_PATH, 'utf8'));
  }
  return { jobs: {}, contacts: {}, tasks: {} };
}

function saveSyncMap(map) {
  fs.writeFileSync(SYNC_MAP_PATH, JSON.stringify(map, null, 2));
}

// Notion API helper
function notionRequest(method, endpoint, body, apiKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.notion.com',
      path: `/v1${endpoint}`,
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`Notion API error: ${json.message || data}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Convert local job to Notion properties
function jobToNotionProperties(job, status) {
  const props = {
    'Role': { title: [{ text: { content: job.role || '' } }] },
    'Company': { rich_text: [{ text: { content: job.company || '' } }] },
    'Status': { select: { name: status } },
    'URL': job.url ? { url: job.url } : { url: null },
  };

  if (job.stage) props['Stage'] = { select: { name: job.stage } };
  if (job.next) props['Next Action'] = { rich_text: [{ text: { content: job.next } }] };
  if (job.outcome) props['Outcome'] = { select: { name: job.outcome } };
  if (job.reason) props['Skip Reason'] = { rich_text: [{ text: { content: job.reason } }] };
  if (job.added) props['Added'] = { date: { start: job.added } };
  if (job.updated) props['Updated'] = { date: { start: job.updated } };
  if (job.closed) props['Closed'] = { date: { start: job.closed } };
  if (job.folder) props['Folder'] = { rich_text: [{ text: { content: job.folder } }] };

  return props;
}

// Convert local contact to Notion properties  
function contactToNotionProperties(contact) {
  const props = {
    'Name': { title: [{ text: { content: contact.name || '' } }] },
  };

  if (contact.company) props['Company'] = { rich_text: [{ text: { content: contact.company } }] };
  if (contact.title) props['Title'] = { rich_text: [{ text: { content: contact.title } }] };
  if (contact.email) props['Email'] = { email: contact.email };
  if (contact.linkedin) props['LinkedIn'] = { url: contact.linkedin };
  if (contact.source) props['Source'] = { rich_text: [{ text: { content: contact.source } }] };
  if (contact.added) props['Added'] = { date: { start: contact.added } };
  
  // Flatten interactions to notes
  if (contact.interactions?.length > 0) {
    const notes = contact.interactions.map(i => 
      `[${i.date}] ${i.type}: ${i.summary}`
    ).join('\n');
    props['Notes'] = { rich_text: [{ text: { content: notes.slice(0, 2000) } }] };
  }

  return props;
}

// Convert local task to Notion properties
function taskToNotionProperties(task) {
  const props = {
    'Task': { title: [{ text: { content: task.task || '' } }] },
    'Status': { select: { name: task.status === 'done' ? 'Done' : 'Pending' } },
  };

  if (task.due) props['Due'] = { date: { start: task.due } };
  if (task.created) props['Created'] = { date: { start: task.created } };

  return props;
}

// Create unique local ID for a job
function getJobLocalId(job, status) {
  return `${status}:${job.company}:${job.role}`;
}

// Sync jobs
async function syncJobs(config, syncMap) {
  const dbId = config.notion.databases.jobs;
  if (!dbId) {
    console.log('Skipping jobs sync: no database ID configured');
    return;
  }

  if (!fs.existsSync(TRACKER_PATH)) {
    console.log('No tracker.json found, skipping jobs sync');
    return;
  }

  const tracker = JSON.parse(fs.readFileSync(TRACKER_PATH, 'utf8'));
  let created = 0, updated = 0, errors = 0;

  // Process all job arrays
  const jobLists = [
    { jobs: tracker.active || [], status: 'Active' },
    { jobs: tracker.skipped || [], status: 'Skipped' },
    { jobs: tracker.closed || [], status: 'Closed' },
  ];

  for (const { jobs, status } of jobLists) {
    for (const job of jobs) {
      const localId = getJobLocalId(job, status);
      const notionId = syncMap.jobs[localId];
      const properties = jobToNotionProperties(job, status);

      try {
        if (DRY_RUN) {
          console.log(`[DRY-RUN] Would ${notionId ? 'update' : 'create'} job: ${job.company} - ${job.role}`);
          continue;
        }

        if (notionId) {
          // Update existing
          await notionRequest('PATCH', `/pages/${notionId}`, { properties }, config.notion.apiKey);
          updated++;
          console.log(`Updated: ${job.company} - ${job.role}`);
        } else {
          // Create new
          const result = await notionRequest('POST', '/pages', {
            parent: { database_id: dbId },
            properties,
          }, config.notion.apiKey);
          syncMap.jobs[localId] = result.id;
          created++;
          console.log(`Created: ${job.company} - ${job.role}`);
        }

        // Rate limit: ~3 req/sec
        await new Promise(r => setTimeout(r, 350));
      } catch (err) {
        console.error(`Error syncing ${job.company} - ${job.role}: ${err.message}`);
        errors++;
      }
    }
  }

  console.log(`\nJobs: ${created} created, ${updated} updated, ${errors} errors`);
}

// Sync contacts
async function syncContacts(config, syncMap) {
  const dbId = config.notion.databases.contacts;
  if (!dbId) {
    console.log('Skipping contacts sync: no database ID configured');
    return;
  }

  if (!fs.existsSync(NETWORK_PATH)) {
    console.log('No network.json found, skipping contacts sync');
    return;
  }

  const network = JSON.parse(fs.readFileSync(NETWORK_PATH, 'utf8'));
  const contacts = network.contacts || [];
  let created = 0, updated = 0, errors = 0;

  for (const contact of contacts) {
    const localId = contact.id || contact.name;
    const notionId = syncMap.contacts[localId];
    const properties = contactToNotionProperties(contact);

    try {
      if (DRY_RUN) {
        console.log(`[DRY-RUN] Would ${notionId ? 'update' : 'create'} contact: ${contact.name}`);
        continue;
      }

      if (notionId) {
        await notionRequest('PATCH', `/pages/${notionId}`, { properties }, config.notion.apiKey);
        updated++;
        console.log(`Updated: ${contact.name}`);
      } else {
        const result = await notionRequest('POST', '/pages', {
          parent: { database_id: dbId },
          properties,
        }, config.notion.apiKey);
        syncMap.contacts[localId] = result.id;
        created++;
        console.log(`Created: ${contact.name}`);
      }

      await new Promise(r => setTimeout(r, 350));
    } catch (err) {
      console.error(`Error syncing contact ${contact.name}: ${err.message}`);
      errors++;
    }
  }

  console.log(`\nContacts: ${created} created, ${updated} updated, ${errors} errors`);
}

// Sync tasks
async function syncTasks(config, syncMap) {
  const dbId = config.notion.databases.tasks;
  if (!dbId) {
    console.log('Skipping tasks sync: no database ID configured');
    return;
  }

  if (!fs.existsSync(TASKS_PATH)) {
    console.log('No tasks.json found, skipping tasks sync');
    return;
  }

  const tasksData = JSON.parse(fs.readFileSync(TASKS_PATH, 'utf8'));
  const tasks = tasksData.tasks || [];
  let created = 0, updated = 0, errors = 0;

  for (const task of tasks) {
    const localId = task.id || task.task;
    const notionId = syncMap.tasks[localId];
    const properties = taskToNotionProperties(task);

    try {
      if (DRY_RUN) {
        console.log(`[DRY-RUN] Would ${notionId ? 'update' : 'create'} task: ${task.task}`);
        continue;
      }

      if (notionId) {
        await notionRequest('PATCH', `/pages/${notionId}`, { properties }, config.notion.apiKey);
        updated++;
        console.log(`Updated: ${task.task.slice(0, 50)}...`);
      } else {
        const result = await notionRequest('POST', '/pages', {
          parent: { database_id: dbId },
          properties,
        }, config.notion.apiKey);
        syncMap.tasks[localId] = result.id;
        created++;
        console.log(`Created: ${task.task.slice(0, 50)}...`);
      }

      await new Promise(r => setTimeout(r, 350));
    } catch (err) {
      console.error(`Error syncing task: ${err.message}`);
      errors++;
    }
  }

  console.log(`\nTasks: ${created} created, ${updated} updated, ${errors} errors`);
}

// Main
async function main() {
  console.log('Ariadne → Notion Sync');
  console.log('='.repeat(40));
  if (DRY_RUN) console.log('[DRY RUN MODE - no changes will be made]\n');

  const config = loadConfig();
  const syncMap = loadSyncMap();

  console.log('\n📋 Syncing Jobs...');
  await syncJobs(config, syncMap);

  console.log('\n👥 Syncing Contacts...');
  await syncContacts(config, syncMap);

  console.log('\n✅ Syncing Tasks...');
  await syncTasks(config, syncMap);

  if (!DRY_RUN) {
    saveSyncMap(syncMap);
    console.log('\nSync complete. Mapping saved to data/.notion-sync-map.json');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
