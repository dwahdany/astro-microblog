---
slug: uv-central
title: uv centralized-project-envs
created: 2026-07-17T10:31:00+00:00
tags:
  - uv
  - python
is_draft: false
---

uv supports centralized virtual environment storage!

```toml
#~/.config/uv/uv.toml
cache-dir = "/local-scratch/uv"
preview-features = ["centralized-project-envs"]
```

Previously, the `.venv` in each directory was already just symlinking individual files to the central cache. Across disks, uv would copy everything over, though. This new feature works across disks and symlinks the entire `.venv` folder to the location you specify. 

This is especially useful for projects in slow locations like network-attached storage, where venvs with their many small files regularly slow everything down drastically.
