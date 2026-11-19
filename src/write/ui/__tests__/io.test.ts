// @vitest-environment jsdom
/**
 * Copy markdown, exactly. Review finding: without the async clipboard API (a phone on plain http)
 * the text went through a textarea, which turns CRLF and bare CR into LF.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '../lib/io';

type Clip = { getData(): string };

/** A browser's `execCommand('copy')`: fires `copy`; unless cancelled, copies the selected field's value. */
function fakeExecCommand(options: { withEvent: boolean }): Clip {
  let copied = '';
  (document as unknown as { execCommand(cmd: string): boolean }).execCommand = () => {
    const active = document.activeElement as HTMLTextAreaElement | null;
    const fallback = active?.value ?? '';
    if (!options.withEvent) {
      copied = fallback;
      return true;
    }
    const event = new Event('copy', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    let set: string | null = null;
    event.clipboardData = { setData: (_type: string, value: string) => (set = value) };
    (active ?? document).dispatchEvent(event);
    copied = event.defaultPrevented && set !== null ? set : fallback;
    return true;
  };
  return { getData: () => copied };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (document as unknown as { execCommand?: unknown }).execCommand;
});

describe('copyText without the async clipboard API', () => {
  const texts = ['---\r\nslug: a\r\n---\r\n\r\nBody\r\n', 'one\rtwo\r', 'mixed\r\nline\nendings\r', 'plain\nlf\n', ''];

  it.each(texts)('%j is copied byte for byte', async (text) => {
    const clip = fakeExecCommand({ withEvent: true });
    expect(await copyText(text)).toBe(true);
    expect(clip.getData()).toBe(text);
    // Nothing is left behind in the page.
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('a textarea really does lose the line endings (what the old fallback copied)', () => {
    const area = document.createElement('textarea');
    area.value = 'a\r\nb\rc';
    expect(area.value).toBe('a\nb\nc');
  });

  it('where the copy event cannot be answered, text with CR is reported as not copied rather than copied wrong', async () => {
    fakeExecCommand({ withEvent: false });
    expect(await copyText('a\r\nb')).toBe(false);
    expect(await copyText('a\nb')).toBe(true);
  });

  it('uses the async clipboard when the page has it', async () => {
    const writes: string[] = [];
    vi.stubGlobal('isSecureContext', true);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void writes.push(t) } });
    expect(await copyText('a\r\nb')).toBe(true);
    expect(writes).toEqual(['a\r\nb']);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  });
});
