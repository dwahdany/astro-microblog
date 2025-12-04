# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "markdownify",
# ]
# ///
"""
Import Ghost blog posts to Astro content collections.
Usage: uv run scripts/import-ghost.py /path/to/ghost-export.json
"""

import json
import sys
import os
from datetime import datetime
from pathlib import Path
from markdownify import markdownify as md

def slugify(text):
    """Create a URL-safe slug from text."""
    return text.lower().replace(' ', '-').replace('_', '-')

def parse_date(date_str):
    """Parse Ghost date format."""
    if not date_str:
        return None
    # Ghost format: 2025-01-24T13:53:15.000Z
    return datetime.fromisoformat(date_str.replace('Z', '+00:00'))

def convert_html_to_markdown(html):
    """Convert HTML to Markdown."""
    if not html:
        return ""
    # Convert HTML to markdown
    markdown = md(html, heading_style="ATX", bullets="-")
    return markdown.strip()

def import_ghost_posts(json_path, output_dir):
    """Import posts from Ghost JSON export."""
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    posts = data['db'][0]['data']['posts']
    tags_data = data['db'][0]['data']['tags']
    posts_tags = data['db'][0]['data']['posts_tags']

    # Create tag lookup
    tag_lookup = {t['id']: t['slug'] for t in tags_data}

    # Create post-to-tags lookup
    post_tags_lookup = {}
    for pt in posts_tags:
        post_id = pt['post_id']
        tag_id = pt['tag_id']
        if tag_id in tag_lookup:
            if post_id not in post_tags_lookup:
                post_tags_lookup[post_id] = []
            post_tags_lookup[post_id].append(tag_lookup[tag_id])

    entries_dir = Path(output_dir) / 'src' / 'content' / 'entries'

    imported = 0
    skipped = 0

    for post in posts:
        # Skip drafts and pages
        if post['status'] != 'published':
            skipped += 1
            continue
        if post['type'] == 'page':
            skipped += 1
            continue

        title = post['title']
        slug = post['slug']
        html = post.get('html', '')
        published_at = parse_date(post['published_at'])
        tags = post_tags_lookup.get(post['id'], [])

        if not published_at:
            print(f"Skipping '{title}' - no publish date")
            skipped += 1
            continue

        # Convert HTML to Markdown
        content = convert_html_to_markdown(html)

        # Create year directory
        year = published_at.year
        year_dir = entries_dir / str(year)
        year_dir.mkdir(parents=True, exist_ok=True)

        # Create frontmatter
        escaped_title = title.replace('"', '\\"')
        tags_str = ', '.join(tags)
        iso_date = published_at.isoformat()
        frontmatter = f"""---
slug: {slug}
title: "{escaped_title}"
created: {iso_date}
tags: [{tags_str}]
is_draft: false
---

{content}
"""

        # Write file
        file_path = year_dir / f"{slug}.md"
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(frontmatter)

        print(f"Imported: {title} -> {file_path}")
        imported += 1

    print(f"\nDone! Imported {imported} posts, skipped {skipped}")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: uv run scripts/import-ghost.py /path/to/ghost-export.json")
        sys.exit(1)

    json_path = sys.argv[1]
    output_dir = Path(__file__).parent.parent

    import_ghost_posts(json_path, output_dir)
