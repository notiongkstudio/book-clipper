#!/usr/bin/env python3
"""
Goodreads → Notion Importer
NGK Studio · The Bookworm's HQ

Parses a Goodreads CSV export and creates pages in a Notion database.
Used by the GitHub Actions workflow or run locally.

Usage:
  python goodreads_import.py --csv export.csv --token <NOTION_TOKEN> --db <DATABASE_ID>

Environment variables (alternative to flags):
  NOTION_TOKEN       — Notion integration token
  NOTION_DATABASE_ID — Target database ID
"""

import argparse
import csv
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# ── Constants ─────────────────────────────────────────────────────────────────

NOTION_API = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"
RATE_LIMIT_DELAY = 0.35  # seconds between Notion API calls

# Goodreads shelf → Notion Status
SHELF_MAP = {
    "read": "Finished",
    "currently-reading": "Currently Reading",
    "to-read": "Want to Read",
}

# Rating → star emoji
STAR_MAP = {
    1: "⭐",
    2: "⭐⭐",
    3: "⭐⭐⭐",
    4: "⭐⭐⭐⭐",
    5: "⭐⭐⭐⭐⭐",
}

# Binding → Format
FORMAT_MAP = {
    "paperback": "📕 Physical",
    "hardcover": "📕 Physical",
    "mass market paperback": "📕 Physical",
    "kindle edition": "📱 eBook",
    "ebook": "📱 eBook",
    "audiobook": "🎧 Audiobook",
    "audio cd": "🎧 Audiobook",
    "audible audio": "🎧 Audiobook",
}


# ── Notion API helpers ────────────────────────────────────────────────────────

def notion_request(path, token, method="GET", body=None):
    """Make a request to the Notion API."""
    url = f"{NOTION_API}{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }
    data = json.dumps(body).encode() if body else None
    req = Request(url, data=data, headers=headers, method=method)

    try:
        with urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except HTTPError as e:
        error_body = e.read().decode()
        try:
            error_json = json.loads(error_body)
            raise Exception(f"Notion API {e.code}: {error_json.get('message', error_body)}")
        except json.JSONDecodeError:
            raise Exception(f"Notion API {e.code}: {error_body}")


def validate_connection(token, database_id):
    """Test that we can access the database."""
    try:
        db = notion_request(f"/databases/{database_id}", token)
        name = db.get("title", [{}])[0].get("plain_text", "Untitled")
        prop_count = len(db.get("properties", {}))
        print(f"  Connected to: {name} ({prop_count} properties)")
        return True
    except Exception as e:
        print(f"  Connection failed: {e}")
        return False


def get_existing_titles(token, database_id):
    """Fetch all existing titles from the database for duplicate detection."""
    existing = set()
    has_more = True
    start_cursor = None

    while has_more:
        query = {"page_size": 100}
        if start_cursor:
            query["start_cursor"] = start_cursor

        result = notion_request(
            f"/databases/{database_id}/query", token, "POST", query
        )

        for page in result.get("results", []):
            title_prop = page.get("properties", {}).get("Title", {}).get("title", [])
            if title_prop:
                existing.add(title_prop[0]["plain_text"].lower().strip())

        has_more = result.get("has_more", False)
        start_cursor = result.get("next_cursor")
        if has_more:
            time.sleep(RATE_LIMIT_DELAY)

    return existing


def create_book_page(token, database_id, properties, cover_url=None):
    """Create a single book page in Notion."""
    payload = {
        "parent": {"database_id": database_id},
        "properties": properties,
        "icon": {"type": "emoji", "emoji": "📖"},
    }

    if cover_url:
        payload["cover"] = {"type": "external", "external": {"url": cover_url}}

    return notion_request("/pages", token, "POST", payload)


# ── CSV parsing ───────────────────────────────────────────────────────────────

def clean_isbn(raw):
    """Strip Goodreads' ="" wrapper from ISBNs."""
    if not raw:
        return ""
    return re.sub(r'[="\'\\s]', '', raw).strip()


def parse_date(date_str):
    """Parse Goodreads date formats to ISO date string."""
    if not date_str or date_str.strip() == "":
        return None

    date_str = date_str.strip()
    formats = ["%Y/%m/%d", "%m/%d/%Y", "%Y-%m-%d", "%d/%m/%Y"]

    for fmt in formats:
        try:
            dt = datetime.strptime(date_str, fmt)
            return dt.strftime("%Y-%m-%d")
        except ValueError:
            continue

    return None


def build_notion_properties(row):
    """Convert a Goodreads CSV row to Notion page properties."""
    props = {}

    # Title (required)
    title = row.get("Title", "").strip()
    if not title:
        return None
    props["Title"] = {"title": [{"text": {"content": title}}]}

    # Author
    author = row.get("Author", "").strip()
    if author:
        props["Author"] = {"rich_text": [{"text": {"content": author}}]}

    # ISBN
    isbn13 = clean_isbn(row.get("ISBN13", ""))
    isbn = clean_isbn(row.get("ISBN", ""))
    best_isbn = isbn13 if isbn13 else isbn
    if best_isbn:
        props["ISBN"] = {"rich_text": [{"text": {"content": best_isbn}}]}

    # Pages
    pages = row.get("Number of Pages", "").strip()
    if pages and pages.isdigit():
        props["Pages"] = {"number": int(pages)}

    # Publisher
    publisher = row.get("Publisher", "").strip()
    if publisher:
        props["Publisher"] = {"rich_text": [{"text": {"content": publisher}}]}

    # Published Year
    year = row.get("Year Published", "").strip()
    orig_year = row.get("Original Publication Year", "").strip()
    best_year = orig_year if orig_year else year
    if best_year and best_year.isdigit():
        props["Published Year"] = {"number": int(best_year)}

    # Rating
    rating_str = row.get("My Rating", "0").strip()
    try:
        rating = int(rating_str)
        if rating > 0 and rating in STAR_MAP:
            props["Rating"] = {"select": {"name": STAR_MAP[rating]}}
    except (ValueError, TypeError):
        pass

    # Status (from Exclusive Shelf)
    shelf = row.get("Exclusive Shelf", "").strip().lower()
    status = SHELF_MAP.get(shelf, "Want to Read")
    props["Status"] = {"select": {"name": status}}

    # Dates
    date_read = parse_date(row.get("Date Read", ""))
    date_added = parse_date(row.get("Date Added", ""))

    if date_read:
        props["Finish Date"] = {"date": {"start": date_read}}
    if date_added:
        props["Start Date"] = {"date": {"start": date_added}}

    # My Review
    review = row.get("My Review", "").strip()
    if review:
        props["My Review"] = {
            "rich_text": [{"text": {"content": review[:2000]}}]
        }

    # Format (from Binding)
    binding = row.get("Binding", "").strip().lower()
    fmt = FORMAT_MAP.get(binding)
    if fmt:
        props["Format"] = {"select": {"name": fmt}}

    return props


def get_cover_url(isbn):
    """Try to get cover image URL from Open Library."""
    if not isbn:
        return None
    return f"https://covers.openlibrary.org/b/isbn/{isbn}-L.jpg"


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Import Goodreads CSV export into Notion (The Bookworm's HQ)"
    )
    parser.add_argument(
        "--csv", required=True, help="Path to Goodreads CSV export file"
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("NOTION_TOKEN"),
        help="Notion integration token (or set NOTION_TOKEN env var)",
    )
    parser.add_argument(
        "--db",
        default=os.environ.get("NOTION_DATABASE_ID"),
        help="Notion database ID (or set NOTION_DATABASE_ID env var)",
    )
    parser.add_argument(
        "--skip-duplicates",
        action="store_true",
        default=True,
        help="Skip books that already exist in the database (default: True)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse CSV and show what would be imported without creating pages",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Max number of books to import (0 = unlimited)",
    )
    args = parser.parse_args()

    # Validate inputs
    if not args.token:
        print("Error: Notion token required. Use --token or set NOTION_TOKEN env var.")
        sys.exit(1)
    if not args.db:
        print("Error: Database ID required. Use --db or set NOTION_DATABASE_ID env var.")
        sys.exit(1)
    if not Path(args.csv).exists():
        print(f"Error: CSV file not found: {args.csv}")
        sys.exit(1)

    print("=" * 60)
    print("  Goodreads → Notion Importer")
    print("  The Bookworm's HQ · NGK Studio")
    print("=" * 60)

    # Test connection
    print("\n[1/4] Validating Notion connection...")
    if not validate_connection(args.token, args.db):
        sys.exit(1)

    # Parse CSV
    print("\n[2/4] Parsing Goodreads CSV...")
    books = []
    with open(args.csv, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            props = build_notion_properties(row)
            if props:
                isbn = clean_isbn(row.get("ISBN13", "")) or clean_isbn(row.get("ISBN", ""))
                books.append({
                    "properties": props,
                    "title": row.get("Title", "Unknown"),
                    "isbn": isbn,
                    "cover_url": get_cover_url(isbn),
                })

    print(f"  Found {len(books)} books in CSV")

    if not books:
        print("  No books to import. Exiting.")
        sys.exit(0)

    # Check duplicates
    existing = set()
    if args.skip_duplicates:
        print("\n[3/4] Checking for duplicates...")
        existing = get_existing_titles(args.token, args.db)
        print(f"  {len(existing)} books already in database")

        new_books = [
            b for b in books
            if b["title"].lower().strip() not in existing
        ]
        skipped = len(books) - len(new_books)
        print(f"  {skipped} duplicates will be skipped")
        books = new_books
    else:
        print("\n[3/4] Skipping duplicate check (--no-skip-duplicates)")

    if args.limit > 0:
        books = books[:args.limit]
        print(f"  Limited to {args.limit} books")

    # Dry run
    if args.dry_run:
        print("\n[DRY RUN] Would import these books:")
        for i, b in enumerate(books, 1):
            title = b["title"]
            status = b["properties"].get("Status", {}).get("select", {}).get("name", "?")
            print(f"  {i:3d}. {title} [{status}]")
        print(f"\n  Total: {len(books)} books would be imported.")
        sys.exit(0)

    # Import
    print(f"\n[4/4] Importing {len(books)} books...")
    created = 0
    failed = 0
    errors = []

    for i, book in enumerate(books, 1):
        title = book["title"]
        try:
            page = create_book_page(
                args.token, args.db,
                book["properties"],
                book["cover_url"],
            )
            created += 1
            print(f"  [{i}/{len(books)}] ✓ {title}")
            time.sleep(RATE_LIMIT_DELAY)
        except Exception as e:
            failed += 1
            errors.append({"title": title, "error": str(e)})
            print(f"  [{i}/{len(books)}] ✗ {title} — {e}")
            # Back off on rate limit errors
            if "rate" in str(e).lower() or "429" in str(e):
                print("    Rate limited, waiting 5s...")
                time.sleep(5)
            else:
                time.sleep(RATE_LIMIT_DELAY)

    # Summary
    print("\n" + "=" * 60)
    print("  Import Complete!")
    print("=" * 60)
    print(f"  ✓ Created:  {created}")
    print(f"  ✗ Failed:   {failed}")
    if existing:
        print(f"  ⊘ Skipped:  {len(existing)} duplicates")
    print()

    if errors:
        print("  Errors:")
        for err in errors:
            print(f"    - {err['title']}: {err['error']}")
        print()

    # Write report for GitHub Actions artifact
    report_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if report_path:
        with open(report_path, "a") as f:
            f.write("## Goodreads Import Report\n\n")
            f.write(f"| Metric | Count |\n|---|---|\n")
            f.write(f"| Books in CSV | {created + failed + len(existing)} |\n")
            f.write(f"| Created | {created} |\n")
            f.write(f"| Failed | {failed} |\n")
            f.write(f"| Skipped (duplicates) | {len(existing)} |\n\n")
            if errors:
                f.write("### Errors\n\n")
                for err in errors:
                    f.write(f"- **{err['title']}**: {err['error']}\n")

    # Also write a JSON report
    report = {
        "timestamp": datetime.now().isoformat(),
        "csv_total": created + failed,
        "created": created,
        "failed": failed,
        "skipped_duplicates": len(existing) if args.skip_duplicates else 0,
        "errors": errors,
    }
    report_file = Path(args.csv).stem + "_import_report.json"
    with open(report_file, "w") as f:
        json.dump(report, f, indent=2)
    print(f"  Report saved to: {report_file}")

    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    main()
