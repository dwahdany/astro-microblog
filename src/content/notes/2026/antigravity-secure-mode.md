---
slug: antigravity-secure-mode
title: Antigravity Removed "Auto-Decide" Terminal Commands
created: 2026-01-13T13:17:00+00:00
tags:
  - ai
  - agents
  - security
  - google
  - antigravity
is_draft: false
---
I noticed today that you can no longer let the agent in antigravity "auto-decide" which commands are safe to execute. There is just auto-accept and always-ask.

![Antigravity settings showing "Always Proceed" and "Request Review" options for "Terminal Command Auto Execution" |medium](grafik.png)

I wrote in a [previous post](https://blog.wahdany.eu/2025/Dec/5/antigravity-cc-sandbox/) that their previous approach seemed unsafe, especially without a sandbox. Now, the new issue with this approach is approval fatigue. There is no way to auto-allow similar commands or even exactly the same command in the future!

![It asks whether to run a command with only the options Reject and Accept.|small](SCR-20260113-mtnk.png)

I don't know why they can't just copy what Claude Code has. Anthropic has published a lot on this topic, and I don't think usable security should be a competitive differentiator.
