import { describe, it, expect } from 'vitest';
import { lexer } from '../lexer';

describe('lexer', () => {
  describe('text content', () => {
    it('lexes plain text', () => {
      const tokens = lexer('Hello world');
      expect(tokens).toEqual([{ type: 'text', content: 'Hello world' }]);
    });

    it('returns empty tokens for empty string', () => {
      expect(lexer('')).toEqual([]);
    });
  });

  describe('simple elements', () => {
    it('lexes self-closing tag', () => {
      const tokens = lexer('<br/>');
      expect(tokens).toHaveLength(3); // tag-start, tag(br), tag-end
      expect(tokens[0]).toEqual({ type: 'tag-start', close: false });
      expect(tokens[1]).toEqual({ type: 'tag', content: 'br' });
      expect(tokens[2]).toEqual({ type: 'tag-end', close: true });
    });

    it('lexes opening tag', () => {
      const tokens = lexer('<div>');
      const tagStart = tokens.find((t) => t.type === 'tag-start');
      const tag = tokens.find((t) => t.type === 'tag');
      const tagEnd = tokens.find((t) => t.type === 'tag-end');
      expect(tagStart).toEqual({ type: 'tag-start', close: false });
      expect(tag).toEqual({ type: 'tag', content: 'div' });
      expect(tagEnd).toEqual({ type: 'tag-end', close: false });
    });

    it('lexes closing tag', () => {
      const tokens = lexer('</div>');
      const tagStart = tokens.find((t) => t.type === 'tag-start');
      expect(tagStart).toEqual({ type: 'tag-start', close: true });
    });
  });

  describe('attributes', () => {
    it('lexes tag with single attribute', () => {
      const tokens = lexer('<div class="container">');
      const attrs = tokens.filter((t) => t.type === 'attribute');
      expect(attrs).toHaveLength(1);
      expect(attrs[0].content).toBe('class="container"');
    });

    it('lexes tag with multiple attributes', () => {
      const tokens = lexer('<img src="a.png" alt="photo" width="100"/>');
      const attrs = tokens.filter((t) => t.type === 'attribute');
      expect(attrs).toHaveLength(3);
    });

    it('lexes boolean attribute (no value)', () => {
      const tokens = lexer('<input disabled/>');
      const attrs = tokens.filter((t) => t.type === 'attribute');
      expect(attrs).toHaveLength(1);
      expect(attrs[0].content).toBe('disabled');
    });

    it('handles single-quoted attribute values', () => {
      const tokens = lexer("<div class='test'>");
      const attrs = tokens.filter((t) => t.type === 'attribute');
      expect(attrs).toHaveLength(1);
      expect(attrs[0].content).toBe("class='test'");
    });
  });

  describe('mixed content', () => {
    it('lexes element with text content', () => {
      const tokens = lexer('<p>Hello</p>');
      const types = tokens.map((t) => t.type);
      expect(types).toContain('tag-start');
      expect(types).toContain('tag');
      expect(types).toContain('text');
    });

    it('lexes nested elements', () => {
      const tokens = lexer('<div><span>text</span></div>');
      const tags = tokens.filter((t) => t.type === 'tag');
      const tagNames = tags.map((t) => t.content);
      expect(tagNames).toContain('div');
      expect(tagNames).toContain('span');
    });
  });

  describe('comments', () => {
    it('lexes HTML comment', () => {
      const tokens = lexer('<!-- this is a comment -->');
      const comment = tokens.find((t) => t.type === 'comment');
      expect(comment).toBeDefined();
      expect(comment!.content).toBe(' this is a comment ');
    });

    it('lexes comment between elements', () => {
      const tokens = lexer('<p>text</p><!-- comment --><p>more</p>');
      const comments = tokens.filter((t) => t.type === 'comment');
      expect(comments).toHaveLength(1);
    });
  });

  describe('childless tags (script/style)', () => {
    it('treats script content as text', () => {
      const tokens = lexer('<script>var x = 1;</script>');
      const texts = tokens.filter((t) => t.type === 'text');
      const scriptText = texts.find((t) => t.content.includes('var x'));
      expect(scriptText).toBeDefined();
    });

    it('treats style content as text', () => {
      const tokens = lexer('<style>.cls { color: red; }</style>');
      const texts = tokens.filter((t) => t.type === 'text');
      const styleText = texts.find((t) => t.content.includes('color'));
      expect(styleText).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('handles < in text that is not a tag', () => {
      const tokens = lexer('1 < 2 and 3 < 4');
      // Since < is not followed by /, !, or alphanumeric, it should be text
      expect(tokens.some((t) => t.type === 'text')).toBe(true);
    });

    it('handles unclosed comment', () => {
      const tokens = lexer('<!-- unclosed');
      const comment = tokens.find((t) => t.type === 'comment');
      expect(comment).toBeDefined();
      expect(comment!.content).toBe(' unclosed');
    });

    it('lexes complex real-world HTML', () => {
      const html =
        '<div class="wrapper"><h1 id="title">Hello</h1><p>Paragraph with <strong>bold</strong> text.</p></div>';
      const tokens = lexer(html);
      const tags = tokens.filter((t) => t.type === 'tag');
      expect(tags.length).toBeGreaterThan(0);
      const texts = tokens.filter((t) => t.type === 'text');
      expect(texts.length).toBeGreaterThan(0);
    });
  });
});
