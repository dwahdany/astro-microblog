---
slug: try-different-pythons
title: ''
created: 2025-12-17T10:57:00Z
tags:
  - python
is_draft: false
---
With uv it's straightforward to try different python flavours, i.e., the free-threaded version introduced in 3.13 or the jit-compiled pypy with versions up to 3.11. Just run

`uv python install 3.14t` for the free-threaded version or `uv python install pypy3.11` for the latest version of pypy.
