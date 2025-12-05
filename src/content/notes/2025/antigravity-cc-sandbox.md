---
slug: antigravity-cc-sandbox
title: ''
created: 2025-12-05T23:13:00+01:00
tags:
  - ai
  - agents
  - security
is_draft: false
---
So [Antigravity](https://antigravity.google) by Google will let the agent "auto-decide" what commands to execute and which commands require approval. It also does not use a sandbox. It didn't take very long for the first [Reddit post about a whole drive being deleted](https://www.reddit.com/r/google_antigravity/comments/1p82or6/google_antigravity_just_deleted_the_contents_of/) by the agent arriving. Meanwhile Claude Code is going the complete other direction: rigorous permission systems _and _a sandbox on top. Anthropic explains this in more detail [in their blog](https://code.claude.com/docs/en/sandboxing), but basically they argue that you need filesystem and network sandboxing, because bypassing one would also mean bypassing the other (it's trivial for linux because [everything is a file](https://en.wikipedia.org/wiki/Everything_is_a_file), but holds more generally).

Just running an `npm run build` will trigger a sandbox request if a telemetry request is being made. `git commit` needs to use the non-sandbox fallback, because it uses my key for signing the commit, which is not available from within the sandbox. They always offer a sensible "always allow" because they are acutely aware of _Approval Fatigue_. It's a good approach and makes me feel a lot safer.

![](SCR-20251205-uano.png)
