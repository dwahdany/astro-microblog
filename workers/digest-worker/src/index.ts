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

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    console.log(`Digest worker running at ${new Date().toISOString()}`);
    // Let failures reject so the invocation is recorded as failed.
    await sendDigest(env);
  },

  // For testing via HTTP request
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/test') {
      try {
        await sendDigest(env);
      } catch (error) {
        return new Response(String(error), { status: 500 });
      }
      return new Response('Digest sent');
    }

    return new Response('Blog Digest Worker. Use /test to trigger manually.');
  },
};

const DAYS_BACK = 7;

async function sendDigest(env: Env) {
  console.log(`Sending digest for last ${DAYS_BACK} days...`);

  const content = await fetchRecentContent(env.BLOG_URL, DAYS_BACK);
  if (content.length === 0) {
    console.log('No new content, skipping digest');
    return;
  }

  const sorted = [...content].sort(
    (a, b) => new Date(b.created).getTime() - new Date(a.created).getTime()
  );

  // Buttondown owns the subscriber list, so this is one email, not one per
  // subscriber. It also appends the unsubscribe footer.
  await sendEmail(
    env,
    generateSubject(sorted.length),
    generateDigestHTML(sorted, env.BLOG_URL)
  );

  console.log(`Sent digest with ${sorted.length} items`);
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

function generateSubject(itemCount: number): string {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return `New on blog.wahdany.eu - ${dateStr} (${itemCount} ${itemCount === 1 ? 'item' : 'items'})`;
}

function generateDigestHTML(content: ContentItem[], blogUrl: string): string {
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
        What's new since last time
      </p>
    </header>

    <main>
      ${sections}
    </main>

    <footer style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #30363d; font-size: 12px; color: #6b7280;">
      <p style="margin: 0;">
        <a href="${blogUrl}" style="color: #22d3ee; text-decoration: none;">Visit the blog</a>
      </p>
      <p style="margin: 8px 0 0 0;">
        You're receiving this because you subscribed to blog.wahdany.eu.
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

async function sendEmail(env: Env, subject: string, body: string): Promise<void> {
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
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Buttondown rejected the digest: ${response.status} - ${await response.text()}`
    );
  }
}
