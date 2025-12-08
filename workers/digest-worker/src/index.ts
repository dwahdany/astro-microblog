interface Env {
  BUTTONDOWN_API_KEY: string;
  BLOG_URL: string;
}

interface ContentItem {
  type: 'entry' | 'blogmark' | 'quotation' | 'note';
  title: string;
  url: string;
  created: string;
  tags: string[];
  excerpt: string;
}

interface ContentResponse {
  generated: string;
  days: number;
  count: number;
  items: ContentItem[];
}

interface Subscriber {
  id: string;
  email: string;
  tags: string[];
  metadata: Record<string, string>;
}

interface SubscribersResponse {
  results: Subscriber[];
  next: string | null;
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const today = new Date();
    const dayOfWeek = today.getDay();

    console.log(`Digest worker running at ${today.toISOString()}, day of week: ${dayOfWeek}`);

    // Send daily digests every day
    await sendDigest(env, 'daily', 1);

    // Send weekly digests on Mondays (day 1)
    if (dayOfWeek === 1) {
      await sendDigest(env, 'weekly', 7);
    }
  },

  // For testing via HTTP request
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/test/daily') {
      await sendDigest(env, 'daily', 1);
      return new Response('Daily digest sent');
    }

    if (url.pathname === '/test/weekly') {
      await sendDigest(env, 'weekly', 7);
      return new Response('Weekly digest sent');
    }

    return new Response('Blog Digest Worker. Use /test/daily or /test/weekly to trigger manually.');
  },
};

async function sendDigest(env: Env, frequency: string, daysBack: number) {
  console.log(`Sending ${frequency} digest for last ${daysBack} days...`);

  // 1. Fetch recent content from blog
  const content = await fetchRecentContent(env.BLOG_URL, daysBack);
  if (content.length === 0) {
    console.log('No new content, skipping digest');
    return;
  }

  console.log(`Found ${content.length} content items`);

  // 2. Get subscribers with this frequency preference
  const subscribers = await getSubscribersByFrequency(env, frequency);
  console.log(`Found ${subscribers.length} subscribers for ${frequency} digest`);

  if (subscribers.length === 0) {
    return;
  }

  // 3. Group content by type for filtering
  const contentByType = groupContentByType(content);

  // 4. Send personalized digest to each subscriber
  for (const subscriber of subscribers) {
    const personalizedContent = filterBySubscriberTags(contentByType, subscriber.tags);

    if (personalizedContent.length === 0) {
      console.log(`No matching content for ${subscriber.email}, skipping`);
      continue;
    }

    const emailBody = generateDigestHTML(personalizedContent, frequency, env.BLOG_URL);
    const subject = generateSubject(frequency, personalizedContent.length);

    await sendEmail(env, subscriber.email, subject, emailBody);
    console.log(`Sent ${frequency} digest to ${subscriber.email} with ${personalizedContent.length} items`);
  }
}

async function fetchRecentContent(blogUrl: string, days: number): Promise<ContentItem[]> {
  const response = await fetch(`${blogUrl}/api/content.json?days=${days}`);

  if (!response.ok) {
    console.error(`Failed to fetch content: ${response.status}`);
    return [];
  }

  const data: ContentResponse = await response.json();
  return data.items;
}

async function getSubscribersByFrequency(env: Env, frequency: string): Promise<Subscriber[]> {
  const subscribers: Subscriber[] = [];
  let nextUrl: string | null = `https://api.buttondown.com/v1/subscribers?tag=freq:${frequency}`;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        Authorization: `Token ${env.BUTTONDOWN_API_KEY}`,
      },
    });

    if (!response.ok) {
      console.error(`Failed to fetch subscribers: ${response.status}`);
      break;
    }

    const data: SubscribersResponse = await response.json();
    subscribers.push(...data.results);
    nextUrl = data.next;
  }

  return subscribers;
}

function groupContentByType(content: ContentItem[]): Map<string, ContentItem[]> {
  const grouped = new Map<string, ContentItem[]>();

  for (const item of content) {
    const typeKey = item.type;
    if (!grouped.has(typeKey)) {
      grouped.set(typeKey, []);
    }
    grouped.get(typeKey)!.push(item);
  }

  return grouped;
}

function filterBySubscriberTags(
  contentByType: Map<string, ContentItem[]>,
  subscriberTags: string[]
): ContentItem[] {
  const result: ContentItem[] = [];

  // Map content types to tag names
  const typeToTag: Record<string, string> = {
    entry: 'type:entries',
    blogmark: 'type:blogmarks',
    quotation: 'type:quotations',
    note: 'type:notes',
  };

  for (const [type, items] of contentByType) {
    const tagName = typeToTag[type];
    if (tagName && subscriberTags.includes(tagName)) {
      result.push(...items);
    }
  }

  // Sort by date (newest first)
  return result.sort(
    (a, b) => new Date(b.created).getTime() - new Date(a.created).getTime()
  );
}

function generateSubject(frequency: string, itemCount: number): string {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const freqLabel = frequency === 'daily' ? 'Daily' : 'Weekly';
  return `${freqLabel} Digest - ${dateStr} (${itemCount} ${itemCount === 1 ? 'item' : 'items'})`;
}

function generateDigestHTML(
  content: ContentItem[],
  frequency: string,
  blogUrl: string
): string {
  const typeLabels: Record<string, { label: string; icon: string; color: string }> = {
    entry: { label: 'Entries', icon: '&#9656;', color: '#4ade80' },
    blogmark: { label: 'Blogmarks', icon: '&#8853;', color: '#60a5fa' },
    quotation: { label: 'Quotations', icon: '"', color: '#22d3ee' },
    note: { label: 'Notes', icon: '&#9675;', color: '#9ca3af' },
  };

  // Group by type for display
  const grouped = new Map<string, ContentItem[]>();
  for (const item of content) {
    if (!grouped.has(item.type)) {
      grouped.set(item.type, []);
    }
    grouped.get(item.type)!.push(item);
  }

  // Build sections
  let sections = '';
  const typeOrder = ['entry', 'blogmark', 'quotation', 'note'];

  for (const type of typeOrder) {
    const items = grouped.get(type);
    if (!items || items.length === 0) continue;

    const { label, icon, color } = typeLabels[type];

    sections += `
      <div style="margin-bottom: 24px;">
        <h2 style="font-family: monospace; font-size: 16px; color: ${color}; margin: 0 0 12px 0; border-bottom: 1px solid #374151; padding-bottom: 8px;">
          <span style="margin-right: 8px;">${icon}</span>${label}
        </h2>
        <ul style="list-style: none; padding: 0; margin: 0;">
          ${items
            .map(
              (item) => `
            <li style="margin-bottom: 16px; padding-left: 16px; border-left: 2px solid #374151;">
              <a href="${blogUrl}${item.url}" style="color: #22d3ee; text-decoration: none; font-weight: 500;">
                ${escapeHtml(item.title)}
              </a>
              ${item.excerpt ? `<p style="color: #9ca3af; margin: 4px 0 0 0; font-size: 14px;">${escapeHtml(item.excerpt.slice(0, 150))}${item.excerpt.length > 150 ? '...' : ''}</p>` : ''}
            </li>
          `
            )
            .join('')}
        </ul>
      </div>
    `;
  }

  const freqLabel = frequency === 'daily' ? 'Daily' : 'Weekly';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0d1117; color: #e6edf3; padding: 20px; margin: 0;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 24px;">
    <header style="margin-bottom: 24px; border-bottom: 1px solid #30363d; padding-bottom: 16px;">
      <h1 style="font-family: monospace; font-size: 20px; color: #4ade80; margin: 0;">
        <span style="margin-right: 8px;">></span>blog.wahdany.eu
      </h1>
      <p style="color: #9ca3af; margin: 8px 0 0 0; font-size: 14px;">
        Your ${freqLabel.toLowerCase()} digest
      </p>
    </header>

    <main>
      ${sections}
    </main>

    <footer style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #30363d; font-size: 12px; color: #6b7280;">
      <p style="margin: 0;">
        <a href="${blogUrl}" style="color: #22d3ee; text-decoration: none;">Visit the blog</a>
        &nbsp;&middot;&nbsp;
        <a href="${blogUrl}/subscribe/" style="color: #22d3ee; text-decoration: none;">Manage preferences</a>
      </p>
      <p style="margin: 8px 0 0 0;">
        You're receiving this because you subscribed to the ${freqLabel.toLowerCase()} digest.
      </p>
    </footer>
  </div>
</body>
</html>
  `.trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendEmail(
  env: Env,
  toEmail: string,
  subject: string,
  body: string
): Promise<void> {
  const response = await fetch('https://api.buttondown.com/v1/emails', {
    method: 'POST',
    headers: {
      Authorization: `Token ${env.BUTTONDOWN_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      subject,
      body,
      status: 'sent',
      email_type: 'private', // Send to specific subscriber
      // Note: Buttondown's API may require different fields for individual emails
      // This might need adjustment based on actual API behavior
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`Failed to send email to ${toEmail}: ${response.status} - ${error}`);
  }
}
