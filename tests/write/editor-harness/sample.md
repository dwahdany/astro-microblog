# The kitchen sink

A paragraph with **bold**, *italic*, ***both***, ~~struck~~ and `inline code`. A [link to the blog](https://blog.wahdany.eu/about/), a bare address https://example.com/path and an autolink <https://example.org>.

Footnotes are first class: a claim[^1], another[^note] and one with no note yet[^orphan]. Tap a chip to edit its note.

## Lists

- A bullet with enough text that it has to wrap onto a second line on a phone so the hanging indent can be seen doing its job
- Another
  - Nested one
  - Nested two with `code`
- Last

1. First step
2. Second step that is also long enough to wrap around at least once on a narrow screen, to check the numbers hang too
3. Third

- [ ] An open task
- [x] A finished task
- [ ] Another open one

## Quote

> The markdown text is the only source of truth.
> It continues on a second line.
>
> > And nests.

---

### Code

```js
// A fenced block
function greet(name) {
  return `Hello, ${name}!`;
}
```

    indented code

### Math

Inline $e^{i\pi} + 1 = 0$ and a size $|\mathcal{T}| = 100$, then display:

$$
\hat{\mathbf{m}} = \arg\min_{\mathbf{m}} \|\mathbf{A}\mathbf{m} - \mathbf{s}\|_2^2
$$

and one-line display math:

$$\text{score}(f, t_i) = \alpha \cdot s(f, t_i) + (1 - \alpha)$$

### Images

![A placeholder image|small](/favicon.svg)

![Missing image](does/not/exist.png)

### Table and HTML

| Column | Other |
| ------ | ----- |
| a      | b     |

<details>
<summary>Raw HTML stays as text</summary>
</details>

#### A fourth-level heading

Final paragraph.

[^1]: The first note, with *emphasis* and a [link](https://example.com).
[^note]: A named note.
    It continues on an indented line.
[^unused]: Nothing points here.
