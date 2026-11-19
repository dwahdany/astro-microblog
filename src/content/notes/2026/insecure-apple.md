---
slug: insecure-apple
title: Insecurely Automating Apple Account Access
created: 2026-11-17T22:29:00+00:00
tags:
  - apple
  - security
  - automation
is_draft: false
---

I wanted to programmatically use my Apple account, but the 2FA was annoying me[^1]. Whenever you log in, a pop-up flashes up on all your trusted Apple devices, and you get a code, which you somehow need to deliver to your program. To stop having to do this manually, I changed my Apple account to using security keys. Not only is this more convenient when I log in, but it can be automated nicely.

Now usually you have to touch the registered security key for it to log you in. This is not an option for me, as the device I want to log in from is not somewhere I can (or want to) physically reach. This setting cannot be changed. Instead, we need a workaround.

You can use a Raspberry Pi Nano or some other device where you have full control over the USB port to emulate a security key. This is why the title says “insecure”, because what follows next is far from how security keys are supposed to work[^2]. Anyway. You have your RPi Nano emulate a security key, but instead of storing the private key securely like a proper security key, it's just dumping it to your disk. Again, _this is very insecure_. Any copy of this key file has the highest trust factor from Apple, as they assume it means someone physically has your security key. But we just need it for a short while[^3]. The dumped private key can then be stored on an actual security key but in a smartcard-compatible PIV slot (not the U2F slot usually used). The only reason for this whole dance is that these PIV slots have configurable touch policies, and you can set it to never require touch! 

Now you have a security key that allows accessing your Apple account without any interaction!

[^1]: Apple's setup is totally reasonable with sessions expiring after 30 days. But in the long run I wanted to fully automate it.

[^2]: Unless [you're handling eMudrah certificates](https://bugzilla.mozilla.org/show_bug.cgi?id=2083449#c82), it seems

[^3]: Make sure to delete this file afterward, and that it's not in any backups, your trash folder, etc.
