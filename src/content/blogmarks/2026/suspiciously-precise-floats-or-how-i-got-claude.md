---
slug: suspiciously-precise-floats-or-how-i-got-claude
link_url: https://she-llac.com/claude-limits
link_title: suspiciously precise floats
title: ''
created: 2026-02-06T17:06:00+00:00
tags:
  - claude
  - hacking
  - anthropic
via_url: ''
via_title: ''
is_draft: false
---

How someone used an unrounded float in the Anthropic API to extract the exact token usage limits with the Stern-Brocot tree search method. TL;DR: In terms of weekly credits, Max5 is actually Max8.33, and Max20 is 2 times Max5 (not 4 times, that applies only to the 5h limit).
![|medium](grafik-2.png)
