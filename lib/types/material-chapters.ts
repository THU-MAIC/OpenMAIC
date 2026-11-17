/** Automatically recognized structure; pages are one-based source page numbers. */
export interface MaterialSection {
  title: string;
  startPage: number;
}

export interface MaterialChapter extends MaterialSection {
  sections: MaterialSection[];
}
