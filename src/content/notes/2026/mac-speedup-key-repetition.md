---
slug: mac-speedup-key-repetition
title: ''
created: 2026-01-09T14:42:00+00:00
tags:
  - macos
  - productivity
is_draft: false
---
On macOS you can speed up the key repetition even further than the settings (System Preferences -> Keyboard) allow by setting these values in your console (or adding them to your [nix config](https://blog.wahdany.eu/2025/Aug/12/never-set-up-again-nix-on-mac/) as I did):

```bash
defaults write -g InitialKeyRepeat -float 10.0 # normal minimum is 15 (225 ms)
defaults write -g KeyRepeat -float 1.0 # normal minimum is 2 (30 ms)
```

I found this on [StackExchange](https://apple.stackexchange.com/questions/10467/how-to-increase-keyboard-key-repeat-rate-on-os-x).
