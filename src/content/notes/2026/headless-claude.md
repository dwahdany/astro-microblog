---
slug: headless-claude
title: Running Claude Code Non-Interactively
created: 2026-01-08T09:21:00+00:00
tags:
  - claude
  - ai
  - agents
is_draft: false
---
You can easily run claude code on a subscription non-interactively. First create an OAuth token using `claude setup-token`. Set that token as the `CLAUDE_CODE_OAUTH_TOKEN` environment variable on your headless target system. Finally, run claude non-interactively with `claude -p "prompt"`.
Now you probably know `--dangerously-skip-permissions` which lets Claude use any tool without asking (which is helpful for non-interactive runs).
By default, it will only output something in the very end. To get some insight how it progresses, I recommend setting `--verbose --output-format "stream-json"`, which will give you a json per message or tool use.
```json
{"type":"assistant","message":{"model":"claude-sonnet-4-5-20250929","id":"msg_01VCMSqhZxoZQ6nqWGcA5Myd","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01MNxKniNF9LWBGrZh5ppuRF","name":"TodoWrite","input":{"todos":[{"content":"Evaluate Stage 3.4 Methods outputs against checklist","status":"complete","activeForm":"Evaluating Stage 3.4 Methods outputs against checklist"},{"content":"Create improvement tasks for any checklist failures","status":"in_progress","activeForm":"Creating improvement tasks for any checklist failures"},{"content":"Post detailed Linear comment with findings","status":"pending","activeForm":"Posting detailed Linear comment with findings"}]}}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":6,"cache_creation_input_tokens":244,"cache_read_input_tokens":87250,"cache_creation":{"ephemeral_5m_input_tokens":244,"ephemeral_1h_input_tokens":0},"output_tokens":637,"service_tier":"standard"},"context_management":null},"parent_tool_use_id":null,"session_id":"a23ce490-1693-496b-ad08-8e082248416d","uuid":"8620af06-c8e7-4409-9b91-a2248e353ecf"}
```
To get that output to a file and log it to console you can use `tee` (`stdbuf` ensures it's written to disk unbuffered)
`stdbuf -oL tee claude_output.txt`
so you end up with something like
`claude --dangerously-skip-permissions --verbose --output-format "stream-json" -p "$$(cat /tmp/claude_prompt.txt)" | stdbuf -oL claude_output.txt`
