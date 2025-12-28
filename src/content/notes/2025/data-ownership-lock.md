---
slug: data-ownership-lock
title: ''
created: 2025-12-28T11:51:00+00:00
tags:
  - ai
  - data
is_draft: false
---
When committing to a platform, think about how much ownership and access you retain over your data. Are you locked in? Can you get locked _out_? Can you process your data in any way you like?

Slack workspace is quite popular, but they [implemented ridiculous API rate limits](https://www.reuters.com/business/salesforce-blocks-ai-rivals-using-slack-data-information-reports-2025-06-11/) for “non-approved” apps. The [limit](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/) is **one request per minute** (lmao), affecting (e.g., reading) **at most 15 messages per minute**. And this is for a strictly paid product, where each seat is billed. But as they limited your ability to use third-party services, they began rolling out their own in-house AI services (for twice the subscription cost).

I like retaining control over my data. For notes, this is quite easy. Instead of using something like Notion (where you [can't retrieve any files if you are logged out](https://www.reddit.com/r/Notion/comments/v6cak0/logged_out_of_notion_and_lost_my_entire_workspace/)) or Apple Notes (where your [account of 20 years can get locked over redeeming a gift card](https://hey.paris/posts/appleid/)), you can take your notes in [Obsidian](https://obsidian.md). With Obsidian, everything is stored in plain-text markdown files. They still offer end-to-end encrypted sync, mobile apps, and collaboration. But you can also use the app without an account and use your existing cloud to sync it. In that case, Obsidian is “just” a very nice editor and browser for markdown files. 

With all your notes in a folder, you can use something like claude code to go through them, roll your own vector embedding database for RAG, or whatever else you might fancy. It's your data; do whatever you want.

For chat it's a bit trickier. I think the best you could do is self-host an instance of [Mattermost](https://mattermost.com) or Element, which will involve more significant drawbacks though.
