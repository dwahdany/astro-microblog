---
slug: claude-code-async-subagents
title: Async Subagents > API
created: 2025-12-10T22:08:00+01:00
tags:
  - claude
  - agents
  - ai
is_draft: false
---
Claude Code now has asynchronous subagents, meaning the main agent can spawn subagents (this is not new) that keep running in the background (this is new). I don't know if Anthropic as imposed a limited on this feature, but for me it definitely has replaced some API use cases, since I managed to have it spawn over 100 subagents to process a bunch of documents. Not sure if that is what they intended it for, but it's nice!

![|small](20251210-220803.png)
