// jsdom ships no types and @types/jsdom is not installed; this is all the tool and tests use.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown>);
    readonly window: Window & typeof globalThis;
  }
}
