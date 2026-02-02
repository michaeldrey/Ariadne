# Notion Sync

Sync your Ariadne job search data to Notion for access from anywhere.

## Overview

The Notion sync feature provides **one-way synchronization** from your local Ariadne files to Notion databases. Your local files (`tracker.json`, `network.json`, `tasks.json`) remain the source of truth — changes you make locally get pushed to Notion.

**Phase 1 (current):** Local → Notion (write only)  
**Phase 2 (planned):** Bidirectional sync

## Setup

### 1. Create a Notion Integration

1. Go to [notion.so/my-integrations](https://notion.so/my-integrations)
2. Click "New integration"
3. Name it (e.g., "Ariadne Sync")
4. Copy the API key (starts with `ntn_` or `secret_`)

### 2. Create Databases in Notion

Create three databases in Notion with these properties:

**Jobs Database:**
- Role (title)
- Company (text)
- Status (select: Active, Skipped, Closed)
- Stage (select: Sourced, Applied, Phone Screen, Technical, Onsite, Offer, Negotiation)
- Next Action (text)
- Outcome (select: Rejected, Withdrew, Offer Declined, Accepted, Ghosted)
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
- Due (date)
- Status (select: Pending, Done)
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

### Manual Sync

```bash
# Preview what would be synced (no changes made)
node scripts/notion-sync.js --dry-run

# Run actual sync
node scripts/notion-sync.js
```

### Via Claude Code

```
"Sync to Notion"
```

The sync script will:
1. Read your local JSON files
2. Compare with existing Notion pages (via sync map)
3. Create new pages or update existing ones
4. Save the ID mapping for future syncs

### Sync Mapping

The script maintains a mapping file at `data/.notion-sync-map.json` that tracks which local items correspond to which Notion pages. This allows updates to work correctly without creating duplicates.

## How It Works

1. **Jobs:** All entries from `tracker.json` (active, skipped, closed) are synced with their current status
2. **Contacts:** All entries from `network.json` are synced; interaction history is flattened into the Notes field
3. **Tasks:** All entries from `tasks.json` are synced with their completion status

The sync respects Notion's rate limits (~3 requests/second) to avoid API errors.

## Limitations

- **One-way sync only (Phase 1):** Changes made in Notion are NOT synced back to local files
- **No relation linking:** Jobs↔Contacts↔Tasks relations aren't synced (they exist only in Notion)
- **Interaction history:** Contact interactions are flattened to text notes, not individual records

## Security Notes

- Your `data/config.json` (containing API keys) is gitignored
- Never commit API keys or database IDs to version control
- The sync map file is also gitignored (stored in `data/`)
