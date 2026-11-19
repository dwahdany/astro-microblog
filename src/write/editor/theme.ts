/**
 * How the writing surface looks. Every colour, font, radius and duration is a
 * `--w-*` token from the contract (THEME_TOKENS), so switching
 * <html data-write-theme> restyles the editor with no code involved. The only
 * literals here are geometry (em-relative sizes and offsets).
 *
 * `--cm-quote` (blockquote depth) and `--cm-hang` (characters of list prefix)
 * are set per line by the live preview.
 */
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/** Width given to each character of a list prefix, in em. */
const CH = '0.6em';
const QUOTE_STEP = '1.15em';
const tint = (token: string, pct: number) => `color-mix(in srgb, var(${token}) ${pct}%, transparent)`;

const look = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--w-ink)',
    backgroundColor: 'transparent',
    fontSize: 'var(--w-prose-size)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--w-font-prose)',
    lineHeight: 'var(--w-prose-leading)',
    fontWeight: 'var(--w-prose-weight)',
    overflowX: 'hidden',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    WebkitOverflowScrolling: 'touch',
  },
  '.cm-content': {
    boxSizing: 'content-box',
    width: 'auto',
    maxWidth: 'var(--w-prose-measure)',
    minWidth: '0',
    margin: '0 auto',
    padding: 'var(--w-space-5) var(--w-gutter) 45vh',
    caretColor: 'var(--w-accent-text)',
    // Long URLs and code must wrap rather than widen the page on a phone.
    overflowWrap: 'anywhere',
    wordBreak: 'normal',
  },
  // CodeMirror puts zero-width <img> buffers around hidden markup and widgets. In the flow each one is
  // a place where the line may break, which strands the punctuation after a link or code span on the
  // next line (". First, …"). Out of the flow they keep their place but offer no break. A line whose
  // only content is hidden (a code fence) then has nothing in the flow, hence the minimum height.
  '.cm-line': { padding: '0', minHeight: '1lh' },
  '.cm-widgetBuffer': { position: 'absolute' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--w-accent-text)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--w-selection)',
  },
  '.cm-placeholder': { color: 'var(--w-ink-3)' },

  /* ---- headings ---- */
  '.cm-h': {
    fontFamily: 'var(--w-font-display)',
    fontWeight: 'var(--w-heading-weight)',
    lineHeight: 'var(--w-heading-leading)',
    letterSpacing: 'var(--w-heading-tracking)',
    fontStretch: 'var(--w-heading-stretch)',
    color: 'var(--w-syn-heading)',
    paddingTop: '0.3em',
    paddingBottom: '0.1em',
  },
  '.cm-h1': { fontSize: 'var(--w-h1)' },
  '.cm-h2': { fontSize: 'var(--w-h2)' },
  '.cm-h3': { fontSize: 'var(--w-h3)' },
  '.cm-h4, .cm-h5, .cm-h6': { fontSize: 'var(--w-h4)' },
  '.cm-h5, .cm-h6': { color: 'var(--w-ink-2)' },
  '.cm-setext-rule': { color: 'var(--w-syn-mark)' },

  /* ---- inline ---- */
  '.cm-strong': { fontWeight: 'var(--w-prose-strong-weight)' },
  '.cm-h .cm-strong': { fontWeight: 'inherit' },
  '.cm-em': { fontStyle: 'italic' },
  '.cm-strike': { textDecoration: 'line-through', color: 'var(--w-ink-2)' },
  '.cm-inline-code': {
    fontFamily: 'var(--w-font-mono)',
    fontSize: '0.88em',
    color: 'var(--w-syn-code)',
    backgroundColor: 'var(--w-syn-code-bg)',
    borderRadius: 'var(--w-radius-xs)',
    padding: '0.12em 0.3em',
  },
  '.cm-link': {
    color: 'var(--w-syn-link)',
    textDecoration: 'underline',
    textDecorationThickness: '0.06em',
    textUnderlineOffset: '0.18em',
  },
  // An address being typed or corrected is text to read, not markup to tune out: secondary ink, not the dim one.
  '.cm-url, .cm-linkref, .cm-image-src': { color: 'var(--w-ink-2)' },
  '.cm-hr-src': { color: 'var(--w-syn-mark)' },
  '.cm-w-urlstub': { color: 'var(--w-syn-mark)', cursor: 'pointer', textIndent: '0', fontStyle: 'normal', fontWeight: 'var(--w-prose-weight)' },
  '.cm-w-urlstub:hover': { color: 'var(--w-syn-link)' },
  '.cm-html, .cm-html-inline': { fontFamily: 'var(--w-font-mono)', fontSize: '0.88em', color: 'var(--w-ink-2)' },

  /* ---- quotes and lists ---- */
  '.cm-quote, .cm-hang': {
    paddingLeft: `calc(var(--cm-quote, 0) * ${QUOTE_STEP} + var(--cm-hang, 0) * ${CH})`,
    textIndent: `calc(var(--cm-hang, 0) * -${CH})`,
  },
  // The bar is a pseudo-element that overlaps the next line by a pixel: separate line boxes with
  // fractional heights would otherwise leave hairline gaps in it.
  '.cm-quote': { position: 'relative', color: 'var(--w-syn-quote)' },
  '.cm-quote::before': {
    content: '""',
    position: 'absolute',
    left: '0',
    top: '0',
    bottom: '-1px',
    width: '3px',
    backgroundColor: 'var(--w-syn-quote-bar)',
    pointerEvents: 'none',
  },
  '.cm-quote-2::before': { boxShadow: `${QUOTE_STEP} 0 0 var(--w-syn-quote-bar)` },
  '.cm-quote-3::before': {
    boxShadow: `${QUOTE_STEP} 0 0 var(--w-syn-quote-bar), calc(2 * ${QUOTE_STEP}) 0 0 var(--w-syn-quote-bar)`,
  },
  // Each piece of a list prefix (indent, marker, gap) is a fixed-width cell that hangs in the line's
  // padding, so wrapped text aligns with the first line whatever the font.
  '.cm-cell': {
    display: 'inline-block',
    // min-width, not width: a raw marker in a wide face may need a little more room.
    minWidth: `calc(var(--cm-n, 0) * ${CH})`,
    textIndent: '0',
    whiteSpace: 'pre',
  },
  '.cm-list-number, .cm-list-number span': { color: 'var(--w-accent-text)', fontVariantNumeric: 'tabular-nums' },
  '.cm-list-mark, .cm-list-mark span': { color: 'var(--w-syn-mark)' },
  '.cm-task-done': { color: 'var(--w-ink-3)' },
  // Widgets are inline-blocks: they must not inherit a line's negative indent.
  '.cm-w-bullet, .cm-w-task, .cm-w-hr, .cm-w-fence, .cm-w-fn, .cm-w-fndef, .cm-w-imgchip, .cm-w-math, .cm-w-image, .cm-w-mathblock':
    { textIndent: '0' },
  '.cm-w-bullet': { display: 'inline-block', width: CH, color: 'var(--w-accent-text)' },
  '.cm-w-task': {
    display: 'inline-block',
    position: 'relative',
    width: `calc(2 * ${CH})`,
    height: '1em',
    verticalAlign: '-0.12em',
    cursor: 'pointer',
  },
  // A generous invisible hit area around the small box.
  '.cm-w-task::after, .cm-w-fn::after, .cm-w-fndef::after': { content: '""', position: 'absolute', inset: '-0.55em -0.4em' },
  '.cm-w-task-box': {
    position: 'absolute',
    left: '0',
    top: '0',
    boxSizing: 'border-box',
    width: '1em',
    height: '1em',
    border: 'var(--w-border) solid var(--w-line-strong)',
    borderRadius: 'var(--w-radius-xs)',
    backgroundColor: 'var(--w-surface)',
    transition: 'background-color var(--w-dur-1) var(--w-ease)',
  },
  '.cm-w-task[aria-checked="true"] .cm-w-task-box': {
    backgroundColor: 'var(--w-accent)',
    borderColor: 'var(--w-accent)',
  },
  '.cm-w-task[aria-checked="true"] .cm-w-task-box::after': {
    content: '""',
    position: 'absolute',
    left: '30%',
    top: '8%',
    width: '25%',
    height: '55%',
    borderRight: '0.14em solid var(--w-accent-ink)',
    borderBottom: '0.14em solid var(--w-accent-ink)',
    transform: 'rotate(40deg)',
  },

  /* ---- rules ---- */
  '.cm-w-hr': {
    display: 'inline-block',
    width: '100%',
    height: '0',
    verticalAlign: 'middle',
    borderTop: 'var(--w-border) solid var(--w-line-strong)',
  },

  /* ---- code ---- */
  '.cm-code': {
    fontFamily: 'var(--w-font-mono)',
    fontSize: '0.86em',
    lineHeight: '1.6',
    color: 'var(--w-syn-code)',
    backgroundColor: 'var(--w-syn-code-bg)',
    paddingLeft: `calc(0.9em + var(--cm-quote, 0) * ${QUOTE_STEP} + var(--cm-hang, 0) * ${CH})`,
    paddingRight: '0.9em',
    backgroundClip: 'border-box',
  },
  // Close the hairline gaps between the backgrounds of consecutive lines.
  '.cm-code:not(.cm-code-close)': { boxShadow: '0 1px 0 var(--w-syn-code-bg)' },
  '.cm-code-open': { borderTopLeftRadius: 'var(--w-radius-sm)', borderTopRightRadius: 'var(--w-radius-sm)' },
  '.cm-code-close': { borderBottomLeftRadius: 'var(--w-radius-sm)', borderBottomRightRadius: 'var(--w-radius-sm)' },
  '.cm-code-fence': { color: 'var(--w-syn-mark)' },
  '.cm-w-fence': {
    fontFamily: 'var(--w-font-ui)',
    fontSize: 'var(--w-text-xs)',
    fontWeight: 'var(--w-ui-strong-weight)',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--w-ink-3)',
  },
  '.cm-table': { fontFamily: 'var(--w-font-mono)', fontSize: '0.82em', color: 'var(--w-ink-2)' },

  /* ---- footnotes ---- */
  '.cm-w-fn': {
    position: 'relative',
    // Inline, not inline-block: an inline-block may be wrapped away from the word it belongs to and
    // lets the full stop after it start the next line. As inline text "…pointless³." breaks like a word.
    display: 'inline',
    padding: '0.12em 0.5em',
    margin: '0 0.08em',
    // Raised without `vertical-align: super`, which would make the line taller.
    verticalAlign: 'baseline',
    top: '-0.55em',
    fontFamily: 'var(--w-font-ui)',
    fontSize: '0.68em',
    fontStyle: 'normal',
    fontWeight: 'var(--w-ui-strong-weight)',
    lineHeight: '1',
    letterSpacing: '0',
    textAlign: 'center',
    textDecoration: 'none',
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--w-syn-footnote)',
    backgroundColor: tint('--w-syn-footnote', 13),
    borderRadius: 'var(--w-radius-pill)',
    cursor: 'pointer',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    transition: 'background-color var(--w-dur-1) var(--w-ease), color var(--w-dur-1) var(--w-ease)',
  },
  // A fingertip needs more than a 19px superscript: on touch screens the chip answers a little beyond its edge.
  '@media (pointer: coarse)': {
    '.cm-w-fn::after': { content: '""', position: 'absolute', inset: '-0.75em -0.55em' },
  },
  '.cm-w-fn:hover': { backgroundColor: tint('--w-syn-footnote', 24) },
  '.cm-w-fn-active, .cm-w-fn-active:hover': { color: 'var(--w-surface)', backgroundColor: 'var(--w-syn-footnote)' },
  '.cm-w-fn-orphan': {
    color: 'var(--w-warn)',
    backgroundColor: 'transparent',
    boxShadow: 'inset 0 0 0 var(--w-border) var(--w-warn)',
    borderRadius: 'var(--w-radius-xs)',
  },
  '.cm-w-fn-orphan::before': { content: '"?"', marginRight: '0.15em', opacity: '0.8' },
  '.cm-fn-def': { fontSize: '0.92em', color: 'var(--w-ink-2)' },
  '.cm-fn-section': {
    paddingTop: '0.9em',
    backgroundImage: 'linear-gradient(var(--w-line), var(--w-line))',
    backgroundRepeat: 'no-repeat',
    backgroundSize: '6em var(--w-border)',
    backgroundPosition: '0 0.35em',
  },
  '.cm-w-fndef': {
    position: 'relative',
    display: 'inline-block',
    boxSizing: 'border-box',
    minWidth: '1.6em',
    padding: '0.2em 0.45em',
    marginRight: '0.15em',
    fontFamily: 'var(--w-font-ui)',
    fontSize: '0.78em',
    fontWeight: 'var(--w-ui-strong-weight)',
    lineHeight: '1',
    textAlign: 'center',
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--w-syn-footnote)',
    backgroundColor: tint('--w-syn-footnote', 13),
    borderRadius: 'var(--w-radius-pill)',
    cursor: 'pointer',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },
  '.cm-w-fndef.cm-w-fn-active': { color: 'var(--w-surface)', backgroundColor: 'var(--w-syn-footnote)' },
  '.cm-w-fndef.cm-w-fn-orphan': { color: 'var(--w-warn)', backgroundColor: 'transparent' },

  /* ---- math ---- */
  '.cm-math-src, .cm-math-line': { fontFamily: 'var(--w-font-mono)', fontSize: '0.88em', color: 'var(--w-syn-math)' },
  '.cm-math-line': { backgroundColor: tint('--w-syn-math', 7), paddingLeft: '0.9em', paddingRight: '0.9em' },
  '.cm-math-open': { borderTopLeftRadius: 'var(--w-radius-sm)', borderTopRightRadius: 'var(--w-radius-sm)' },
  '.cm-math-close': { borderBottomLeftRadius: 'var(--w-radius-sm)', borderBottomRightRadius: 'var(--w-radius-sm)' },
  '.cm-w-math': { color: 'var(--w-syn-math)', fontStyle: 'normal', fontWeight: 'normal', letterSpacing: '0' },
  '.cm-w-math[data-state="pending"], .cm-w-math[data-state="error"], .cm-w-math[data-state="unavailable"], .cm-w-mathblock-inner[data-state="pending"], .cm-w-mathblock-inner[data-state="error"], .cm-w-mathblock-inner[data-state="unavailable"]':
    { fontFamily: 'var(--w-font-mono)', fontSize: '0.88em', whiteSpace: 'pre-wrap' },
  '.cm-w-math[data-state="error"], .cm-w-mathblock-inner[data-state="error"]': {
    color: 'var(--w-danger)',
    textDecoration: 'underline wavy',
    textDecorationThickness: '0.05em',
    textUnderlineOffset: '0.2em',
  },
  '.cm-w-math .katex': { fontSize: '1.08em' },
  '.cm-w-math-display': { display: 'inline-block', width: '100%', textAlign: 'center', overflowX: 'auto', overflowY: 'hidden' },
  '.cm-w-math-display .katex-display': { margin: '0.3em 0' },
  '.cm-w-mathblock': {
    padding: '0.5em 0',
    color: 'var(--w-syn-math)',
    textAlign: 'center',
    lineHeight: '1.3',
    cursor: 'text',
  },
  '.cm-w-mathblock-inner': { overflowX: 'auto', overflowY: 'hidden', maxWidth: '100%' },
  '.cm-w-mathblock .katex-display': { margin: '0' },
  '.cm-w-mathblock-preview': {
    marginTop: '0.2em',
    borderTop: 'var(--w-border) dashed var(--w-line)',
  },

  /* ---- images ---- */
  '.cm-w-imgchip': {
    fontFamily: 'var(--w-font-ui)',
    fontSize: 'var(--w-text-sm)',
    fontStyle: 'normal',
    fontWeight: 'var(--w-ui-weight)',
    color: 'var(--w-ink-3)',
  },
  '.cm-w-imgchip-icon': {
    display: 'inline-block',
    boxSizing: 'border-box',
    width: '1em',
    height: '0.78em',
    marginRight: '0.45em',
    verticalAlign: '-0.05em',
    border: '0.09em solid currentColor',
    borderRadius: 'var(--w-radius-xs)',
    backgroundImage: 'linear-gradient(135deg, transparent 55%, currentColor 55%)',
    opacity: '0.75',
  },
  '.cm-w-image': { padding: '0.35em 0 0.6em', lineHeight: '0', cursor: 'text' },
  // A picture with an address opens the image panel; the one the panel is open for is outlined.
  '.cm-w-image[role="button"]': { cursor: 'pointer' },
  '.cm-w-image[data-panel-open] img, .cm-w-image[data-panel-open] .cm-w-image-missing': {
    outline: '2px solid var(--w-focus)',
    outlineOffset: '2px',
  },
  '.cm-w-image img': {
    display: 'block',
    maxWidth: '100%',
    width: 'auto',
    height: 'auto',
    maxHeight: 'min(70vh, 640px)',
    objectFit: 'contain',
    borderRadius: 'var(--w-radius-sm)',
    backgroundColor: 'var(--w-surface-2)',
  },
  '.cm-w-image[data-size="small"] img': { maxWidth: 'min(24rem, 100%)', margin: '0 auto' },
  '.cm-w-image[data-size="medium"] img': { maxWidth: 'min(36rem, 100%)', margin: '0 auto' },
  // Full is wider than the text on the site; the writing column has no room for that, so it is said in words.
  '.cm-w-image[data-size="full"]::before': {
    content: '"Full width"',
    display: 'block',
    marginBottom: '0.35em',
    fontFamily: 'var(--w-font-ui)',
    fontSize: 'var(--w-text-sm)',
    lineHeight: '1.4',
    letterSpacing: 'var(--w-ui-tracking)',
    color: 'var(--w-ink-3)',
  },
  '.cm-w-image:not([data-state]) img:not([width])': { minHeight: '8em', minWidth: '40%' },
  '.cm-w-image-missing': {
    display: 'block',
    padding: 'var(--w-space-3) var(--w-space-4)',
    fontFamily: 'var(--w-font-ui)',
    fontSize: 'var(--w-text-sm)',
    lineHeight: '1.4',
    color: 'var(--w-ink-3)',
    border: 'var(--w-border) dashed var(--w-line)',
    borderRadius: 'var(--w-radius-sm)',
    overflowWrap: 'anywhere',
  },

  /* ---- tooltips (link actions) ---- */
  '.cm-tooltip': {
    border: 'var(--w-border) solid var(--w-line)',
    borderRadius: 'var(--w-radius-md)',
    backgroundColor: 'var(--w-surface)',
    color: 'var(--w-ink)',
    boxShadow: 'var(--w-shadow-2)',
    fontFamily: 'var(--w-font-ui)',
    overflow: 'hidden',
  },
  '.cm-w-linktip': {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--w-space-2)',
    minHeight: 'var(--w-tap)',
    maxWidth: 'min(20rem, 80vw)',
    padding: '0 var(--w-space-3)',
    border: '0',
    background: 'none',
    color: 'var(--w-accent-text)',
    font: 'inherit',
    fontSize: 'var(--w-text-sm)',
    fontWeight: 'var(--w-ui-strong-weight)',
    letterSpacing: 'var(--w-ui-tracking)',
    cursor: 'pointer',
    textAlign: 'left',
  },
  '.cm-w-linktip:hover': { backgroundColor: 'var(--w-accent-soft)' },
  '.cm-w-linktip-url': {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--w-ink-2)',
    fontWeight: 'var(--w-ui-weight)',
  },
  '.cm-w-linktip-go': { flex: 'none' },
});

/** Syntax colours: dimmed markdown marks, and tokens inside fenced code. */
const highlight = HighlightStyle.define([
  { tag: [t.processingInstruction, t.contentSeparator, t.escape], color: 'var(--w-syn-mark)', fontWeight: 'var(--w-prose-weight)', fontStyle: 'normal' },
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.tagName], color: 'var(--w-code-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.attributeValue], color: 'var(--w-code-string)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.color], color: 'var(--w-code-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta], color: 'var(--w-code-comment)', fontStyle: 'italic' },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)), t.className, t.typeName, t.namespace, t.macroName, t.attributeName],
    color: 'var(--w-code-fn)',
  },
]);

export function editorTheme(): Extension {
  return [look, syntaxHighlighting(highlight)];
}
