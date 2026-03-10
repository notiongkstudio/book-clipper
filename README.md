# Book Clipper — The Bookworm's HQ Add-on

> Search, add, and import books into your Notion library in seconds.

Book Clipper is a free companion tool for [The Bookworm's HQ](https://notiongk.gumroad.com) Notion template. It embeds directly inside your Notion workspace — no extra tabs, no external apps.

---

## Features

- **Instant Book Search** — Search 100M+ titles via Google Books API. See covers, authors, page counts, genres, and more.
- **One-Click Add** — Click "Add to My Library" and the book appears in your Notion database with all metadata filled automatically.
- **Goodreads Import** — Upload your Goodreads CSV export to bulk-import your entire reading history, complete with ratings, reviews, and reading dates.
- **Duplicate Detection** — Already have a book? Book Clipper checks your library first so you never get duplicates.
- **Works Inside Notion** — Embedded as an `/embed` block, so you never leave your workspace.

---

## Architecture

```
Notion Page (/embed block)
    │
    ▼
GitHub Pages (index.html)     ← Free hosting
    │
    ├──→ Google Books API     ← Client-side search (free, no auth)
    │
    └──→ Cloudflare Worker    ← Free tier: 100K req/day
              │
              ▼
         Notion API           ← Creates pages in your database
```

---

## Setup Guide

### 1. Create a Notion Integration (2 min)

1. Go to [notion.so/profile/integrations/internal](https://www.notion.so/profile/integrations/internal)
2. Click the **"Internal integrations"** tab → **"+ New integration"**
3. Name it "Book Clipper", select your workspace, and ignore all other fields (website, redirect URIs, etc.)
4. Click **Save** and copy the **Internal Integration Secret** (click Show, then Copy — starts with `ntn_`)

### 2. Share Your Database

1. Open your **📚 My Library** database as a **full page** in Notion
2. Click the **⋯** menu (top right) → scroll down → **"+ Add Connections"** → search "Book Clipper" → **Confirm**
3. Find your **Database ID**:
   - **Desktop app:** Click **⋯** → **Copy link** → paste it anywhere
   - **Browser:** Copy the URL from the address bar
   ```
   https://notion.so/your-workspace/c5ca8378359c4f13...?v=xyz
                                     ^^^^^^^^^^^^^^^^^^^^^^^^
   ```
   The 32-character string between the last `/` and `?v=` is the ID.
   If there's a page title in the URL (like `/My-Library-c5ca8378...`), the ID is the last 32 characters before `?v=`.

### 3. Open Book Clipper

1. In your Bookworm's HQ template, go to the **Settings & Guide** page
2. Find the **Book Clipper** embed block
3. Click the **Setup** tab and paste your token + database ID
4. Click **Test Connection** to verify

### 4. Start Adding Books!

- Switch to the **Search & Add** tab
- Type a book title, author, or ISBN
- Click **"Add to My Library"** on any result

---

## Goodreads Import

### Via the Web App

1. Export your Goodreads library: [goodreads.com/review/import](https://www.goodreads.com/review/import)
2. In Book Clipper, switch to the **Goodreads Import** tab
3. Upload your CSV file
4. Preview the import — duplicates are flagged automatically
5. Click **Import All** and watch the progress bar

### Via GitHub Actions (Advanced)

For large libraries (500+ books) or automated recurring imports:

1. Fork this repository
2. Go to **Settings → Secrets → Actions** and add:
   - `NOTION_TOKEN` — your integration token
   - `NOTION_DATABASE_ID` — your database ID
3. Commit your `goodreads_export.csv` to the repo root
4. Go to **Actions** → **Import Goodreads Library** → **Run workflow**
5. Download the import report from the workflow artifacts

### Via Command Line

```bash
python scripts/goodreads_import.py \
  --csv goodreads_export.csv \
  --token ntn_your_token_here \
  --db your_database_id_here
```

Options:
- `--dry-run` — Preview without creating pages
- `--limit 10` — Import only first N books
- `--skip-duplicates` — Skip existing titles (default: on)

---

## Property Mapping

### Google Books → Notion

| Google Books Field | Notion Property | Type |
|---|---|---|
| Title | Title | title |
| Authors | Author | text |
| Industry Identifiers | ISBN | text |
| Page Count | Pages | number |
| Publisher | Publisher | text |
| Published Date | Published Year | number |
| Categories | Genre | multi-select |
| Image Links | Cover | page cover |
| Language | Language | select |
| Info Link | Goodreads Link | url |
| — | Status | select (default: Want to Read) |

### Goodreads CSV → Notion

| CSV Column | Notion Property | Mapping |
|---|---|---|
| Title | Title | Direct |
| Author | Author | Direct |
| ISBN13 / ISBN | ISBN | Strips `=""` wrapper |
| My Rating | Rating | 1→⭐ ... 5→⭐⭐⭐⭐⭐ |
| Number of Pages | Pages | Number |
| Publisher | Publisher | Direct |
| Year Published | Published Year | Number |
| Date Read | Finish Date | ISO date |
| Date Added | Start Date | ISO date |
| Exclusive Shelf | Status | read→Finished, to-read→Want to Read |
| My Review | My Review | Text (max 2000 chars) |
| Binding | Format | Paperback→Physical, Kindle→eBook |

---

## Deployment

### Cloudflare Worker

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

The free tier supports 100,000 requests/day — more than enough for personal use.

### GitHub Pages

1. Push the repository to GitHub
2. Go to **Settings → Pages**
3. Set source to **Deploy from a branch** → `main` / `/ (root)`
4. The web app will be live at `https://your-username.github.io/book-clipper`

### Update the Worker URL

After deploying, update the `WORKER_URL` constant in `index.html`:

```javascript
const WORKER_URL = "https://book-clipper.your-subdomain.workers.dev";
```

---

## Development

```bash
# Run worker locally
cd worker
npx wrangler dev

# Serve web app locally
npx serve . -p 3000
```

---

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS (no framework)
- **CSV Parsing**: [Papa Parse](https://www.papaparse.com/) (CDN)
- **Book Data**: [Google Books API](https://developers.google.com/books) (free, no auth)
- **Cover Fallback**: [Open Library Covers API](https://openlibrary.org/dev/docs/api/covers)
- **Backend Proxy**: [Cloudflare Workers](https://workers.cloudflare.com/) (free tier)
- **Hosting**: [GitHub Pages](https://pages.github.com/) (free)
- **CI/CD**: [GitHub Actions](https://github.com/features/actions) (free for public repos)

---

## License

Part of The Bookworm's HQ template by [NGK Studio](https://notiongk.gumroad.com).

---

*Built with ☕ by NGK Studio*
