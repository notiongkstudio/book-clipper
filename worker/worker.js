/**
 * Book Clipper — Cloudflare Worker
 * NGK Studio · The Bookworm's HQ
 *
 * Proxy between the embedded web app and Notion API.
 * Endpoints:
 *   POST /api/validate         — test Notion token + DB access
 *   POST /api/add-book         — create a single book page
 *   POST /api/import-batch     — bulk-create books (Goodreads)
 *   POST /api/check-duplicates — query DB for existing titles
 *   GET  /api/search-books     — proxy Google Books API (keeps API key server-side)
 */

// ── Constants ────────────────────────────────────────────────────────────────
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const GOOGLE_BOOKS_API = "https://www.googleapis.com/books/v1/volumes";
// API key stored as Cloudflare Worker secret (env.GOOGLE_BOOKS_API_KEY)
// Set via: npx wrangler secret put GOOGLE_BOOKS_API_KEY

// Allowed origins for CORS (update after deploy)
const ALLOWED_ORIGINS = [
  "https://notiongkstudio.github.io",
  "http://localhost:3000",        // local dev
  "https://notion.so",            // Notion embed
  "https://www.notion.so",
  "null",                         // Notion embed sends origin "null"
];

// ── Genre Mapping ────────────────────────────────────────────────────────────
const GENRE_MAP = {
  "fiction": "Fiction",
  "literary fiction": "Fiction",
  "general fiction": "Fiction",
  "science fiction": "Sci-Fi",
  "sci-fi": "Sci-Fi",
  "fantasy": "Fantasy",
  "epic fantasy": "Fantasy",
  "urban fantasy": "Fantasy",
  "mystery": "Mystery",
  "detective": "Mystery",
  "crime": "Mystery",
  "romance": "Romance",
  "contemporary romance": "Romance",
  "horror": "Horror",
  "thriller": "Thriller",
  "suspense": "Thriller",
  "psychological thriller": "Thriller",
  "history": "Historical",
  "historical fiction": "Historical",
  "biography": "Biography",
  "autobiography": "Biography",
  "memoir": "Biography",
  "self-help": "Self-Help",
  "personal development": "Self-Help",
  "poetry": "Poetry",
  "poems": "Poetry",
  "comics": "Graphic Novel",
  "graphic novels": "Graphic Novel",
  "manga": "Graphic Novel",
  "classics": "Classic",
  "classic literature": "Classic",
  "nonfiction": "Non-Fiction",
  "non-fiction": "Non-Fiction",
  "science": "Non-Fiction",
  "philosophy": "Non-Fiction",
  "true crime": "Non-Fiction",
  "business": "Non-Fiction",
  "psychology": "Non-Fiction",
  "young adult": "Fiction",
  "children": "Fiction",
};

// Rating lookup
const STAR_MAP = {
  1: "⭐",
  2: "⭐⭐",
  3: "⭐⭐⭐",
  4: "⭐⭐⭐⭐",
  5: "⭐⭐⭐⭐⭐",
};

// Language mapping
const LANG_MAP = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  ja: "Japanese",
  zh: "Chinese",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) || origin?.endsWith(".notion.site");
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(data, status = 200, origin = "*") {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

async function notionFetch(path, token, method = "GET", body = null) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${NOTION_API}${path}`, opts);
  const json = await res.json();
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Your Notion token is invalid or has been regenerated. Please create a new integration token at notion.so/profile/integrations and update it in the Setup tab.");
    }
    if (res.status === 404) {
      throw new Error("Database not found. Check that your Database ID is correct and the integration has access to it.");
    }
    throw new Error(json.message || `Notion API error (${res.status})`);
  }
  return json;
}

/** Map Google Books categories array → template genre multi-select names. */
function mapGenres(categories) {
  if (!categories || !Array.isArray(categories)) return [];
  const mapped = new Set();
  for (const cat of categories) {
    const lower = cat.toLowerCase().trim();
    if (GENRE_MAP[lower]) {
      mapped.add(GENRE_MAP[lower]);
    } else {
      // Try partial match
      for (const [key, value] of Object.entries(GENRE_MAP)) {
        if (lower.includes(key) || key.includes(lower)) {
          mapped.add(value);
          break;
        }
      }
    }
  }
  return [...mapped].slice(0, 3); // max 3 genres
}

/** Extract year from various date formats. */
function extractYear(dateStr) {
  if (!dateStr) return null;
  const match = dateStr.match(/(\d{4})/);
  return match ? parseInt(match[1]) : null;
}

/** Build Notion page properties from book data. */
function buildProperties(book, databaseId) {
  const props = {};

  // Title (required)
  if (book.title) {
    props["Title"] = { title: [{ text: { content: book.title } }] };
  }

  // Author (text)
  if (book.author) {
    props["Author"] = { rich_text: [{ text: { content: book.author } }] };
  }

  // ISBN (text)
  if (book.isbn) {
    props["ISBN"] = { rich_text: [{ text: { content: book.isbn } }] };
  }

  // Pages (number)
  if (book.pages && !isNaN(book.pages)) {
    props["Pages"] = { number: parseInt(book.pages) };
  }

  // Publisher (text)
  if (book.publisher) {
    props["Publisher"] = { rich_text: [{ text: { content: book.publisher } }] };
  }

  // Published Year (number)
  if (book.publishedYear && !isNaN(book.publishedYear)) {
    props["Published Year"] = { number: parseInt(book.publishedYear) };
  }

  // Genre (multi-select)
  if (book.genres && book.genres.length > 0) {
    props["Genre"] = {
      multi_select: book.genres.map((g) => ({ name: g })),
    };
  }

  // Language (select)
  if (book.language) {
    props["Language"] = { select: { name: book.language } };
  }

  // Goodreads Link (url) — only set from actual Goodreads URLs (CSV import)
  // Don't populate with Google Books links — it's misleading
  if (book.goodreadsUrl) {
    props["Goodreads Link"] = { url: book.goodreadsUrl };
  }

  // Status (select) — default "Want to Read"
  if (book.status) {
    props["Status"] = { select: { name: book.status } };
  }

  // Rating (select)
  if (book.rating && STAR_MAP[book.rating]) {
    props["Rating"] = { select: { name: STAR_MAP[book.rating] } };
  }

  // My Review (text)
  if (book.review) {
    props["My Review"] = {
      rich_text: [{ text: { content: book.review.slice(0, 2000) } }],
    };
  }

  // Start Date
  if (book.startDate) {
    props["Start Date"] = { date: { start: book.startDate } };
  }

  // Finish Date
  if (book.finishDate) {
    props["Finish Date"] = { date: { start: book.finishDate } };
  }

  // Format (select)
  if (book.format) {
    props["Format"] = { select: { name: book.format } };
  }

  // Note: Cover files property is set in the route handler after async cover validation
  // (not here, because buildProperties is synchronous)

  return props;
}

/**
 * Check if an Open Library cover actually exists for the given ISBN.
 * OL returns a 1x1 transparent GIF (43 bytes) when no cover is available.
 * Returns the OL URL if a real cover exists, otherwise null.
 */
async function getOpenLibraryCover(isbn) {
  if (!isbn) return null;
  const cleanIsbn = isbn.replace(/[^0-9X]/gi, "");
  if (!cleanIsbn) return null;
  const url = `https://covers.openlibrary.org/b/isbn/${cleanIsbn}-L.jpg`;
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (!res.ok) return null;
    // OL placeholder is 43 bytes; real covers are at least a few KB
    const len = res.headers.get("content-length");
    if (len && parseInt(len) < 1000) return null;
    // If no content-length header, do a quick GET and check size
    if (!len) {
      const getRes = await fetch(url);
      const buf = await getRes.arrayBuffer();
      if (buf.byteLength < 1000) return null;
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * Resolve the best available cover URL for a book.
 * Priority: Open Library (by ISBN) → Google Books thumbnail (coverUrl).
 */
async function resolveCoverUrl(book) {
  const olCover = await getOpenLibraryCover(book.isbn);
  if (olCover) return olCover;
  // Fall back to Google Books thumbnail passed from client
  if (book.coverUrl) return book.coverUrl;
  return null;
}

// ── Route Handlers ───────────────────────────────────────────────────────────

/** POST /api/validate — test connection */
async function handleValidate(body, origin) {
  const { notion_token, database_id } = body;
  if (!notion_token || !database_id)
    return jsonResponse({ error: "Missing notion_token or database_id" }, 400, origin);

  try {
    const db = await notionFetch(`/databases/${database_id}`, notion_token);
    const propCount = Object.keys(db.properties || {}).length;
    return jsonResponse({
      success: true,
      database_name: db.title?.[0]?.plain_text || "Untitled",
      property_count: propCount,
    }, 200, origin);
  } catch (err) {
    return jsonResponse({ error: err.message }, 401, origin);
  }
}

/** POST /api/add-book — create a single book page */
async function handleAddBook(body, origin) {
  const { notion_token, database_id, book_data } = body;
  if (!notion_token || !database_id || !book_data)
    return jsonResponse({ error: "Missing required fields" }, 400, origin);

  try {
    // Build properties
    const properties = buildProperties(book_data, database_id);

    // Resolve best cover URL (Open Library → Google Books fallback)
    const coverUrl = await resolveCoverUrl(book_data);

    // Update Cover files property if we have a valid URL
    if (coverUrl) {
      properties["Cover"] = {
        files: [{ name: `${book_data.title || "cover"}.jpg`, type: "external", external: { url: coverUrl } }],
      };
    }

    // Create page (no page content — gallery view uses page content for cover preview)
    const page = await notionFetch("/pages", notion_token, "POST", {
      parent: { database_id },
      properties,
      // Set page cover banner
      ...(coverUrl
        ? { cover: { type: "external", external: { url: coverUrl } } }
        : {}),
      // Set icon to book emoji
      icon: { type: "emoji", emoji: "📖" },
    });

    return jsonResponse({
      success: true,
      page_id: page.id,
      page_url: page.url,
    }, 200, origin);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500, origin);
  }
}

/** POST /api/import-batch — bulk create books */
async function handleImportBatch(body, origin) {
  const { notion_token, database_id, books } = body;
  if (!notion_token || !database_id || !books || !Array.isArray(books))
    return jsonResponse({ error: "Missing required fields" }, 400, origin);

  const results = { created: 0, failed: 0, errors: [] };

  for (const book of books.slice(0, 10)) {
    // max 10 per batch
    try {
      const properties = buildProperties(book, database_id);
      const coverUrl = await resolveCoverUrl(book);
      if (coverUrl) {
        properties["Cover"] = {
          files: [{ name: `${book.title || "cover"}.jpg`, type: "external", external: { url: coverUrl } }],
        };
      }
      await notionFetch("/pages", notion_token, "POST", {
        parent: { database_id },
        properties,
        ...(coverUrl
          ? { cover: { type: "external", external: { url: coverUrl } } }
          : {}),
        icon: { type: "emoji", emoji: "📖" },
      });
      results.created++;
      // Rate limit: ~3 requests/sec
      await new Promise((r) => setTimeout(r, 350));
    } catch (err) {
      results.failed++;
      results.errors.push({ title: book.title, error: err.message });
    }
  }

  return jsonResponse(results, 200, origin);
}

/** POST /api/check-duplicates — query DB for existing titles */
async function handleCheckDuplicates(body, origin) {
  const { notion_token, database_id, titles } = body;
  if (!notion_token || !database_id || !titles || !Array.isArray(titles))
    return jsonResponse({ error: "Missing required fields" }, 400, origin);

  try {
    // Query database for all pages (paginated)
    const existing = new Set();
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const query = {
        page_size: 100,
        ...(startCursor ? { start_cursor: startCursor } : {}),
      };
      const result = await notionFetch(
        `/databases/${database_id}/query`,
        notion_token,
        "POST",
        query
      );

      for (const page of result.results || []) {
        const titleProp = page.properties?.Title?.title;
        if (titleProp && titleProp.length > 0) {
          existing.add(titleProp[0].plain_text.toLowerCase().trim());
        }
      }

      hasMore = result.has_more;
      startCursor = result.next_cursor;
    }

    // Check which input titles already exist
    const duplicates = [];
    const newTitles = [];
    for (const title of titles) {
      if (existing.has(title.toLowerCase().trim())) {
        duplicates.push(title);
      } else {
        newTitles.push(title);
      }
    }

    return jsonResponse({
      total_in_db: existing.size,
      duplicates,
      new_titles: newTitles,
    }, 200, origin);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500, origin);
  }
}

/** GET /api/search-books?q=...&maxResults=... — proxy Google Books API (keeps API key server-side) */
async function handleSearchBooks(url, origin, env) {
  const query = url.searchParams.get("q");
  if (!query) return jsonResponse({ error: "Missing q parameter" }, 400, origin);

  const apiKey = env.GOOGLE_BOOKS_API_KEY;
  if (!apiKey) return jsonResponse({ error: "Google Books API key not configured" }, 500, origin);

  const maxResults = Math.min(parseInt(url.searchParams.get("maxResults") || "8"), 20);
  const apiUrl = `${GOOGLE_BOOKS_API}?q=${encodeURIComponent(query)}&maxResults=${maxResults}&key=${apiKey}`;

  try {
    const res = await fetch(apiUrl, {
      headers: { "Referer": "https://notiongkstudio.github.io/" },
    });
    const data = await res.json();

    if (!res.ok) {
      return jsonResponse({
        error: data.error?.message || `Google Books API ${res.status}`,
      }, res.status === 429 ? 429 : 502, origin);
    }

    return jsonResponse(data, 200, origin);
  } catch (err) {
    return jsonResponse({ error: err.message }, 502, origin);
  }
}

/** POST /api/fix-covers — batch-update pages missing covers */
async function handleFixCovers(body, origin, env) {
  const { notion_token, database_id } = body;
  if (!notion_token || !database_id)
    return jsonResponse({ error: "Missing notion_token or database_id" }, 400, origin);

  try {
    // 1. Fetch all pages in the database
    const allPages = [];
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const query = { page_size: 100 };
      if (startCursor) query.start_cursor = startCursor;
      const result = await notionFetch(
        `/databases/${database_id}/query`,
        notion_token,
        "POST",
        query
      );
      allPages.push(...(result.results || []));
      hasMore = result.has_more;
      startCursor = result.next_cursor;
    }

    // 2. Find pages missing page cover or Cover files property
    const needsCover = [];
    for (const page of allPages) {
      const title = page.properties?.Title?.title?.[0]?.plain_text || "Untitled";
      // Skip test entries
      if (title.startsWith("DELETE")) continue;

      const hasBanner = page.cover !== null;
      const coverFiles = page.properties?.Cover?.files || [];
      const hasCoverFile = coverFiles.length > 0;
      const isbn = page.properties?.ISBN?.rich_text?.[0]?.plain_text || null;
      const author = page.properties?.Author?.rich_text?.[0]?.plain_text || null;

      if (!hasBanner || !hasCoverFile) {
        needsCover.push({ id: page.id, title, isbn, author, hasBanner, hasCoverFile });
      }
    }

    if (needsCover.length === 0) {
      return jsonResponse({
        success: true,
        message: "All books already have covers",
        total: allPages.length,
        updated: 0,
      }, 200, origin);
    }

    // 3. Resolve covers and update pages
    const results = { updated: 0, failed: 0, details: [] };

    for (const book of needsCover) {
      try {
        // Try Open Library with existing ISBN
        let coverUrl = null;
        if (book.isbn) {
          coverUrl = await getOpenLibraryCover(book.isbn);
        }

        // If no cover, try Google Books search
        if (!coverUrl) {
          const query = book.author
            ? `intitle:${book.title}+inauthor:${book.author}`
            : book.title;
          const gbUrl = `${GOOGLE_BOOKS_API}?q=${encodeURIComponent(query)}&maxResults=1&key=${env.GOOGLE_BOOKS_API_KEY}`;
          const gbRes = await fetch(gbUrl, {
            headers: { "Referer": "https://notiongkstudio.github.io/" },
          });
          const gbData = await gbRes.json();

          if (gbData.items && gbData.items.length > 0) {
            const vol = gbData.items[0].volumeInfo;

            // Try Open Library with Google Books ISBN
            if (vol.industryIdentifiers) {
              const isbn13 = vol.industryIdentifiers.find((i) => i.type === "ISBN_13");
              const isbn10 = vol.industryIdentifiers.find((i) => i.type === "ISBN_10");
              const gbIsbn = isbn13?.identifier || isbn10?.identifier;
              if (gbIsbn && gbIsbn !== book.isbn) {
                coverUrl = await getOpenLibraryCover(gbIsbn);
              }
            }

            // Fall back to Google Books thumbnail
            if (!coverUrl) {
              let thumb = vol.imageLinks?.thumbnail || vol.imageLinks?.smallThumbnail;
              if (thumb) {
                coverUrl = thumb.replace("zoom=1", "zoom=2").replace("&edge=curl", "");
              }
            }
          }
        }

        if (!coverUrl) {
          results.failed++;
          results.details.push({ title: book.title, status: "no_cover_found" });
          continue;
        }

        // Build update body
        const updateBody = { properties: {} };

        // Set page cover banner if missing
        if (!book.hasBanner) {
          updateBody.cover = { type: "external", external: { url: coverUrl } };
        }

        // Set Cover files property if missing
        if (!book.hasCoverFile) {
          updateBody.properties["Cover"] = {
            files: [
              {
                name: `${book.title}.jpg`,
                type: "external",
                external: { url: coverUrl },
              },
            ],
          };
        }

        // Update the page via Notion API (PATCH, not POST)
        const opts = {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${notion_token}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(updateBody),
        };
        const updateRes = await fetch(`${NOTION_API}/pages/${book.id}`, opts);
        const updateJson = await updateRes.json();

        if (!updateRes.ok) {
          throw new Error(updateJson.message || `Notion API ${updateRes.status}`);
        }

        results.updated++;
        results.details.push({ title: book.title, status: "updated", coverUrl });

        // Rate limit
        await new Promise((r) => setTimeout(r, 400));
      } catch (err) {
        results.failed++;
        results.details.push({ title: book.title, status: "error", error: err.message });
      }
    }

    return jsonResponse({
      success: true,
      total: allPages.length,
      needed_covers: needsCover.length,
      ...results,
    }, 200, origin);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500, origin);
  }
}

// ── Main Router ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // GET routes
    if (request.method === "GET") {
      switch (url.pathname) {
        case "/api/search-books":
          return handleSearchBooks(url, origin, env);
        default:
          return jsonResponse({ error: "Not found" }, 404, origin);
      }
    }

    // POST routes
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400, origin);
    }

    switch (url.pathname) {
      case "/api/validate":
        return handleValidate(body, origin);
      case "/api/add-book":
        return handleAddBook(body, origin);
      case "/api/import-batch":
        return handleImportBatch(body, origin);
      case "/api/check-duplicates":
        return handleCheckDuplicates(body, origin);
      case "/api/fix-covers":
        return handleFixCovers(body, origin, env);
      default:
        return jsonResponse({ error: "Not found" }, 404, origin);
    }
  },
};
