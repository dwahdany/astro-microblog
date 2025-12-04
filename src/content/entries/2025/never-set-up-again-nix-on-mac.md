---
slug: never-set-up-again-nix-on-mac
title: "Never set up again: Nix on Mac"
created: 2025-08-12T17:00:09+00:00
tags: [software-engineering]
is_draft: false
excerpt: "Imagine setting up your brand-new laptop in the exact way you like it with a single command. Nix."
---

Imagine setting up your brand-new laptop in the exact way you like it with a single command. Now read the rest of this article because with Nix it literally is (except for logging back into everything 😩)

Nix is all about being declarative. (Not to be confused with [NixOS](https://nixos.org/), the operating system that natively incorporates Nix system-wide). No longer is setting up a new machine a lengthy process consisting of many steps, remembering what to install, how you set up things, etc.

An enthusiastic video by NoBoilerplate about Nix.

With Nix, you define the state of your system in one (or more) `.nix` file(s) and the tool will take care that everything looks as configured. What does *everything* mean in this context?

- Installed Nix Packages
- Installed Casks and Brews (using Homebrew)
- Installed App Store Packages (using MAS)
- Your shell configuration and aliases
- Your SSH configuration
- Keyboard Layout
- Touchpad and Mouse settings
- Finder Settings
- Environment Variables (like HISTCONTROL)
- Your git settings (name, email, signing)
- Whether you'd like to use TouchID for sudo
- Dock Settings (Pinned apps, Orientation, Magnification, Auto Hiding, ...)
- and anything else, as long as you integrate it into nix!

This is amazing for anyone that switches devices at any frequency.

**Getting your personal Nix config** is pretty straightforward. I suggest you start next time you get a new laptop. Every time you would install something or change a setting, like install Slack or enable Tap to Click on your touchpad, look up if nix can do it for you. It takes a couple of seconds to set it up, but you will never have to do it again or even think about. Ever.

```
system.defaults.trackpad = {
  Clicking = true; # tap to click
};
system.startup.chime = false;
home.sessionVariables = {
  # Set history control to ignore commands starting with space
  HISTCONTROL = "ignorespace";
  # Set default editor to vim
  EDITOR = "vim";
};
```

Some system settings, like enabling tap-to-click, disabling the startup chime and environment variables.

```
programs.git = {
  enable = true;
  lfs.enable = true;
  userName = hostConfig.fullName;
  userEmail = hostConfig.email;
  signing = {
    key = "~/.ssh/id_keychain.pub";
    signByDefault = true;
    format = "ssh";
  };
  extraConfig = {
    core.editor = "vim";
  };
};
```

No more setting up git!

```
system.defaults.dock = {
  persistent-apps = [
    "/System/Applications/Launchpad.app"
    "${hostConfig.homeDirectory}/Applications/Home Manager Apps/iTerm2.app"
    "/Applications/Firefox.app"
    "/Applications/Bitwarden.app"
    "${hostConfig.homeDirectory}/Applications/Home Manager Apps/Slack.app"
    "${hostConfig.homeDirectory}/Applications/Home Manager Apps/Obsidian.app"
    "/Applications/Zed.app"
    "/Applications/Cursor.app"
    "${hostConfig.homeDirectory}/Applications/Home Manager Apps/Zotero.app"
  ];
  orientation = "left";            # Dock position on screen
  autohide = false;                # Don't automatically hide the dock
  tilesize = 34;                   # Dock icon size
  magnification = true;             # Enable dock magnification
  largesize = 56;                  # Magnified dock icon size
  wvous-tr-corner = 1;             # disable all hot corners
  wvous-tl-corner = 1;
  wvous-bl-corner = 1;
  wvous-br-corner = 1;
};
```

I have my dock on the left, quite small and configure the pinned apps. Revealing my pinned apps feels almost intimate lol

```
({ pkgs, ... }: {
  environment.etc."Keyboard Layouts/EurKEY.keylayout".source = ./../EurKEY-Mac-1.2/EurKEY.keylayout;
  environment.etc."Keyboard Layouts/EurKEY.icns".source = ./../EurKEY-Mac-1.2/EurKEY.icns;
})
```

I use the [EurKEY](https://eurkey.steffen.bruentjen.eu/) Layout, a US ANSI layout with easy access Germän (and other european) ßpecial Çharact€rs

```
homebrew = {
  enable = true;
  onActivation = {
    autoUpdate = true;
    cleanup = "zap";
    upgrade = true;
  };
  global = {
    brewfile = true;
    lockfiles = false;
  };
  extraConfig = ''
    # Add custom Homebrew configuration for better compatibility
    cask_args appdir: "~/Applications"
  '';
  casks = [
    "firefox"
    "linearmouse"
    "owncloud"
    "betterdisplay" # to fix wrong TV role for displays
    "jordanbaird-ice" # bartender replacement
    ...
  ];
  brews = [
    "mas"
    "awscli@2"
    "huggingface-cli"
  ];
  masApps = {
    "System Color Picker" = 1545870783;
    "Numbers" = 409203825;
    "Pages" = 409201541;
    "Keynote" = 409183694;
    "Final Cut Pro" = 424389933;
    ...
  };
};
```

Install all apps automatically!!!111!1!

**Suggestions for a setup** would be to just use the official [nix installer for macOS](https://nixos.org/download/) and follow instructions for setting up [nix-darwin](https://github.com/LnL7/nix-darwin). Use [nix-homebrew](https://github.com/zhaofengli/nix-homebrew) to have nix install homebrew for you, and manage your environment including installed casks using [home-manager](https://github.com/nix-community/home-manager). If this sounds intimidating or you ever get lost, literally just copy and paste what I wrote into Claude and it should give a solid starting point. It sounded like way too much for me when I read about it, but something like “using home-manager” just means adding a couple lines to your config.

> Hey Claude, setup nix-darwin for me on this Mac. Use the official [nix installer for macOS](https://nixos.org/download/) and follow instructions for setting up [nix-darwin](https://github.com/LnL7/nix-darwin). Use [nix-homebrew](https://github.com/zhaofengli/nix-homebrew) to have nix install homebrew for you, and manage your environment including installed casks using [home-manager](https://github.com/nix-community/home-manager). Thanks love you bye

To prevent potential hallucinations from roadblocking you, here is what the answer should boil down to:

1. Install nix `sh <(curl -L` [`https://nixos.org/nix/install`](https://nixos.org/nix/install)`)`
2. Create a config
3. Install and run nix-darwin `nix run nix-darwin/master#darwin-rebuild – switch`

I store my config files in a git repo and link them to `nix-darwin`. Not sure if that's the greatest setup, but I have switched laptops twice since setting it up, and it has worked flawlessly.

## Nix-Shell

**Nix-Shell is another magic trick of Nix** which allows you to just get a shell with some dependency, without installing it globally (or really anywhere. It's only linked into this shell!). Want to work on a node project but haven't installed it? No worries, just pop into a nix-shell with node in it:

```
$ which npm
npm not found
$ nix-shell -p nodejs_23
[nix-shell:~]$ which npm
/nix/store/arnrjx5pv8fdm435y0yy5yd9npsx9f4h-nodejs-23.7.0/bin/npm
```

This is incredible because it has another trick up its sleeve, namely that you can put a `shell.nix` in any folder to store what dependencies you need for that project. You go into that folder, call `nix-shell` and it will give you a shell in that folder with everything you need! This completely decouples your system from each project ([as you always should](/2025/Mar/29/python-dependency-management/)) and allows for seamless collaboration because everyone has the same environment.

```
{
  pkgs ? import <nixpkgs> {}
}:
pkgs.mkShell {
  buildInputs = [
    pkgs.bun
    pkgs.nodejs_23
  ];
}
```

Simple `shell.nix` for a node project that uses bun for installing dependencies

I find this especially useful when doing one-off things using AI agents, like having the agent convert images for a website. I don't need that conversion tool installed globally. I will most likely never need it again. So, I tell the agent 'get any requirements you need using nix-shell' and it will run the command in nix without leaving numerous traces all over my system.

## **What remains** manual **...**

## 

... is logging into things, restoring the data within your apps where necessary, your ssh keys[[1]](#fn1) and a couple of other things. But the fact that, apart from that, a new laptop feels like your laptop again with only one command, and you *know everything you changed* is incredibly cool.

---

1. I have been told that if you use Bitwarden, it now has an [ssh-agent that can sync your keys](https://bitwarden.com/help/ssh-agent/#tab-macos-6VN1DmoAVFvm7ZWD95curS). [↩︎](#fnref1)
