---
slug: python-dependency-management
title: "Python Dependency Management"
created: 2025-03-29T20:35:02+00:00
tags: [research, software-engineering, academia]
is_draft: false
---

Dependency management can make or break your progress. You need a good workflow for

- **Efficient Progress** instead of waiting for installs or dealing with issues
- **Reproducible Results** due to locked environments
- **Impactful Research** that other people can use and build upon with ease

Part of our job as academics is to write awful code. Often it's just a one-off thing, for a paper or specific research question, so our code needs to be rigorous in terms of scientific standards, but can (and often is) quite shoddy by SWE standards. That's fair enough, no one expects production-grade code in the supplemental material of a paper (i hope). What can become an issue, though, is reproducibility. Maybe your code on your machine gave you the right results, but if it does something different on my machine, maybe due to changing package versions, our SWE problems become serious scientific problems.

**Unless your name is George Hotz** or you work at a company called tinygrad, you'll probably use other people's packages for your project. And that's great, why reinvent the wheel? The issue is that these packages change, and this can outright block your scientific work.

> if it does something different on my machine, maybe due to changing package versions, our SWE problems become scientific problems

So here's a quick workflow, that'll make sure your projects are

- **Reproducible** for others and your future self
- **Install *seriously* fast**
- **Don't randomly break** when something updates

1. [Get uv](https://docs.astral.sh/uv/getting-started/installation/)
2. Create a new folder for your project
3. In that folder, initialize a project using `uv init`
4. To add a dependency, e.g., seaborn or bokeh for plotting (if you only use matplotlib, definitely give them a try!), use `uv add seaborn`
5. If you already have a requirements.txt, you can add it using `uv add -r requirements.txt`
6. Run your code either by
   1. Running it through uv `uv run some_script.py`
   2. Running it manually in the virtual environment
      1. Create a venv using `uv venv`
      2. Making sure your packages are installed `uv sync`
      3. Activating the venv with `source .venv/bin/activate`
      4. Running the script `python some_script.py`
7. When sharing your code, always include the `pyproject.toml` and `uv.lock`. These are essential to reproduce the exact environment and get your project running as it did on your machine.
