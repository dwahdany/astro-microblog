---
slug: gradient-checkpointing
title: ''
created: 2025-12-12T17:33:00Z
tags:
  - ai
  - training
  - optimization
is_draft: false
---
[Gradient Checkpointing](https://github.com/cybertronai/gradient-checkpointing) is a technique to trade off speed for reduced VRAM usage during backprop. During backprop, we usually keep the forward activations of all layers preceding the ones we computed the gradient for in VRAM, since we will need them during later steps of backpropagation. We can reduce VRAM usage by discarding these earlier activations and recomputing them later, when we require them. A middle ground between computing everything again and keeping everything in VRAM is keeping only certain _checkpoints_ in VRAM. The linked repo has a great animation showing the whole process. PyTorch has this implemented as [activation checkpointing](https://docs.pytorch.org/docs/stable/checkpoint.html) (which is a more reasonable name). In [their blog ](https://pytorch.org/blog/activation-checkpointing-techniques/)they also mention that they offer an automatic Pareto-optimal tradeoff for a user-specified memory limit! (although the [config seems to have a different name in the code](https://github.com/pytorch/pytorch/issues/161650) than mentioned in the blog)
