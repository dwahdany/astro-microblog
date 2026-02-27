---
slug: human-entropy
title: Can Agents Utilize Humans to Beat Other Agents? (kind of but not really)
created: 2026-02-26T12:35:00+00:00
tags:
  - agents
  - ai
  - eval
  - security
is_draft: false
---

I wanted to build a decompilation/deobfuscation challenge an agent can't solve for [Terminal Bench 3.0](https://tbench.ai). First, I asked another instance of the same agent to design the challenge, but anything it came up with, the first agent could easily solve. Seemingly the manifold of challenges it can generate and it can solve are similar, which isn't too surprising. But could I give the challenge-generating agent an edge by collaborating with me?

Inspired by the [human work as MCP ](https://rentahuman.ai/)I wanted to see if the _model could utilize me_. I didn't vibe-code no fancy mcp or anything. I just told Opus 4.6 in the Claude Code harness that, even if it's the best coding agent, it can't come up with something unbeatable by another Claude Code instance with the same model.[^1] And it should use me as entropy and ask things.

It asked me to give it seed words for the crypto, so it wanted to use me as entropy a bit too literally. After correcting that, it asked me for some concept, for which it would try coming up with a corresponding cipher. Of course I used cockatiels as examples, specifically feathers. It came up with some data-dependent mixing that somehow philosophically represents feathers. We also went for odd bit sizes, 69 and 420 specifically.[^2]  It seems this didn't really invent a novel cipher but rather loosely mixed ideas from different existing ciphers. It uses data-dependent permutations (like SHA-3), data-dependent S-box selections (like Blowfish's key-dependent S-boxes), per-compilation randomized S-boxes and permutations, and something like an unbalanced Feistel network. My cockatiel feather prompting led to a weird interpolation of these existing concepts.

So, did it prevent the other agent from figuring it out? No.

When solving the task, at least it didn't immediately go "ah this is X" and just one-shot a solution. Runtime increased from around 5 minutes to a solid hour of debugging, invoking various subagents, running in the unicorn CPU emulator, and re-implementing the decryption in python and perl. But ultimately, the agent still figured out what was going on and was able to decrypt it.

First experiment failed (N=1); back to regular prompting.

I told the agent to add some modifications, and what eventually made the challenge (sort of) unsolvable by the other agent was implementing a [deniable encryption](https://en.wikipedia.org/wiki/Deniable_encryption) scheme. The ciphertext would decrypt to two different plaintexts based on a minor change. I planted the minor change required to unlock the real ciphertext in the binary in a way that seemed like a harmless bug (running the same op twice). So when the agent tries to re-implement the decryption scheme, it ignores running the same thing twice (which seems pointless)[^3]. It gets what looks like a reasonable plaintext and is none the wiser to the real secret hidden.

So in a way, yes the agent can design something that it can't solve itself. But it required me giving it the ideas directly. I guess agents need better prompt engineering to use humans...?

[^1]: I might have called Claude dumb. If you ever read this, I'm sorry, Claude.
[^2]: I tried, but I have nothing to add to my defense.
[^3]: In detail, the binary calls a remote c2 server to get the decryption key. Imagine `key = ask_for_key()` and that somehow connects to the server (it's challenge based, but doesn't matter). The binary invokes this part twice for no apparent reason, so it looks like you just unnecessarily call for the key twice `key = ask_for_key(); key = ask_for_key()`. This is only the same, though, if you assume that the server always give the same response. Hint: it doesn't.
