---
slug: pickle-scanning
link_url: https://huggingface.co/docs/hub/security-pickle
link_title: Pickle Scanning
title: ''
created: 2025-12-11T11:13:00Z
tags:
  - security
  - python
  - fileformats
via_url: ''
via_title: ''
is_draft: false
---
Pickle is (/was?) a widespread file format in the Python ecosystem. It is immensely flexible, as you can pickle a lot of things (but [not everything as I learned using submitit](https://github.com/facebookincubator/submitit/blob/main/docs/tips.md#tips-and-caveats)). But that flexibility comes at the cost of security, as pickle files can contain arbitrary code instructions. Huggingface has a great post (the link of this note) covering this and their scanner for potentially dangerous pickle files. They also have a file format called [safetensors](https://github.com/huggingface/safetensors) (because pytorch tensors can also contain code...).
