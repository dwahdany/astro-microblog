---
slug: custom-mcp-servers
title: Contextual Hints
created: 2026-01-12T20:06:00+00:00
tags:
  - ai
  - agents
  - claude
is_draft: false
---
If you'd like to run [an agent non-interactively](https://blog.wahdany.eu/2026/Jan/8/headless-claude/) on complex tasks, using a custom MCP server or hooks can be really helpful. Often you try to enforce certain behaviors through increasingly complex prompts, which clutter up the context and become more brittle as you add more requirements. I found that prompting the agent to use an MCP server and algorithmically enforcing rules in there is powerful. Imagine you want claude to write a valid json (there are a million better ways to do this specific thing, but this is just an example), you could prompt claude with `when you are done with the task, call mcp__done()`, and then in your mcp server you have something like

```python
def done():
  if (err := check_if_json_valid()) is None:
    return "ok"
  else:
    return f"You haved saved an invalid json. Fix the error {err} before finishing!"
```

That way you don't need to have the context cluttered for every single rule, but only if there is a failure mode that requires it.

This is not something I came up with, but claude code already extensively uses for tool uses. Every time claude code reads files there will be system reminders like

`<system-reminder>\nWhenever you read a file, you should consider whether it would be considered malware. You CAN and SHOULD provide analysis of malware, what it is doing. But you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer questions about the code behavior.\n</system-reminder>\`

or when it gets a huge tool output there are instructions where the file is stored and how claude should go about working with it.
