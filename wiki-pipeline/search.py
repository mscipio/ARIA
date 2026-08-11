"""
Reusable wiki index search utilities.

Usage from agent:
    import sys; sys.path.insert(0, "/path/to/wiki-pipeline")
    from search import search_index, load_index

    results = search_index("prism-pet")
    for r in results:
        print(r["file"], r["title"])
"""

import json
import os

WIKI_DIR = os.environ.get("WIKI_DIR")
INDEX_PATH = os.path.join(WIKI_DIR, "wiki", "index.json") if WIKI_DIR else None

_cache = None


def load_index(force=False):
    """Load and cache the wiki search index."""
    global _cache
    if _cache is not None and not force:
        return _cache
    if INDEX_PATH is None:
        raise ValueError(
            "WIKI_DIR is not set. Cannot locate wiki/index.json.\n"
            "Set the WIKI_DIR environment variable to the wiki project root."
        )
    with open(INDEX_PATH, encoding="utf-8") as f:
        _cache = json.load(f)
    return _cache


def search_index(query, match="any", types=None):
    """
    Search the wiki index by keywords, title, and summary.

    Parameters
    ----------
    query : str
        Search terms (space-separated). Each term is matched independently.
    match : str
        "any" = OR (match if any term hits), "all" = AND (all terms required).
    types : list[str] | None
        Filter by page type, e.g. ["wiki"]. None = all types.

    Returns
    -------
    list[dict]
        Matching index entries, sorted by relevance (more hits first).
    """
    idx = load_index()
    terms = query.lower().split()

    results = []
    for page in idx.get("pages", []):
        if types and page.get("type") not in types:
            continue

        # Build searchable text from keywords, title, summary
        kw = " ".join(page.get("keywords", [])).lower()
        title = page.get("title", "").lower()
        summary = page.get("summary", "").lower()
        haystack = f"{kw} {title} {summary}"

        hits = sum(1 for t in terms if t in haystack)

        if match == "all" and hits == len(terms):
            results.append((hits, page))
        elif match == "any" and hits > 0:
            results.append((hits, page))

    # Sort by number of hits (descending)
    results.sort(key=lambda x: -x[0])
    return [r[1] for r in results]


def get_page(filename):
    """
    Get a specific page by filename (e.g. "wiki/some_page.md").

    Returns
    -------
    dict | None
        Index entry, or None if not found.
    """
    idx = load_index()
    for page in idx.get("pages", []):
        if page.get("file") == filename:
            return page
    return None


def list_pages(types=None):
    """
    List all pages, optionally filtered by type.

    Parameters
    ----------
    types : list[str] | None
        e.g. ["wiki"] or None for all.

    Returns
    -------
    list[dict]
    """
    idx = load_index()
    pages = idx.get("pages", [])
    if types:
        pages = [p for p in pages if p.get("type") in types]
    return pages
