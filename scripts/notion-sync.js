#!/usr/bin/env node
/**
 * notion-sync.js - Bidirectional incremental sync between Ariadne and Notion
 *
 * Pull-then-push flow. Local wins on conflicts.
 * Content hashing for local change detection, last_edited_time for Notion change detection.
 *
 * Usage:
 *   node scripts/notion-sync.js [flags]
 *
 * Flags:
 *   --dry-run        Preview changes without modifying anything
 *   --pull-only      Only pull Notion → local
 *   --push-only      Only push local → Notion (incremental)
 *   --full           Ignore hashes/timestamps, sync everything
 *   --apply-deletes  Archive Notion pages for locally-deleted items
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
const crypto = require('crypto');

// Paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const TRACKER_PATH = path.join(DATA_DIR, 'tracker.json');
const NETWORK_PATH = path.join(DATA_DIR, 'network.json');
const TASKS_PATH = path.join(DATA_DIR, 'tasks.json');
const SYNC_MAP_PATH = path.join(DATA_DIR, '.notion-sync-map.json');

const NOTION_VERSION = '2022-06-28';
const MAX_RETRIES = 3;

// Parse args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const PULL_ONLY = args.includes('--pull-only');
const PUSH_ONLY = args.includes('--push-only');
const FULL_SYNC = args.includes('--full');
const APPLY_DELETES = args.includes('--apply-deletes');

// ---------------------------------------------------------------------------
// Config & Sync Map
// ---------------------------------------------------------------------------

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

function loadSyncMap() {
  if (fs.existsSync(SYNC_MAP_PATH)) {
    const raw = JSON.parse(fs.readFileSync(SYNC_MAP_PATH, 'utf8'));
    return migrateSyncMap(raw);
  }
  return { lastSyncTime: null, jobs: {}, contacts: {}, tasks: {}, notionToLocal: {} };
}

function saveSyncMap(map) {
  fs.writeFileSync(SYNC_MAP_PATH, JSON.stringify(map, null, 2));
}

/**
 * Migrate flat sync map (old format: { jobs: { key: "pageId" } })
 * to enriched format ({ jobs: { key: { notionId, localHash, notionLastEdited } } }).
 */
function migrateSyncMap(raw) {
  // Already migrated if lastSyncTime key exists (even if null)
  if ('lastSyncTime' in raw) return raw;

  console.log('Migrating sync map to enriched format...');
  const migrated = {
    lastSyncTime: null,
    jobs: {},
    contacts: {},
    tasks: {},
    notionToLocal: {},
  };

  for (const entityType of ['jobs', 'contacts', 'tasks']) {
    const old = raw[entityType] || {};
    for (const [key, value] of Object.entries(old)) {
      if (typeof value === 'string') {
        // Old format: value is the Notion page ID
        migrated[entityType][key] = {
          notionId: value,
          localHash: null,
          notionLastEdited: null,
        };
        migrated.notionToLocal[value] = { type: entityType, key };
      } else {
        // Already enriched entry
        migrated[entityType][key] = value;
        if (value.notionId) {
          migrated.notionToLocal[value.notionId] = { type: entityType, key };
        }
      }
    }
  }

  return migrated;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function hashItem(item) {
  const sorted = JSON.stringify(item, Object.keys(item).sort());
  return crypto.createHash('sha256').update(sorted).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Notion API with retry
// ---------------------------------------------------------------------------

function notionRequest(method, endpoint, body, apiKey) {
  return notionRequestWithRetry(method, endpoint, body, apiKey, 0);
}

function notionRequestWithRetry(method, endpoint, body, apiKey, attempt) {
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
        if (res.statusCode === 429 && attempt < MAX_RETRIES) {
          const retryAfter = parseInt(res.headers['retry-after'] || '1', 10);
          const waitMs = retryAfter * 1000 + (attempt + 1) * 500;
          console.log(`  Rate limited, retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
          setTimeout(() => {
            notionRequestWithRetry(method, endpoint, body, apiKey, attempt + 1)
              .then(resolve).catch(reject);
          }, waitMs);
          return;
        }
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`Notion API error (${res.statusCode}): ${json.message || data}`));
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

// ---------------------------------------------------------------------------
// Fetch changed pages from Notion (with pagination)
// ---------------------------------------------------------------------------

async function fetchChangedPages(dbId, apiKey, since) {
  const pages = [];
  let startCursor = undefined;

  const filter = since ? {
    timestamp: 'last_edited_time',
    last_edited_time: { after: since },
  } : undefined;

  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (startCursor) body.start_cursor = startCursor;

    const result = await notionRequest('POST', `/databases/${dbId}/query`, body, apiKey);
    pages.push(...result.results);
    startCursor = result.has_more ? result.next_cursor : undefined;

    if (result.has_more) await new Promise(r => setTimeout(r, 350));
  } while (startCursor);

  return pages;
}

// ---------------------------------------------------------------------------
// Fetch ALL pages from Notion (for baseline / full sync)
// ---------------------------------------------------------------------------

async function fetchAllPages(dbId, apiKey) {
  return fetchChangedPages(dbId, apiKey, null);
}

// ---------------------------------------------------------------------------
// Schema management (unchanged from Phase 1)
// ---------------------------------------------------------------------------

async function ensureSchemas(config) {
  const apiKey = config.notion.apiKey;
  const dbs = config.notion.databases;

  if (dbs.jobs) {
    console.log('Checking Jobs DB schema...');
    const db = await notionRequest('GET', `/databases/${dbs.jobs}`, null, apiKey);
    const existing = new Set(Object.keys(db.properties || {}));
    if (existing.has('Name') && !existing.has('Role')) {
      console.log('  Renaming title property: Name → Role');
      await notionRequest('PATCH', `/databases/${dbs.jobs}`, {
        properties: { 'Name': { name: 'Role' } }
      }, apiKey);
      existing.delete('Name');
      existing.add('Role');
    }
    const needed = {
      'Company': { rich_text: {} },
      'Status': { select: { options: [{ name: 'Active', color: 'green' }, { name: 'Skipped', color: 'gray' }, { name: 'Closed', color: 'red' }] } },
      'Stage': { select: { options: [{ name: 'Sourced' }, { name: 'Applied' }, { name: 'Phone Screen' }, { name: 'Technical' }, { name: 'Onsite' }, { name: 'Offer' }, { name: 'Negotiating' }] } },
      'URL': { url: {} },
      'Next Action': { rich_text: {} },
      'Outcome': { select: { options: [{ name: 'Rejected' }, { name: 'Withdrew' }, { name: 'Accepted' }, { name: 'Expired' }] } },
      'Skip Reason': { rich_text: {} },
      'Added': { date: {} },
      'Updated': { date: {} },
      'Closed': { date: {} },
      'Folder': { rich_text: {} },
    };
    const toCreate = {};
    for (const [name, schema] of Object.entries(needed)) {
      if (!existing.has(name)) toCreate[name] = schema;
    }
    if (Object.keys(toCreate).length > 0) {
      console.log(`  Creating properties: ${Object.keys(toCreate).join(', ')}`);
      await notionRequest('PATCH', `/databases/${dbs.jobs}`, { properties: toCreate }, apiKey);
    } else {
      console.log('  Schema OK');
    }
  }

  if (dbs.contacts) {
    console.log('Checking Contacts DB schema...');
    const db = await notionRequest('GET', `/databases/${dbs.contacts}`, null, apiKey);
    const existing = new Set(Object.keys(db.properties || {}));
    const needed = {
      'Company': { rich_text: {} },
      'Title': { rich_text: {} },
      'Email': { email: {} },
      'LinkedIn': { url: {} },
      'Source': { rich_text: {} },
      'Added': { date: {} },
      'Notes': { rich_text: {} },
    };
    const toCreate = {};
    for (const [name, schema] of Object.entries(needed)) {
      if (!existing.has(name)) toCreate[name] = schema;
    }
    if (Object.keys(toCreate).length > 0) {
      console.log(`  Creating properties: ${Object.keys(toCreate).join(', ')}`);
      await notionRequest('PATCH', `/databases/${dbs.contacts}`, { properties: toCreate }, apiKey);
    } else {
      console.log('  Schema OK');
    }
  }

  if (dbs.tasks) {
    console.log('Checking Tasks DB schema...');
    const db = await notionRequest('GET', `/databases/${dbs.tasks}`, null, apiKey);
    const existing = new Set(Object.keys(db.properties || {}));
    if (existing.has('Name') && !existing.has('Task')) {
      console.log('  Renaming title property: Name → Task');
      await notionRequest('PATCH', `/databases/${dbs.tasks}`, {
        properties: { 'Name': { name: 'Task' } }
      }, apiKey);
      existing.delete('Name');
      existing.add('Task');
    }
    const needed = {
      'Done': { checkbox: {} },
      'Due': { date: {} },
      'Created': { date: {} },
    };
    const toCreate = {};
    for (const [name, schema] of Object.entries(needed)) {
      if (!existing.has(name)) toCreate[name] = schema;
    }
    if (Object.keys(toCreate).length > 0) {
      console.log(`  Creating properties: ${Object.keys(toCreate).join(', ')}`);
      await notionRequest('PATCH', `/databases/${dbs.tasks}`, { properties: toCreate }, apiKey);
    } else {
      console.log('  Schema OK');
    }
  }

  console.log('');
}

// ---------------------------------------------------------------------------
// Local → Notion property converters (push direction)
// ---------------------------------------------------------------------------

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

  if (contact.interactions?.length > 0) {
    const notes = contact.interactions.map(i =>
      `[${i.date}] ${i.type}: ${i.summary}`
    ).join('\n');
    props['Notes'] = { rich_text: [{ text: { content: notes.slice(0, 2000) } }] };
  }

  return props;
}

function taskToNotionProperties(task) {
  const props = {
    'Task': { title: [{ text: { content: task.task || '' } }] },
    'Done': { checkbox: task.status === 'completed' },
  };

  if (task.due) props['Due'] = { date: { start: task.due } };
  if (task.created) props['Created'] = { date: { start: task.created } };

  return props;
}

// ---------------------------------------------------------------------------
// Notion → Local property converters (pull direction)
// ---------------------------------------------------------------------------

function getNotionText(prop) {
  if (!prop) return '';
  if (prop.type === 'title') return (prop.title || []).map(t => t.plain_text).join('');
  if (prop.type === 'rich_text') return (prop.rich_text || []).map(t => t.plain_text).join('');
  return '';
}

function getNotionSelect(prop) {
  if (!prop || prop.type !== 'select' || !prop.select) return null;
  return prop.select.name;
}

function getNotionDate(prop) {
  if (!prop || prop.type !== 'date' || !prop.date) return null;
  return prop.date.start || null;
}

function getNotionCheckbox(prop) {
  if (!prop || prop.type !== 'checkbox') return false;
  return prop.checkbox;
}

function getNotionUrl(prop) {
  if (!prop || prop.type !== 'url') return null;
  return prop.url;
}

function getNotionEmail(prop) {
  if (!prop || prop.type !== 'email') return null;
  return prop.email;
}

function notionPropertiesToJob(properties) {
  const p = properties;
  const job = {
    company: getNotionText(p['Company']),
    role: getNotionText(p['Role']),
    url: getNotionUrl(p['URL']),
    added: getNotionDate(p['Added']),
    updated: getNotionDate(p['Updated']),
  };
  const stage = getNotionSelect(p['Stage']);
  if (stage) job.stage = stage;
  const next = getNotionText(p['Next Action']);
  if (next) job.next = next;
  const outcome = getNotionSelect(p['Outcome']);
  if (outcome) job.outcome = outcome;
  const reason = getNotionText(p['Skip Reason']);
  if (reason) job.reason = reason;
  const closed = getNotionDate(p['Closed']);
  if (closed) job.closed = closed;
  const folder = getNotionText(p['Folder']);
  if (folder) job.folder = folder;

  const status = getNotionSelect(p['Status']) || 'Active';
  return { job, status };
}

function notionPropertiesToContact(properties, existingContact) {
  const p = properties;
  const contact = {
    id: existingContact?.id || null,
    name: getNotionText(p['Name']),
    company: getNotionText(p['Company']) || null,
    title: getNotionText(p['Title']) || null,
    email: getNotionEmail(p['Email']) || null,
    linkedin: getNotionUrl(p['LinkedIn']) || null,
    source: getNotionText(p['Source']) || null,
    introducedBy: existingContact?.introducedBy || null,
    added: getNotionDate(p['Added']) || existingContact?.added || new Date().toISOString().slice(0, 10),
    interactions: existingContact?.interactions || [],
  };

  // Generate id from name if not existing
  if (!contact.id) {
    contact.id = contact.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  }

  // Append-only merge of interactions from Notes field
  const notesText = getNotionText(p['Notes']);
  if (notesText) {
    contact.interactions = mergeInteractions(contact.interactions, notesText);
  }

  return contact;
}

function notionPropertiesToTask(properties, existingTask) {
  const p = properties;
  const done = getNotionCheckbox(p['Done']);
  const task = {
    id: existingTask?.id || null,
    task: getNotionText(p['Task']),
    due: getNotionDate(p['Due']) || null,
    linkedContacts: existingTask?.linkedContacts || [],
    linkedJobs: existingTask?.linkedJobs || [],
    status: done ? 'completed' : 'pending',
    created: getNotionDate(p['Created']) || existingTask?.created || new Date().toISOString().slice(0, 10),
  };

  if (done && !task.completed) {
    task.completed = existingTask?.completed || new Date().toISOString().slice(0, 10);
  }

  // Generate id if not existing
  if (!task.id) {
    task.id = `task-${Date.now().toString(36)}`;
  }

  return task;
}

// ---------------------------------------------------------------------------
// Interaction parsing & merge
// ---------------------------------------------------------------------------

/**
 * Parse `[date] type: summary` lines from Notion Notes field.
 * Only matches complete lines to safely ignore truncated content.
 */
function parseInteractionsFromNotes(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const interactions = [];
  const pattern = /^\[(\d{4}-\d{2}-\d{2})\]\s+(\w+):\s+(.+)$/;

  for (const line of lines) {
    const match = line.trim().match(pattern);
    if (match) {
      interactions.push({
        date: match[1],
        type: match[2],
        summary: match[3],
      });
    }
  }
  return interactions;
}

/**
 * Append-only merge: add interactions from Notes that don't already exist locally.
 * Match on date + type + summary to detect duplicates.
 */
function mergeInteractions(existing, notesText) {
  const parsed = parseInteractionsFromNotes(notesText);
  if (parsed.length === 0) return existing;

  const existingKeys = new Set(
    existing.map(i => `${i.date}|${i.type}|${i.summary}`)
  );

  const merged = [...existing];
  for (const interaction of parsed) {
    const key = `${interaction.date}|${interaction.type}|${interaction.summary}`;
    if (!existingKeys.has(key)) {
      merged.push(interaction);
      existingKeys.add(key);
    }
  }

  // Sort by date
  merged.sort((a, b) => a.date.localeCompare(b.date));
  return merged;
}

// ---------------------------------------------------------------------------
// Job local ID helpers
// ---------------------------------------------------------------------------

function getJobLocalId(job, status) {
  return `${status}:${job.company}:${job.role}`;
}

/**
 * Find a job in tracker by composite key (Status:Company:Role).
 * Returns { arrayName, index, job } or null.
 */
function findJobInTracker(tracker, localKey) {
  const [status, company, role] = localKey.split(':');
  const arrayMap = { 'Active': 'active', 'Skipped': 'skipped', 'Closed': 'closed' };
  const arrayName = arrayMap[status];
  if (!arrayName) return null;

  const arr = tracker[arrayName] || [];
  const index = arr.findIndex(j => j.company === company && j.role === role);
  if (index === -1) return null;
  return { arrayName, index, job: arr[index] };
}

/**
 * Stage-to-directory mapping for folder moves.
 */
function stageToDirectory(stage, status) {
  if (status === 'Closed' || status === 'Rejected' || status === 'Withdrew' || status === 'Expired') {
    return 'Rejected';
  }
  if (!stage || stage === 'Sourced') return 'InProgress';
  return 'Applied';
}

// ---------------------------------------------------------------------------
// PULL: Notion → Local
// ---------------------------------------------------------------------------

async function pullJobs(config, syncMap, tracker) {
  const dbId = config.notion.databases.jobs;
  if (!dbId) return { pulled: 0, skipped: 0 };

  const isBaseline = !syncMap.lastSyncTime;
  const pages = FULL_SYNC || isBaseline
    ? await fetchAllPages(dbId, config.notion.apiKey)
    : await fetchChangedPages(dbId, config.notion.apiKey, syncMap.lastSyncTime);

  let pulled = 0, skipped = 0;

  for (const page of pages) {
    const pageId = page.id;
    const pageEdited = page.last_edited_time;
    const { job: notionJob, status: notionStatus } = notionPropertiesToJob(page.properties);
    const notionLocalKey = getJobLocalId(notionJob, notionStatus);

    // Look up by reverse map first (handles status changes in Notion)
    const reverseEntry = syncMap.notionToLocal[pageId];
    const existingKey = reverseEntry?.type === 'jobs' ? reverseEntry.key : null;
    const syncEntry = existingKey ? syncMap.jobs[existingKey] : null;

    if (isBaseline && syncEntry) {
      // Baseline: record Notion timestamps but don't overwrite local data
      syncEntry.notionLastEdited = pageEdited;
      skipped++;
      continue;
    }

    if (syncEntry) {
      // Known item — check if both changed
      const currentHash = syncEntry.localHash;
      const notionChanged = !syncEntry.notionLastEdited || pageEdited > syncEntry.notionLastEdited;

      if (!notionChanged && !FULL_SYNC) {
        skipped++;
        continue;
      }

      // Check if local also changed (will be detected in push phase)
      // If local changed too, skip pull (local wins)
      if (currentHash) {
        const found = findJobInTracker(tracker, existingKey);
        if (found) {
          const freshHash = hashItem(found.job);
          if (freshHash !== currentHash) {
            // Both changed — local wins, skip pull
            console.log(`  Conflict (local wins): ${notionJob.company} - ${notionJob.role}`);
            syncEntry.notionLastEdited = pageEdited;
            skipped++;
            continue;
          }
        }
      }

      // Only Notion changed — apply to local
      if (DRY_RUN) {
        console.log(`  [DRY-RUN] Would pull update: ${notionJob.company} - ${notionJob.role}`);
        skipped++;
        continue;
      }

      // Handle status change (may need to move between arrays)
      if (existingKey !== notionLocalKey) {
        // Status changed in Notion — move job between arrays
        const found = findJobInTracker(tracker, existingKey);
        if (found) {
          tracker[found.arrayName].splice(found.index, 1);
        }
        // Handle folder move
        const oldDir = found?.job?.folder;
        const newDirName = stageToDirectory(notionJob.stage, notionStatus);
        if (notionJob.folder || oldDir) {
          const baseName = path.basename(oldDir || notionJob.folder || `${notionJob.company} - ${notionJob.role}`);
          const newFolder = path.join('data', newDirName, baseName);
          if (oldDir && fs.existsSync(path.join(DATA_DIR, '..', oldDir))) {
            const newPath = path.join(DATA_DIR, '..', newFolder);
            fs.mkdirSync(path.dirname(newPath), { recursive: true });
            if (oldDir !== newFolder) {
              fs.renameSync(path.join(DATA_DIR, '..', oldDir), newPath);
              console.log(`  Moved folder: ${oldDir} → ${newFolder}`);
            }
          }
          notionJob.folder = newFolder;
        }

        // Add to correct array
        const arrayMap = { 'Active': 'active', 'Skipped': 'skipped', 'Closed': 'closed' };
        const targetArray = arrayMap[notionStatus] || 'active';
        tracker[targetArray].push(notionJob);

        // Update sync map keys
        delete syncMap.jobs[existingKey];
        syncMap.jobs[notionLocalKey] = {
          notionId: pageId,
          localHash: hashItem(notionJob),
          notionLastEdited: pageEdited,
          company: notionJob.company,
          role: notionJob.role,
        };
        syncMap.notionToLocal[pageId] = { type: 'jobs', key: notionLocalKey };
      } else {
        // Same status — update in place
        const found = findJobInTracker(tracker, existingKey);
        if (found) {
          tracker[found.arrayName][found.index] = notionJob;
        }
        syncEntry.localHash = hashItem(notionJob);
        syncEntry.notionLastEdited = pageEdited;
      }

      pulled++;
      console.log(`  Pulled: ${notionJob.company} - ${notionJob.role}`);
    } else {
      // Unknown page — new item from Notion
      if (isBaseline) {
        // Don't add new items during baseline, just record mapping
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  [DRY-RUN] Would pull new: ${notionJob.company} - ${notionJob.role}`);
        skipped++;
        continue;
      }

      const arrayMap = { 'Active': 'active', 'Skipped': 'skipped', 'Closed': 'closed' };
      const targetArray = arrayMap[notionStatus] || 'active';
      if (!notionJob.added) notionJob.added = new Date().toISOString().slice(0, 10);
      if (notionStatus === 'Active' && !notionJob.updated) notionJob.updated = new Date().toISOString().slice(0, 10);
      tracker[targetArray].push(notionJob);

      syncMap.jobs[notionLocalKey] = {
        notionId: pageId,
        localHash: hashItem(notionJob),
        notionLastEdited: pageEdited,
        company: notionJob.company,
        role: notionJob.role,
      };
      syncMap.notionToLocal[pageId] = { type: 'jobs', key: notionLocalKey };

      pulled++;
      console.log(`  Pulled new: ${notionJob.company} - ${notionJob.role}`);
    }
  }

  return { pulled, skipped };
}

async function pullContacts(config, syncMap, network) {
  const dbId = config.notion.databases.contacts;
  if (!dbId) return { pulled: 0, skipped: 0 };

  const isBaseline = !syncMap.lastSyncTime;
  const pages = FULL_SYNC || isBaseline
    ? await fetchAllPages(dbId, config.notion.apiKey)
    : await fetchChangedPages(dbId, config.notion.apiKey, syncMap.lastSyncTime);

  let pulled = 0, skipped = 0;
  const contacts = network.contacts || [];

  for (const page of pages) {
    const pageId = page.id;
    const pageEdited = page.last_edited_time;

    const reverseEntry = syncMap.notionToLocal[pageId];
    const existingKey = reverseEntry?.type === 'contacts' ? reverseEntry.key : null;
    const syncEntry = existingKey ? syncMap.contacts[existingKey] : null;
    const existingContact = existingKey ? contacts.find(c => (c.id || c.name) === existingKey) : null;

    if (isBaseline && syncEntry) {
      syncEntry.notionLastEdited = pageEdited;
      skipped++;
      continue;
    }

    if (syncEntry) {
      const notionChanged = !syncEntry.notionLastEdited || pageEdited > syncEntry.notionLastEdited;
      if (!notionChanged && !FULL_SYNC) { skipped++; continue; }

      // Check local change
      if (syncEntry.localHash && existingContact) {
        const freshHash = hashItem(existingContact);
        if (freshHash !== syncEntry.localHash) {
          console.log(`  Conflict (local wins): ${existingContact.name}`);
          syncEntry.notionLastEdited = pageEdited;
          skipped++;
          continue;
        }
      }

      if (DRY_RUN) {
        console.log(`  [DRY-RUN] Would pull update: ${getNotionText(page.properties['Name'])}`);
        skipped++;
        continue;
      }

      const updated = notionPropertiesToContact(page.properties, existingContact);
      const idx = contacts.findIndex(c => (c.id || c.name) === existingKey);
      if (idx !== -1) contacts[idx] = updated;

      syncEntry.localHash = hashItem(updated);
      syncEntry.notionLastEdited = pageEdited;
      pulled++;
      console.log(`  Pulled: ${updated.name}`);
    } else {
      if (isBaseline) { skipped++; continue; }

      if (DRY_RUN) {
        console.log(`  [DRY-RUN] Would pull new contact: ${getNotionText(page.properties['Name'])}`);
        skipped++;
        continue;
      }

      const newContact = notionPropertiesToContact(page.properties, null);
      contacts.push(newContact);
      const localId = newContact.id || newContact.name;

      syncMap.contacts[localId] = {
        notionId: pageId,
        localHash: hashItem(newContact),
        notionLastEdited: pageEdited,
      };
      syncMap.notionToLocal[pageId] = { type: 'contacts', key: localId };

      pulled++;
      console.log(`  Pulled new: ${newContact.name}`);
    }
  }

  network.contacts = contacts;
  return { pulled, skipped };
}

async function pullTasks(config, syncMap, tasksData) {
  const dbId = config.notion.databases.tasks;
  if (!dbId) return { pulled: 0, skipped: 0 };

  const isBaseline = !syncMap.lastSyncTime;
  const pages = FULL_SYNC || isBaseline
    ? await fetchAllPages(dbId, config.notion.apiKey)
    : await fetchChangedPages(dbId, config.notion.apiKey, syncMap.lastSyncTime);

  let pulled = 0, skipped = 0;
  const tasks = tasksData.tasks || [];

  for (const page of pages) {
    const pageId = page.id;
    const pageEdited = page.last_edited_time;

    const reverseEntry = syncMap.notionToLocal[pageId];
    const existingKey = reverseEntry?.type === 'tasks' ? reverseEntry.key : null;
    const syncEntry = existingKey ? syncMap.tasks[existingKey] : null;
    const existingTask = existingKey ? tasks.find(t => t.id === existingKey) : null;

    if (isBaseline && syncEntry) {
      syncEntry.notionLastEdited = pageEdited;
      skipped++;
      continue;
    }

    if (syncEntry) {
      const notionChanged = !syncEntry.notionLastEdited || pageEdited > syncEntry.notionLastEdited;
      if (!notionChanged && !FULL_SYNC) { skipped++; continue; }

      if (syncEntry.localHash && existingTask) {
        const freshHash = hashItem(existingTask);
        if (freshHash !== syncEntry.localHash) {
          console.log(`  Conflict (local wins): ${existingTask.task?.slice(0, 50)}`);
          syncEntry.notionLastEdited = pageEdited;
          skipped++;
          continue;
        }
      }

      if (DRY_RUN) {
        console.log(`  [DRY-RUN] Would pull update: ${getNotionText(page.properties['Task'])?.slice(0, 50)}`);
        skipped++;
        continue;
      }

      const updated = notionPropertiesToTask(page.properties, existingTask);
      const idx = tasks.findIndex(t => t.id === existingKey);
      if (idx !== -1) tasks[idx] = updated;

      syncEntry.localHash = hashItem(updated);
      syncEntry.notionLastEdited = pageEdited;
      pulled++;
      console.log(`  Pulled: ${updated.task?.slice(0, 50)}`);
    } else {
      if (isBaseline) { skipped++; continue; }

      if (DRY_RUN) {
        console.log(`  [DRY-RUN] Would pull new task: ${getNotionText(page.properties['Task'])?.slice(0, 50)}`);
        skipped++;
        continue;
      }

      const newTask = notionPropertiesToTask(page.properties, null);
      tasks.push(newTask);
      const localId = newTask.id;

      syncMap.tasks[localId] = {
        notionId: pageId,
        localHash: hashItem(newTask),
        notionLastEdited: pageEdited,
      };
      syncMap.notionToLocal[pageId] = { type: 'tasks', key: localId };

      pulled++;
      console.log(`  Pulled new: ${newTask.task?.slice(0, 50)}`);
    }
  }

  tasksData.tasks = tasks;
  return { pulled, skipped };
}

// ---------------------------------------------------------------------------
// PUSH: Local → Notion (incremental)
// ---------------------------------------------------------------------------

async function pushJobs(config, syncMap, tracker) {
  const dbId = config.notion.databases.jobs;
  if (!dbId) {
    console.log('Skipping jobs push: no database ID configured');
    return;
  }

  let created = 0, updated = 0, unchanged = 0, errors = 0;

  const jobLists = [
    { jobs: tracker.active || [], status: 'Active' },
    { jobs: tracker.skipped || [], status: 'Skipped' },
    { jobs: tracker.closed || [], status: 'Closed' },
  ];

  // Track which local keys still exist (for deletion detection)
  const localKeys = new Set();

  for (const { jobs, status } of jobLists) {
    for (const job of jobs) {
      const localId = getJobLocalId(job, status);
      localKeys.add(localId);
      const syncEntry = syncMap.jobs[localId];
      const currentHash = hashItem(job);

      // Skip if unchanged (unless --full)
      if (!FULL_SYNC && syncEntry?.localHash === currentHash && syncEntry.notionId) {
        unchanged++;
        continue;
      }

      const properties = jobToNotionProperties(job, status);
      const notionId = syncEntry?.notionId;

      try {
        if (DRY_RUN) {
          console.log(`  [DRY-RUN] Would ${notionId ? 'update' : 'create'} job: ${job.company} - ${job.role}`);
          continue;
        }

        if (notionId) {
          const result = await notionRequest('PATCH', `/pages/${notionId}`, { properties }, config.notion.apiKey);
          if (!syncMap.jobs[localId]) syncMap.jobs[localId] = {};
          syncMap.jobs[localId].notionId = notionId;
          syncMap.jobs[localId].localHash = currentHash;
          syncMap.jobs[localId].notionLastEdited = result.last_edited_time;
          syncMap.jobs[localId].company = job.company;
          syncMap.jobs[localId].role = job.role;
          updated++;
          console.log(`  Updated: ${job.company} - ${job.role}`);
        } else {
          const result = await notionRequest('POST', '/pages', {
            parent: { database_id: dbId },
            properties,
          }, config.notion.apiKey);
          syncMap.jobs[localId] = {
            notionId: result.id,
            localHash: currentHash,
            notionLastEdited: result.last_edited_time,
            company: job.company,
            role: job.role,
          };
          syncMap.notionToLocal[result.id] = { type: 'jobs', key: localId };
          created++;
          console.log(`  Created: ${job.company} - ${job.role}`);
        }

        await new Promise(r => setTimeout(r, 350));
      } catch (err) {
        console.error(`  Error syncing ${job.company} - ${job.role}: ${err.message}`);
        errors++;
      }
    }
  }

  // Detect deletions
  const deletions = detectLocalDeletions(syncMap, 'jobs', localKeys);
  if (deletions.length > 0) {
    await handleDeletions(deletions, 'jobs', config, syncMap);
  }

  console.log(`  Jobs: ${created} created, ${updated} updated, ${unchanged} unchanged, ${errors} errors`);
}

async function pushContacts(config, syncMap, network) {
  const dbId = config.notion.databases.contacts;
  if (!dbId) {
    console.log('Skipping contacts push: no database ID configured');
    return;
  }

  const contacts = network.contacts || [];
  let created = 0, updated = 0, unchanged = 0, errors = 0;

  const localKeys = new Set();

  for (const contact of contacts) {
    const localId = contact.id || contact.name;
    localKeys.add(localId);
    const syncEntry = syncMap.contacts[localId];
    const currentHash = hashItem(contact);

    if (!FULL_SYNC && syncEntry?.localHash === currentHash && syncEntry.notionId) {
      unchanged++;
      continue;
    }

    const properties = contactToNotionProperties(contact);
    const notionId = syncEntry?.notionId;

    try {
      if (DRY_RUN) {
        console.log(`  [DRY-RUN] Would ${notionId ? 'update' : 'create'} contact: ${contact.name}`);
        continue;
      }

      if (notionId) {
        const result = await notionRequest('PATCH', `/pages/${notionId}`, { properties }, config.notion.apiKey);
        if (!syncMap.contacts[localId]) syncMap.contacts[localId] = {};
        syncMap.contacts[localId].notionId = notionId;
        syncMap.contacts[localId].localHash = currentHash;
        syncMap.contacts[localId].notionLastEdited = result.last_edited_time;
        updated++;
        console.log(`  Updated: ${contact.name}`);
      } else {
        const result = await notionRequest('POST', '/pages', {
          parent: { database_id: dbId },
          properties,
        }, config.notion.apiKey);
        syncMap.contacts[localId] = {
          notionId: result.id,
          localHash: currentHash,
          notionLastEdited: result.last_edited_time,
        };
        syncMap.notionToLocal[result.id] = { type: 'contacts', key: localId };
        created++;
        console.log(`  Created: ${contact.name}`);
      }

      await new Promise(r => setTimeout(r, 350));
    } catch (err) {
      console.error(`  Error syncing contact ${contact.name}: ${err.message}`);
      errors++;
    }
  }

  const deletions = detectLocalDeletions(syncMap, 'contacts', localKeys);
  if (deletions.length > 0) {
    await handleDeletions(deletions, 'contacts', config, syncMap);
  }

  console.log(`  Contacts: ${created} created, ${updated} updated, ${unchanged} unchanged, ${errors} errors`);
}

async function pushTasks(config, syncMap, tasksData) {
  const dbId = config.notion.databases.tasks;
  if (!dbId) {
    console.log('Skipping tasks push: no database ID configured');
    return;
  }

  const tasks = tasksData.tasks || [];
  let created = 0, updated = 0, unchanged = 0, errors = 0;

  const localKeys = new Set();

  for (const task of tasks) {
    const localId = task.id || task.task;
    localKeys.add(localId);
    const syncEntry = syncMap.tasks[localId];
    const currentHash = hashItem(task);

    if (!FULL_SYNC && syncEntry?.localHash === currentHash && syncEntry.notionId) {
      unchanged++;
      continue;
    }

    const properties = taskToNotionProperties(task);
    const notionId = syncEntry?.notionId;

    try {
      if (DRY_RUN) {
        console.log(`  [DRY-RUN] Would ${notionId ? 'update' : 'create'} task: ${task.task?.slice(0, 50)}`);
        continue;
      }

      if (notionId) {
        const result = await notionRequest('PATCH', `/pages/${notionId}`, { properties }, config.notion.apiKey);
        if (!syncMap.tasks[localId]) syncMap.tasks[localId] = {};
        syncMap.tasks[localId].notionId = notionId;
        syncMap.tasks[localId].localHash = currentHash;
        syncMap.tasks[localId].notionLastEdited = result.last_edited_time;
        updated++;
        console.log(`  Updated: ${task.task?.slice(0, 50)}`);
      } else {
        const result = await notionRequest('POST', '/pages', {
          parent: { database_id: dbId },
          properties,
        }, config.notion.apiKey);
        syncMap.tasks[localId] = {
          notionId: result.id,
          localHash: currentHash,
          notionLastEdited: result.last_edited_time,
        };
        syncMap.notionToLocal[result.id] = { type: 'tasks', key: localId };
        created++;
        console.log(`  Created: ${task.task?.slice(0, 50)}`);
      }

      await new Promise(r => setTimeout(r, 350));
    } catch (err) {
      console.error(`  Error syncing task: ${err.message}`);
      errors++;
    }
  }

  const deletions = detectLocalDeletions(syncMap, 'tasks', localKeys);
  if (deletions.length > 0) {
    await handleDeletions(deletions, 'tasks', config, syncMap);
  }

  console.log(`  Tasks: ${created} created, ${updated} updated, ${unchanged} unchanged, ${errors} errors`);
}

// ---------------------------------------------------------------------------
// Deletion detection & handling
// ---------------------------------------------------------------------------

/**
 * Find sync map entries that no longer exist in local data.
 */
function detectLocalDeletions(syncMap, entityType, currentLocalKeys) {
  const deletions = [];
  for (const [key, entry] of Object.entries(syncMap[entityType] || {})) {
    if (!currentLocalKeys.has(key) && entry.notionId) {
      deletions.push({ key, notionId: entry.notionId });
    }
  }
  return deletions;
}

async function handleDeletions(deletions, entityType, config, syncMap) {
  if (deletions.length === 0) return;

  if (APPLY_DELETES) {
    for (const { key, notionId } of deletions) {
      try {
        if (DRY_RUN) {
          console.log(`  [DRY-RUN] Would archive ${entityType} in Notion: ${key}`);
          continue;
        }
        await notionRequest('PATCH', `/pages/${notionId}`, { archived: true }, config.notion.apiKey);
        console.log(`  Archived in Notion: ${key}`);
        // Clean up sync map
        delete syncMap[entityType][key];
        delete syncMap.notionToLocal[notionId];
        await new Promise(r => setTimeout(r, 350));
      } catch (err) {
        console.error(`  Error archiving ${key}: ${err.message}`);
      }
    }
  } else {
    console.log(`  ⚠ ${deletions.length} ${entityType} deleted locally but still in Notion:`);
    for (const { key } of deletions) {
      console.log(`    - ${key}`);
    }
    console.log(`    Use --apply-deletes to archive them in Notion`);
  }
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

function loadJSON(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Ariadne ↔ Notion Sync');
  console.log('='.repeat(40));
  const flags = [];
  if (DRY_RUN) flags.push('DRY RUN');
  if (PULL_ONLY) flags.push('PULL ONLY');
  if (PUSH_ONLY) flags.push('PUSH ONLY');
  if (FULL_SYNC) flags.push('FULL');
  if (APPLY_DELETES) flags.push('APPLY DELETES');
  if (flags.length) console.log(`[${flags.join(' | ')}]\n`);

  const config = loadConfig();
  const syncMap = loadSyncMap();
  const isBaseline = !syncMap.lastSyncTime;

  if (isBaseline) {
    console.log('First sync detected — running baseline (recording mappings, no local overwrites)\n');
  }

  console.log('Ensuring database schemas...');
  await ensureSchemas(config);

  // Load local data
  const tracker = loadJSON(TRACKER_PATH, { active: [], skipped: [], closed: [] });
  const network = loadJSON(NETWORK_PATH, { contacts: [] });
  const tasksData = loadJSON(TASKS_PATH, { tasks: [] });

  let localDataChanged = false;

  // PULL phase
  if (!PUSH_ONLY) {
    console.log('PULL: Notion → Local');
    console.log('-'.repeat(30));

    console.log('Jobs:');
    const jobPull = await pullJobs(config, syncMap, tracker);
    console.log('Contacts:');
    const contactPull = await pullContacts(config, syncMap, network);
    console.log('Tasks:');
    const taskPull = await pullTasks(config, syncMap, tasksData);

    const totalPulled = jobPull.pulled + contactPull.pulled + taskPull.pulled;
    console.log(`\nPull summary: ${totalPulled} items updated locally\n`);

    if (totalPulled > 0 && !DRY_RUN) {
      localDataChanged = true;
    }
  }

  // Save pulled changes to local files before push
  if (localDataChanged) {
    saveJSON(TRACKER_PATH, tracker);
    saveJSON(NETWORK_PATH, network);
    saveJSON(TASKS_PATH, tasksData);
    console.log('Local files updated.\n');
  }

  // PUSH phase
  if (!PULL_ONLY) {
    console.log('PUSH: Local → Notion');
    console.log('-'.repeat(30));

    await pushJobs(config, syncMap, tracker);
    await pushContacts(config, syncMap, network);
    await pushTasks(config, syncMap, tasksData);
    console.log('');
  }

  // Update sync time and save
  if (!DRY_RUN) {
    syncMap.lastSyncTime = new Date().toISOString();
    saveSyncMap(syncMap);
    console.log(`Sync complete. Last sync: ${syncMap.lastSyncTime}`);
    console.log('Mapping saved to data/.notion-sync-map.json');
  } else {
    console.log('Dry run complete. No changes made.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
