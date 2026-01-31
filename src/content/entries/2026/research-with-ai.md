---
slug: research-with-ai
title: Researching With AI
created: 2026-01-31T11:51:00+00:00
tags:
  - research
  - academia
  - writing
  - ai
  - agents
is_draft: false
series: ''
card_image: ''
excerpt: You have a real-life cheat code. If there were any doubts that there were no speed limits before, they are definitely gone now.
---

We've produced a meaningful research paper for submission at a top-tier conference in record time, and it would not have been possible without AI assistance. I want to recap what (with the current models and harnesses) went well and what didn't.

Overall I'm excited ~~about the future~~. I think Andrej Karparthy (as so often) has [captured this sentiment](https://x.com/karpathy/status/2015895365674021136) very well:

> It feels like I’m cheating. Which is a very weird feeling to have. It takes a while to unpack.

You have a real-life cheat code. If there were any doubts that there were [no speed limits before](https://sive.rs/kimo), they are definitely gone now.

**The idea.** I don't think AI can meaningfully participate in a discussion about what is essentially human taste and values. It can still _help_, e.g., produce survey paper-style overviews of existing work or identify directions that are promising by some well-defined rubric. But I don't think it can or should come up with that rubric.

**The paper.** What worked nothing short of amazing were all technical parts of presenting results and writing: creating figures from data, writing down code for tikz figures, and typesetting everything in latex. This was always the least fun part for me, as there was huge latency between an idea, and then actually querying the data, plotting, saving pdfs with separate legends, creating the figure environments in LaTeX, ... This just works now and is much faster! It's a lot more fun if the feedback cycles are as fast as they are now.

What was surprisingly _bad_ was the non-technical part of writing, i.e., formulating the prose. In a paper, you want to share newly found truth and scientifically accurate details, and I somehow thought that a large _language_ model would excel at that. But ... the current models produce nothing short of what I would consider "slop", it's really bad. I tried hooking them up with the [best writing advice](https://blog.wahdany.eu/2026/Jan/6/bm-how-to-write-ml-papers/) I know, which helped produce some good sections. But since I don't have minute instructions for how to write every part of the paper handy, you are still left with 90% bad, overcomplicated, and partly nonsensical prose. If we had all the tacit knowledge about writing formalized somewhere, I believe AI could produce mostly great papers on its own.

**The experiments.** AI is very good at running things, taking care of logging, finding the best parameters in your database of results, and so on. It can set up harnesses quickly and effectively.  You need to steer it quite a lot to get the best option given your constraints (e.g., I was running everything on Modal, where you can't trivially parallelize writes to the same volume, because the last commit to a volume would overwrite all previous commits that modified the same file in-between).

Methodologically it's still bad in terms of precise results. It ran the attacks wrong, introduced errors in differentially private methods for which I had human-written correct code and just generally did things very confidently wrong lol.

So that leaves me still tremendously excited but also sobered when it comes to the "sparks of AGI" as of today.
