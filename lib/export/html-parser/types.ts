export interface ElementAttribute {
  key: string;
  value: string | null;
}

export interface CommentElement {
  type: 'comment';
  content: string;
}

export interface TextElement {
  type: 'text';
  content: string;
}

export interface NormalElement {
  type: 'element';
  tagName: string;
  children: HTMLNode[];
  attributes: string[];
}

export type HTMLNode = CommentElement | TextElement | NormalElement;

export interface ElementAST {
  type: 'element';
  tagName: string;
  children: AST[];
  attributes: ElementAttribute[];
}

export interface CommentOrTextAST {
  type: 'comment' | 'text';
  content: string;
}

export type AST = CommentOrTextAST | ElementAST;

export interface TagStartToken {
  type: 'tag-start';
  close: boolean;
}

export interface TagEndToken {
  type: 'tag-end';
  close: boolean;
}

export interface TagToken {
  type: 'tag';
  content: string;
}

export interface TextToken {
  type: 'text';
  content: string;
}

export interface CommentToken {
  type: 'comment';
  content: string;
}

export interface AttributeToken {
  type: 'attribute';
  content: string;
}

export type Token =
  | TagStartToken
  | TagEndToken
  | TagToken
  | TextToken
  | CommentToken
  | AttributeToken;
