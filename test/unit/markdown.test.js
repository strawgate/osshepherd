const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const md = require('../../src/utils/markdown');

describe('CRMarkdown.render', () => {
  describe('inline formatting', () => {
    it('renders bold', () => {
      assert.ok(md.render('**hello**').includes('<strong>hello</strong>'));
    });

    it('renders italic', () => {
      assert.ok(md.render('*hello*').includes('<em>hello</em>'));
    });

    it('renders inline code', () => {
      assert.ok(md.render('use `foo()` here').includes('<code>foo()</code>'));
    });

    it('does not apply bold inside inline code', () => {
      const html = md.render('`**not bold**`');
      assert.ok(html.includes('<code>**not bold**</code>'));
      assert.ok(!html.includes('<strong>'));
    });

    it('renders links', () => {
      const html = md.render('[click](https://example.com)');
      assert.ok(html.includes('href="https://example.com"'));
      assert.ok(html.includes('>click</a>'));
    });
  });

  describe('block elements', () => {
    it('renders fenced code blocks', () => {
      const html = md.render('```js\nconst x = 1;\n```');
      assert.ok(html.includes('<pre class="cr-code-block">'));
      assert.ok(html.includes('const x = 1;'));
    });

    it('renders diff code blocks with line highlighting', () => {
      const html = md.render('```diff\n-old\n+new\n@@hunk\n```');
      assert.ok(html.includes('cr-diff-del'));
      assert.ok(html.includes('cr-diff-add'));
      assert.ok(html.includes('cr-diff-hunk'));
    });

    it('renders headings', () => {
      assert.ok(md.render('## Title').includes('<h2>'));
    });

    it('renders unordered lists', () => {
      const html = md.render('- one\n- two');
      assert.ok(html.includes('<ul>'));
      assert.ok(html.includes('<li>one</li>'));
      assert.ok(html.includes('<li>two</li>'));
    });

    it('renders ordered lists', () => {
      const html = md.render('1. first\n2. second');
      assert.ok(html.includes('<ol>'));
      assert.ok(html.includes('<li>first</li>'));
    });

    it('renders horizontal rules', () => {
      assert.ok(md.render('---').includes('<hr>'));
    });
  });

  describe('HTML pass-through', () => {
    it('passes through details/summary tags', () => {
      const input = '<details>\n<summary>Show</summary>\n\nContent here\n\n</details>';
      const html = md.render(input);
      assert.ok(html.includes('<details>'));
      assert.ok(html.includes('<summary>Show</summary>'));
      assert.ok(html.includes('</details>'));
    });

    it('strips HTML comments', () => {
      const html = md.render('hello\n<!-- comment -->\nworld');
      assert.ok(!html.includes('comment'));
      assert.ok(html.includes('hello'));
      assert.ok(html.includes('world'));
    });
  });

  describe('CodeRabbit real output', () => {
    it('renders a typical review comment with code suggestion', () => {
      const input = [
        '**YAML syntax issue: missing space.**',
        '',
        '`issues:[#45944]` is missing the space after the colon.',
        '',
        '<details>',
        '<summary>Proposed fix</summary>',
        '',
        '```diff',
        '-issues:[#45944]',
        '+issues: [45944]',
        '```',
        '</details>',
      ].join('\n');

      const html = md.render(input);
      assert.ok(html.includes('<strong>YAML syntax issue: missing space.</strong>'));
      assert.ok(html.includes('<code>issues:[#45944]</code>'));
      assert.ok(html.includes('<details>'));
      assert.ok(html.includes('cr-diff-del'));
      assert.ok(html.includes('cr-diff-add'));
      assert.ok(html.includes('</details>'));
    });
  });
});

describe('CRMarkdown.escapeHtml', () => {
  it('escapes HTML special characters', () => {
    assert.equal(md.escapeHtml('<script>"&'), '&lt;script&gt;&quot;&amp;');
  });

  it('handles empty/null input', () => {
    assert.equal(md.escapeHtml(''), '');
    assert.equal(md.escapeHtml(null), 'null');
  });
});
