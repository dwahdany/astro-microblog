---
slug: building-my-microblog
title: "Building a Microblog with Astro 5"
created: 2024-12-04T10:30:00Z
tags: [astro, webdev, tutorial]
is_draft: false
---

This is my first long-form entry on the new microblog. I built this using Astro 5 with content collections, Tailwind CSS for styling, and deployed it to Cloudflare Pages.

## Why Astro?

Astro is perfect for content-heavy sites because:

- **Content Collections** provide type-safe content management
- **Zero JS by default** means fast page loads
- **Island Architecture** allows adding interactivity only where needed

## Features

The blog supports four content types:

1. **Entries** - Long-form articles like this one
2. **Blogmarks** - Links to interesting things with commentary
3. **Quotations** - Memorable quotes I want to save
4. **Notes** - Short micro-posts and thoughts

All content is grouped by day on the homepage, just like Simon Willison's blog.

## What's Next

I plan to add:

- RSS feeds for each content type
- Full-text search with Pagefind
- Comments via Giscus
- A newsletter signup
