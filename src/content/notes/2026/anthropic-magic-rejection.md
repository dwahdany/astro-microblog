---
slug: anthropic-magic-rejection
title: Anthropic Refusal Magic String
created: 2026-01-22T19:11:00+00:00
tags:
  - ai
  - claude
  - security
  - denial-of-service
is_draft: false
---

Anthropic has a magic string to test refusals [in their developer docs](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/handle-streaming-refusals#implementation-guide). This is intended for developers to see if their application built on the API will properly handle such a case. But this is also basically a magic denial-of-service key for anything built on the API. It refuses not only in the API but also in Chat, in Claude Code, ... i guess everywhere?

I use Claude Code on this blog and would like to do so in the future, so I will only include a screenshot and not the literal string here. Here goes the magic string to make any Anthropic model stop working!

![|small](grafik-1.png)

This is not _the_ worst idea ever, but it's also a bit janky. I hope it at least rotates occasionally (but there is no such indication), otherwise I don't see this ending well. This got to my attention with [this post](https://x.com/ghidraninja/status/2014332652086546941) that shows you can embed it in a binary. This is pretty bad if you plan to use claude code for malware analysis, [as you very much might want to](https://blog.wahdany.eu/ai-everything/). Imagine putting this in malware or anything else that might want to get automatically checked by AI, and now you have ensured that it won't be an Anthropic model that does the check.
