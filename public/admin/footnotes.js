// Footnote support for the Sveltia CMS rich-text editor.
//
// Sveltia has no footnote node. It preserves footnotes that are already in a
// file, but escapes any `[^1]` typed in rich-text mode (saved as `\[^1]`),
// which breaks it. These two editor components make GFM footnotes first-class:
//
//   Insert > Footnote reference   ->  text[^1]
//   Insert > Footnote             ->  [^1]: The note.
//
// Must be loaded as a classic script right after sveltia-cms.js.
(function () {
  if (typeof CMS === 'undefined' || typeof CMS.registerEditorComponent !== 'function') {
    console.warn('Footnote components not registered: CMS API unavailable');
    return;
  }

  const LABEL = /^[^\]\s]+$/;

  /** Labels of all footnote references currently in the editor(s). */
  function existingLabels() {
    return [...document.querySelectorAll('[data-component-name$="footnote-ref"]')].map((el) =>
      el.textContent.trim().replace(/^\[|\]$/g, ''),
    );
  }

  /** Next free number, e.g. 3 when [^1] and [^2] exist. */
  function nextLabel() {
    const numbers = existingLabels().map(Number).filter(Number.isInteger);
    return String(Math.max(0, ...numbers) + 1);
  }

  function askLabel(initial) {
    const answer = window.prompt('Footnote label (number or name, no spaces)', initial);
    if (answer === null) return null;
    const id = answer.trim();
    if (!LABEL.test(id)) {
      window.alert('A footnote label cannot be empty or contain spaces or "]".');
      return null;
    }
    return { id };
  }

  function escapeHtml(value) {
    return String(value).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  }

  /** Render the note's markdown for the preview pane, falling back to plain text. */
  function renderNote(text) {
    try {
      if (typeof window.marked?.parse === 'function') {
        const html = window.marked.parse(text.replace(/^(?: {4}|\t)/gm, ''));
        return window.DOMPurify ? window.DOMPurify.sanitize(html) : escapeHtml(text);
      }
    } catch {
      // fall through
    }
    return `<p>${escapeHtml(text)}</p>`;
  }

  try {
    // Inline reference: `[^1]`. Not preceded by a backslash (an escaped literal)
    // and not followed by a colon (that is a definition).
    CMS.registerEditorComponent({
      id: 'footnote-ref',
      type: 'inline',
      label: 'Footnote reference',
      icon: 'superscript',
      pattern: /(?<!\\)\[\^(?<id>[^\]\s]+)\](?!:)/,
      trigger: '[^',
      fromInline: (match) => ({ id: match.groups.id }),
      toInline: ({ id } = {}) => `[^${id ?? '1'}]`,
      toPreview: ({ id } = {}) => `<sup>[${escapeHtml(id ?? '1')}]</sup>`,
      onInsert: () => askLabel(nextLabel()),
      onEdit: ({ data }) => askLabel(data?.id ?? nextLabel()),
    });

    // Block definition: `[^1]: The note.` including lazy continuation lines and
    // 4-space/tab-indented continuation paragraphs. The text is stored verbatim.
    CMS.registerEditorComponent({
      id: 'footnote-def',
      label: 'Footnote',
      icon: 'notes',
      fields: [
        {
          name: 'id',
          label: 'Label',
          widget: 'string',
          pattern: ['^[^\\]\\s]+$', 'No spaces or "]"'],
          hint: 'Must match the label of the footnote reference, e.g. 1',
        },
        {
          name: 'text',
          label: 'Text',
          widget: 'text',
          hint: 'Markdown. Indent further paragraphs by four spaces.',
        },
      ],
      pattern:
        /^\[\^(?<id>[^\]\s]+)\]:[ \t]?(?<text>[^\n]*(?:\n(?!\[\^[^\]\s]+\]:)[^\n]+|\n+(?: {4}|\t)[^\n]*)*)/m,
      toBlock: ({ id, text } = {}) => `[^${id ?? '1'}]: ${text ?? ''}`,
      toPreview: ({ id, text } = {}) => {
        const marker = `<sup>[${escapeHtml(id ?? '')}]</sup> `;
        const html = renderNote(text ?? '').trim();
        // Put the marker on the note's first line rather than above it
        return /^<p[^>]*>/.test(html)
          ? html.replace(/^<p[^>]*>/, (open) => open + marker)
          : `<p>${marker}</p>${html}`;
      },
    });
  } catch (error) {
    // Existing footnotes still round-trip without the components; only the
    // Insert menu entries are lost.
    console.error('Failed to register footnote components:', error);
  }
})();
