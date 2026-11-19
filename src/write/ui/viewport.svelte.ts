/**
 * Mirrors the visual viewport into CSS variables so the app can size itself to
 * what is actually visible. This is what keeps the formatting toolbar above
 * the on-screen keyboard: iOS Safari does not resize the layout viewport when
 * the keyboard opens, it only shrinks (and scrolls) the visual one. Android
 * Chrome resizes the layout viewport instead (`interactive-widget=
 * resizes-content` in the page's viewport meta); both end up here as a
 * smaller `visualViewport.height`.
 *
 *   --w-vv-height  visible height
 *   --w-vv-offset  how far iOS has scrolled the layout viewport behind the keyboard
 *   --w-kb-inset   layout px hidden by the keyboard
 *
 * `viewport.keyboard` is a best guess that an on-screen keyboard is showing:
 * the visible height dropped well below the tallest it has been at this width
 * while something editable has focus.
 *
 * NOT verified on a real iPhone or Android phone — only in desktop Chromium
 * and Chromium phone emulation, where no keyboard appears.
 */
const KEYBOARD_MIN_PX = 140;

export const viewport = $state({ keyboard: false, height: 0 });

/**
 * The desktop layout (rail + list, toolbar on top, side panels, status line) needs width AND
 * height: a phone on its side is 850–930px wide and about 400px tall, and the desktop chrome
 * would leave it almost no room to write in.
 */
export const WIDE_MIN_WIDTH = 900;
export const WIDE_MIN_HEIGHT = 480;
/** Wide enough to show the editor and the preview side by side. */
export const SPLIT_MIN_WIDTH = 1100;

/** Set on <html> while the desktop layout applies; the stylesheets key on it (not on a media query). */
export const WIDE_ATTRIBUTE = 'data-write-wide';

/**
 * Which layout applies. `height` is the tallest the window has been at this width, NOT the
 * current height: an on-screen keyboard that shrinks the viewport (Android, tablets) must not
 * flip a tablet from the desktop layout to the phone one in the middle of typing.
 */
export function layoutFor(width: number, tallest: number): { wide: boolean; split: boolean } {
  const wide = width >= WIDE_MIN_WIDTH && tallest >= WIDE_MIN_HEIGHT;
  return { wide, split: wide && width >= SPLIT_MIN_WIDTH };
}

const hasWindow = typeof window !== 'undefined';
const firstHeight = hasWindow ? (window.visualViewport?.height ?? window.innerHeight) : 0;

// Known before the first render, so the app does not paint the phone layout and then switch.
export const media = $state(hasWindow ? layoutFor(window.innerWidth, firstHeight) : { wide: false, split: false });
if (hasWindow) document.documentElement.toggleAttribute(WIDE_ATTRIBUTE, media.wide);

function isEditable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|range)$/.test((el as HTMLInputElement).type));
}

export function trackViewport(): () => void {
  const root = document.documentElement;
  const vv = window.visualViewport;
  let tallest = 0;
  let tallestWidth = 0;

  const apply = () => {
    const height = vv ? vv.height : window.innerHeight;
    const offset = vv ? vv.offsetTop : 0;
    const width = window.innerWidth;
    // A rotation or window resize starts the measurement over.
    if (width !== tallestWidth) {
      tallestWidth = width;
      tallest = height;
    }
    tallest = Math.max(tallest, height);
    root.style.setProperty('--w-vv-height', `${height}px`);
    root.style.setProperty('--w-vv-offset', `${offset}px`);
    root.style.setProperty('--w-kb-inset', `${Math.max(0, window.innerHeight - height - offset)}px`);
    viewport.height = height;
    viewport.keyboard = tallest - height > KEYBOARD_MIN_PX && isEditable(document.activeElement);
    const layout = layoutFor(width, tallest);
    if (layout.wide !== media.wide) media.wide = layout.wide;
    if (layout.split !== media.split) media.split = layout.split;
    root.toggleAttribute(WIDE_ATTRIBUTE, layout.wide);
  };

  // Focus can move while Svelte is tearing DOM down (a focused field being
  // removed fires focusout synchronously); state must not change mid-update.
  let queued = 0;
  const applySoon = () => {
    clearTimeout(queued);
    queued = window.setTimeout(apply, 0);
  };

  apply();
  vv?.addEventListener('resize', apply);
  vv?.addEventListener('scroll', apply);
  window.addEventListener('resize', apply);
  document.addEventListener('focusin', applySoon);
  document.addEventListener('focusout', applySoon);
  return () => {
    vv?.removeEventListener('resize', apply);
    vv?.removeEventListener('scroll', apply);
    window.removeEventListener('resize', apply);
    clearTimeout(queued);
    document.removeEventListener('focusin', applySoon);
    document.removeEventListener('focusout', applySoon);
  };
}
