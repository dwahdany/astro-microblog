---
slug: use-ty
title: ''
created: 2025-12-17T10:44:00Z
tags:
  - software-engineering
  - rust
  - python
is_draft: false
---
Since astral has now officially announced the beta of ty, i'd like to share my current setup of amazing and fast tools:

- [uv](https://github.com/astral-sh/uv) is for managing python dependencies and python itself. Rigorous environment locks included, which [you absolutely need](https://blog.wahdany.eu/2025/Mar/29/python-dependency-management/). Can also do [versioning, building and publishing](https://blog.wahdany.eu/2025/Aug/5/python-packages-and-scripts-with-uv/). 
- [pixi](https://pixi.sh/latest/) is for when you need to have conda dependencies. It uses uv under the hood for pypi deps, which is why I try to add everything as a pypi dependency (`pixi add --pypi x`).
- [ruff](https://docs.astral.sh/ruff/) is a linter. I don't want to see any of you manually formatting code, inserting spaces and the like. Just use ruff.
- [ty](https://docs.astral.sh/ty/) (now officially in beta) is a static type checker. It'll tell you things like when you return or pass the wrong type, which will probably make your code malfunction. You can use it as a full language server, so it'll also tell you diagnostics, give (non-AI) code completions for known symbols, and show docstrings.

All of these are built in rust and just generally nice to use.

Honorable mention to [loguru](https://github.com/Delgan/loguru) for being a logger that I actually can remember how to use (`from loguru import logger; logger.info('hello')`).
