/**
 * PDF Content Summarization Module
 * 
 * When PDF content exceeds the context window limit, this module:
 * 1. Detects if there's a table of contents (TOC)
 * 2. If TOC exists, summarizes by chapters/sections
 * 3. If no TOC, splits content by length and summarizes each chunk
 */

import type { AICallFn } from './pipeline-types';

export interface SummaryOptions {
  maxChunkChars: number;
  language: 'zh-CN' | 'en';
}

export interface SummarizedChunk {
  title: string;
  summary: string;
  originalLength: number;
  summaryLength: number;
}

/**
 * Detect if content has a table of contents
 */
function detectTableOfContents(text: string): { hasTOC: boolean; sections: Array<{ title: string; startIndex: number }> } {
  const tocPatterns = [
    /目录[\s\S]{0,500}(?:\d+\.|第?\d+章|[\u4e00-\u9fa5]{2,10}\d*)[^\n]{5,50}/g,
    /Table of Contents[\s\S]{0,500}(?:\d+\.|[A-Z][\u4e00-\u9fa5]{2,20})[^\n]{5,50}/gi,
    /^第?\d+章[\s\S]{0,30}(?=\n)/gm,
    /^\d+\.\s+[\u4e00-\u9fa5]{2,20}/gm,
    /^[A-Z]\.\s+[\u4e00-\u9fa5]{2,20}/gim,
  ];
  
  const sections: Array<{ title: string; startIndex: number }> = [];
  
  for (const pattern of tocPatterns) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length >= 2) {
      for (const match of matches) {
        sections.push({
          title: match[0].trim(),
          startIndex: match.index || 0,
        });
      }
      break;
    }
  }
  
  // Sort by position and remove duplicates
  sections.sort((a, b) => a.startIndex - b.startIndex);
  const uniqueSections = sections.filter((s, i) => 
    i === 0 || s.title !== sections[i - 1].title
  );
  
  return {
    hasTOC: uniqueSections.length >= 2,
    sections: uniqueSections,
  };
}

/**
 * Split content into chunks by character count
 */
function splitContentByLength(text: string, maxChunkChars: number): string[] {
  const chunks: string[] = [];
  let currentChunk = '';
  
  // Split by paragraphs first to avoid cutting mid-paragraph
  const paragraphs = text.split(/\n\n+/);
  
  for (const paragraph of paragraphs) {
    if (currentChunk.length + paragraph.length > maxChunkChars && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = '';
    }
    currentChunk += paragraph + '\n\n';
  }
  
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

/**
 * Generate summary for a chunk of text
 */
async function summarizeChunk(
  chunk: string,
  title: string,
  aiCall: AICallFn,
  language: 'zh-CN' | 'en',
): Promise<string> {
  const systemPrompt = language === 'zh-CN'
    ? '你是一个专业的教科书内容总结助手。请用简洁的语言总结给定的文本，保留关键概念和重要信息。'
    : 'You are a professional textbook content summarizer. Please summarize the given text concisely while retaining key concepts and important information.';
  
  const userPrompt = language === 'zh-CN'
    ? `请总结以下文本（标题："${title}"）：\n\n${chunk}`
    : `Please summarize the following text (title: "${title}"):\n\n${chunk}`;
  
  const response = await aiCall(systemPrompt, userPrompt);
  return response.trim();
}

/**
 * Summarize PDF content by chapters (if TOC exists) or by length chunks
 */
export async function summarizePdfContent(
  pdfText: string,
  aiCall: AICallFn,
  options: SummaryOptions,
  onProgress?: (message: string) => void,
): Promise<string> {
  const { maxChunkChars, language } = options;
  
  // Check if summarization is needed
  if (pdfText.length <= maxChunkChars) {
    return pdfText;
  }
  
  onProgress?.(language === 'zh-CN' 
    ? '正在分析文档结构...' 
    : 'Analyzing document structure...');
  
  // Detect TOC
  const { hasTOC, sections } = detectTableOfContents(pdfText);
  
  if (hasTOC && sections.length >= 2) {
    // Summarize by chapters
    onProgress?.(language === 'zh-CN'
      ? `检测到目录，共 ${sections.length} 个章节，正在逐章总结...`
      : `Table of contents detected, ${sections.length} sections found, summarizing by chapter...`);
    
    const chapterSummaries: string[] = [];
    
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const nextSection = sections[i + 1];
      const endIndex = nextSection ? nextSection.startIndex : pdfText.length;
      const chapterText = pdfText.substring(section.startIndex, endIndex);
      
      const summary = await summarizeChunk(chapterText, section.title, aiCall, language);
      chapterSummaries.push(`## ${section.title}\n\n${summary}`);
      
      onProgress?.(language === 'zh-CN'
        ? `已总结第 ${i + 1}/${sections.length} 章`
        : `Summarized chapter ${i + 1}/${sections.length}`);
    }
    
    return chapterSummaries.join('\n\n---\n\n');
  } else {
    // Summarize by length chunks
    const chunks = splitContentByLength(pdfText, maxChunkChars);
    
    onProgress?.(language === 'zh-CN'
      ? `未检测到目录，将内容分成 ${chunks.length} 段进行总结...`
      : `No table of contents detected, splitting content into ${chunks.length} chunks for summarization...`);
    
    const chunkSummaries: string[] = [];
    
    for (let i = 0; i < chunks.length; i++) {
      const chunkTitle = language === 'zh-CN'
        ? `第 ${i + 1} 部分`
        : `Part ${i + 1}`;
      
      const summary = await summarizeChunk(chunks[i], chunkTitle, aiCall, language);
      chunkSummaries.push(summary);
      
      onProgress?.(language === 'zh-CN'
        ? `已总结第 ${i + 1}/${chunks.length} 部分`
        : `Summarized chunk ${i + 1}/${chunks.length}`);
    }
    
    return chunkSummaries.join('\n\n');
  }
}

/**
 * Check if summarization is needed and return appropriate content
 * This is the main entry point that integrates with the existing pipeline
 */
export async function processPdfContent(
  pdfText: string,
  aiCall: AICallFn,
  options: {
    maxContextChars: number;
    language: 'zh-CN' | 'en';
    summaryPrompt?: string;
  },
  onProgress?: (message: string) => void,
): Promise<{
  content: string;
  wasSummarized: boolean;
  originalLength: number;
  finalLength: number;
}> {
  const { maxContextChars, language } = options;
  const originalLength = pdfText.length;
  
  // If content fits within context, return as-is
  if (pdfText.length <= maxContextChars) {
    return {
      content: pdfText,
      wasSummarized: false,
      originalLength,
      finalLength: pdfText.length,
    };
  }
  
  // Summarization is needed
  onProgress?.(language === 'zh-CN'
    ? `内容超出上下文窗口限制（${pdfText.length} > ${maxContextChars} 字符），正在进行总结...`
    : `Content exceeds context window limit (${pdfText.length} > ${maxContextChars} chars), summarizing...`);
  
  const summarizedContent = await summarizePdfContent(
    pdfText,
    aiCall,
    {
      maxChunkChars: Math.floor(maxContextChars * 0.8), // Leave room for summary overhead
      language,
    },
    onProgress,
  );
  
  return {
    content: summarizedContent,
    wasSummarized: true,
    originalLength,
    finalLength: summarizedContent.length,
  };
}
