# Notion Sync

Bidirectional incremental sync between your Ariadne job search data and Notion databases.

## Overview

The Notion sync provides **bidirectional synchronization** between your local Ariadne files and Notion databases. Pull-then-push flow with local-wins conflict resolution.

- **Pull:** Notion changes (new items, edits) are applied to local JSON files
- **Push:** Local changes are pushed to Notion, skipping unchanged items via content hashing
- **Conflicts:** When both sides change the same item, local wins
- **First sync:** Baseline mode — records mappings and timestamps without overwriting local data

Typical API usage: ~6 calls when nothing changed, full bidirectional sync only touches changed items.

## Setup

### 1. Create a Notion Integration

1. Go to [notion.so/my-integrations](https://notion.so/my-integrations)
2. Click "New integration"
3. Name it (e.g., "Ariadne Sync")
4. Copy the API key (starts with `ntn_` or `secret_`)

### 2. Create Databases in Notion

Create three databases in Notion. The sync script will automatically create missing properties and rename the default title column, but here's the expected schema for reference:

**Jobs Database:**
- Role (title)
- Company (text)
- Status (select: Active, Skipped, Closed)
- Stage (select: Sourced, Applied, Phone Screen, Technical, Onsite, Offer, Negotiating)
- Next Action (text)
- Outcome (select: Rejected, Withdrew, Accepted, Expired)
- Skip Reason (text)
- URL (url)
- Added (date)
- Updated (date)
- Closed (date)
- Folder (text)

**Contacts Database:**
- Name (title)
- Company (text)
- Title (text)
- Email (email)
- LinkedIn (url)
- Source (text)
- Added (date)
- Notes (text)

**Tasks Database:**
- Task (title)
- Done (checkbox)
- Due (date)
- Created (date)

### 3. Share Databases with Integration

For each database:
1. Click the `...` menu in the top-right
2. Click "Connect to" or "Connections"
3. Select your integration

### 4. Get Database IDs

Each database has a unique ID in its URL:
```
https://notion.so/Your-Database-Name-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
                                     └─────────────── database ID ───────────────┘
```

Copy the 32-character ID (with or without dashes).

### 5. Configure Ariadne

Add to your `data/config.json`:

```json
{
  "notion": {
    "apiKey": "ntn_your_api_key_here",
    "databases": {
      "jobs": "your-jobs-database-id",
      "contacts": "your-contacts-database-id",
      "tasks": "your-tasks-database-id"
    }
  }
}
```

## Usage

### CLI Flags

```bash
# Preview what would happen (no changes made)
node scripts/notion-sync.js --dry-run

# Full bidirectional sync (default)
node scripts/notion-sync.js

# Only pull changes from Notion to local files
node scripts/notion-sync.js --pull-only

# Only push local changes to Notion (incremental)
node scripts/notion-sync.js --push-only

# Ignore hashes/timestamps, sync everything
node scripts/notion-sync.js --full

# Archive Notion pages for locally-deleted items
node scripts/notion-sync.js --apply-deletes

# Combine flags
node scripts/notion-sync.js --pull-only --dry-run
```

| Flag | Behavior |
|------|----------|
| `--dry-run` | Preview changes without modifying anything |
| `--pull-only` | Only pull Notion → local |
| `--push-only` | Only push local → Notion (incremental) |
| `--full` | Ignore hashes/timestamps, sync everything |
| `--apply-deletes` | Archive Notion pages for locally-deleted items |

### Via Claude Code

```
"Sync to Notion"
```

## How It Works

### Sync Algorithm

```
1. Ensure database schemas (3 API calls)
2. PULL (if not --push-only):
   a. Query each Notion DB for pages edited since last sync
   b. For each changed page:
      - Known item + only Notion changed → update local file
      - Known item + both changed → skip (local wins, push will overwrite)
      - Unknown page → add to local data
   c. Write updated local JSON files
3. PUSH (if not --pull-only):
   a. For each local item, compute SHA-256 hash and compare to sync map
   b. Skip items where hash matches (no local change)
   c. Create or update changed items in Notion
   d. Detect locally-deleted items, warn or archive
4. Update lastSyncTime, save sync map
```

### Change Detection

- **Local changes:** SHA-256 hash of each item's sorted JSON, stored in the sync map. If the hash matches, the item is skipped during push.
- **Notion changes:** `last_edited_time` timestamp filter on database queries. Only pages edited after `lastSyncTime` are fetched.

### Conflict Resolution

When both local and Notion have changed the same item since the last sync:
- **Local wins** — the local version is pushed to Notion
- The pull phase detects the conflict and skips the Notion update
- The push phase then overwrites Notion with the local version

### First Sync (Baseline)

On the first run (no `lastSyncTime` in sync map):
1. Fetches all pages from each Notion database
2. Records `notionLastEdited` timestamps for existing items
3. Does NOT overwrite local data or add new items from Notion
4. Performs a full push to populate all `localHash` values
5. Sets `lastSyncTime` for subsequent incremental syncs

This ensures existing data isn't accidentally overwritten during upgrade from one-way sync.

### Sync Map Migration

If you're upgrading from the Phase 1 one-way sync, the old flat sync map format:
```json
{ "jobs": { "Active:Stripe:DevEx Lead": "page-id-123" } }
```

Is automatically migrated to the enriched format:
```json
{
  "lastSyncTime": null,
  "jobs": {
    "Active:Stripe:DevEx Lead": {
      "notionId": "page-id-123",
      "localHash": null,
      "notionLastEdited": null
    }
  },
  "notionToLocal": {
    "page-id-123": { "type": "jobs", "key": "Active:Stripe:DevEx Lead" }
  }
}
```

The migration happens automatically on first run. The baseline sync then populates the hash and timestamp fields.

### Deletions

When an item exists in the sync map but not in local data:
- **Default:** Warns with a list of orphaned items
- **With `--apply-deletes`:** Archives the corresponding Notion pages and removes them from the sync map

### Contact Interactions

Contact interactions are synced via the Notes field in Notion using the format:
```
[2026-01-26] email: Sent resume for Health AI role
[2026-01-28] call: Discussed referral process
```

- **Push:** All local interactions are flattened to Notes (truncated at 2000 chars)
- **Pull:** New interaction lines in Notes are parsed and appended to local data (append-only merge, never overwrites existing interactions)
- Only complete `[date] type: summary` lines are parsed; truncated lines are safely ignored

### Job Status Changes in Notion

When a job's Status is changed in Notion (e.g., Active → Closed):
- The reverse map (`notionToLocal`) resolves the page ID to the old local key
- The job is moved between tracker arrays (active/skipped/closed)
- Physical folders are moved if the stage implies a directory change (InProgress → Applied → Rejected)
- The sync map keys are updated to match the new status

### Rate Limiting

- Requests are spaced 350ms apart to stay under Notion's rate limit
- 429 responses trigger automatic retry with exponential backoff (up to 3 retries)
- The `Retry-After` header is respected when present

### Pagination

Notion databases with more than 100 items are automatically paginated using `start_cursor`.

## Entity Sync Details

1. **Jobs:** All entries from `tracker.json` (active, skipped, closed) are synced with their current status and stage
2. **Contacts:** All entries from `network.json` are synced; interaction history is flattened into the Notes field (pulled back via append-only merge)
3. **Tasks:** All entries from `tasks.json` are synced with their completion status (Done checkbox maps to pending/completed)

## Security Notes

- Your `data/config.json` (containing API keys) is gitignored
- Never commit API keys or database IDs to version control
- The sync map file is also gitignored (stored in `data/`)
