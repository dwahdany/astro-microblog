---
slug: python-packages-and-scripts-with-uv
title: "Python Packages and Scripts with uv"
created: 2025-08-05T18:24:57+00:00
tags: [software-engineering]
is_draft: false
excerpt: "uv: there is more it can do!"
---

(skip to the next heading for the actual advice)

I love uv and the savings in terms of

1. compute saved due to efficient rust implementations
2. highly skilled labor time saved due to 1. and easily reproducible environments

must have amounted (globally) to dozens of millions of Euros if not more. It has transformed the management of environments and sharing them from something I dreaded to an enjoyable task with colourful progress bars that fill quickly. So much so, that I will [spend hours on porting old packages](https://github.com/dwahdany/fast-jl-binary) into this workflow.

[Charlie Marsh](https://www.crmarsh.com/), the founder of Astral, the company behind uv and other extremely fast dev tools, has recently shared results from the 2025 Stack Overflow developer survey, and **uv is the most admired technology**. Now, to be honest, I don't know how to interpret that specific statement in any meaningful way. But what I get from this is that many developers know and like uv!

![](2025-08-Pasted-image-20250802153840.png)

Results of the StackOverflow Developer Survey

In my last post I [recommend uv for dependency management](https://link.wahdany.eu/uv1), but there is more it can do!

# Scripts

If you are anything like me, that is, a lazy and impatient person with access to claude-code and knowledge of python, you will whip out python scripts for all sorts of stuff. Part of being lazy means you probably don't want to deal with proper dependency management for every script you will just use once or twice. This is the perfect use-case for in-file requirements and ephemeral virtual environments! Just initialize your script with `uv init --script script.py` and add your requirements `uv add --script script.py 'requests<3' 'rich'`

(You can also write the script block yourself)

```
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "requests<3",
#   "rich",
# ]
# ///

import requests
from rich.pretty import pprint

resp = requests.get("https://peps.python.org/api/peps.json")
data = resp.json()
pprint([(k, v["title"]) for k, v in data.items()][:10])
```

Then run `uv run example.py` and it will take care of running with the desired python version and requirements!

![](2025-08-grafik.png)

# Packages

Sharing is caring. So if you share the great stuff you built, let uv handle the chores.

uv can do versioning, building and publishing! No more third party tools. Just have your uv project

1. Bump the version appropriately with `uv version --bump major|minor|patch [--bump alpha|beta|stable]`
2. Build the package with `uv build`
3. Publish with `uv publish`!

To publish your package using GitHub Actions you can follow their [template-repository](https://github.com/astral-sh/trusted-publishing-examples/tree/main) which basically boils down to this workflow configuration

```
name: Release

on:
  push:
    tags:
      # Publish on any tag starting with a `v`, e.g. v1.2.3
      - v*

jobs:
  pypi:
    name: Publish to PyPI
    runs-on: ubuntu-latest
    # Environment and permissions trusted publishing.
    environment:
      # Create this environment in the GitHub repository under Settings -> Environments
      name: release
    permissions:
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv build
      # Check that basic features work and we didn't miss to include crucial files
      - name: Smoke test (wheel)
        run: uv run --isolated --no-project -p 3.13 --with dist/*.whl tests/smoke_test.py
      - name: Smoke test (source distribution)
        run: uv run --isolated --no-project -p 3.13 --with dist/*.tar.gz tests/smoke_test.py
      - run: uv publish --trusted-publishing always
```
