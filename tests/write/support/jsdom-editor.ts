/**
 * What CodeMirror needs from a DOM that jsdom does not provide, so the REAL editor component can
 * be mounted in unit tests. jsdom has no layout: nothing here measures anything, it only keeps
 * CodeMirror's measuring code from throwing. Tests that depend on geometry (scrolling, the
 * on-screen keyboard, where a panel sits) belong in the Playwright suites.
 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

export function installEditorDom(): void {
  const g = globalThis as unknown as { ResizeObserver?: unknown };
  g.ResizeObserver ??= NoopResizeObserver;
  const noRects = Object.assign([], { item: () => null }) as unknown as DOMRectList;
  const zero = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect;
  Range.prototype.getClientRects ??= () => noRects;
  Range.prototype.getBoundingClientRect ??= () => zero;
  // The app sizes itself with `matchMedia` in a few places; jsdom has none.
  window.matchMedia ??= ((query: string) =>
    ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }) as unknown as MediaQueryList) as typeof window.matchMedia;
}
