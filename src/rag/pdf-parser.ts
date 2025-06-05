import fs from 'fs';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { Document } from '../types';
import { logger } from '../utils';
import { v4 as uuidv4 } from 'uuid';

export interface PDFParseOptions {
  /**
   * The strategy for splitting the PDF
   * - 'simple': Split by character count
   * - 'paragraph': Split by paragraphs
   * - 'section': Split by detected sections/headers (most intelligent)
   */
  splitStrategy: 'simple' | 'paragraph' | 'section';
  
  /**
   * Size of chunks when using 'simple' strategy
   */
  chunkSize?: number;
  
  /**
   * Overlap between chunks when using 'simple' or 'paragraph' strategy
   */
  chunkOverlap?: number;
  
  /**
   * Whether to include page numbers in metadata
   */
  includePageNumbers?: boolean;
  
  /**
   * Custom metadata to attach to each document
   */
  metadata?: Record<string, any>;
}

export interface PDFParseResult {
  /**
   * The documents extracted from the PDF, ready to be added to RAG
   */
  documents: Omit<Document, 'id'>[];
  
  /**
   * Metadata about the PDF itself
   */
  pdfMetadata: {
    title?: string;
    author?: string;
    numPages: number;
    creationDate?: Date;
  };
  
  /**
   * Unique identifier for this PDF document
   */
  documentId: string;
}

/**
 * Parse a PDF file and extract structured content for RAG
 * @param filePath Path to the PDF file
 * @param options Options for parsing and chunking
 * @returns Promise resolving to the parsed documents
 */
export async function parsePDF(
  filePath: string,
  options: PDFParseOptions
): Promise<PDFParseResult> {
  try {
    logger.debug(`Parsing PDF: ${filePath}`);
    
    // Generate a unique document ID for this PDF
    const documentId = uuidv4();
    
    // Set default options
    const opts: Required<PDFParseOptions> = {
      splitStrategy: options.splitStrategy || 'section',
      chunkSize: options.chunkSize || 1000,
      chunkOverlap: options.chunkOverlap || 200,
      includePageNumbers: options.includePageNumbers !== undefined ? options.includePageNumbers : true,
      metadata: options.metadata || {},
    };
    
    // Read the PDF file
    const dataBuffer = fs.readFileSync(filePath);
    
    // Load the PDF document
    const pdfDoc = await PDFDocument.load(dataBuffer);
    
    // Get PDF metadata - pdf-lib uses individual getters instead of a single getMetadata method
    const title = pdfDoc.getTitle();
    const author = pdfDoc.getAuthor();
    const creationDate = pdfDoc.getCreationDate();
    
    // Count pages
    const numPages = pdfDoc.getPageCount();
    
    // Extract text content from all pages
    let allText = '';
    
    // Basic text extraction
    logger.debug(`Extracting text from PDF with ${numPages} pages`);
    
    try {
      const pdfParse = await import('pdf-parse');
      const data = await pdfParse.default(dataBuffer);
      allText = data.text;
      
      logger.debug(`Successfully extracted ${allText.length} characters of text`);
    } catch (error) {
      logger.error("Error extracting text from PDF:", error);
      // Fallback to basic info when text extraction fails
      allText = `PDF document with ${numPages} pages. Text extraction failed.`;
    }
    
    // Create base metadata with document identification
    const baseMetadata = {
      source: path.basename(filePath),
      documentId: documentId,  // Add document ID to all chunks
      fileName: path.basename(filePath),
      filePath: filePath,
      ...opts.metadata,
    };
    
    // PDF metadata for the result
    const pdfMetadata = {
      title: title || path.basename(filePath),
      author: author,
      numPages: numPages,
      creationDate: creationDate ? new Date(creationDate) : undefined,
    };
    
    // Get documents based on splitting strategy
    const documents = await splitPDFContent(allText, numPages, opts, baseMetadata);
    
    logger.debug(`PDF parsed successfully: ${documents.length} chunks created for document ${documentId}`);
    
    return {
      documents,
      pdfMetadata,
      documentId,
    };
  } catch (error) {
    logger.error(`Error parsing PDF ${filePath}:`, error);
    throw error;
  }
}

/**
 * Split PDF content based on the specified strategy
 */
async function splitPDFContent(
  text: string,
  numPages: number,
  options: Required<PDFParseOptions>,
  baseMetadata: Record<string, any>
): Promise<Omit<Document, 'id'>[]> {
  const { splitStrategy } = options;
  
  switch (splitStrategy) {
    case 'simple':
      return splitBySimpleChunks(text, numPages, options, baseMetadata);
    case 'paragraph':
      return splitByParagraphs(text, numPages, options, baseMetadata);
    case 'section':
      return splitBySections(text, numPages, options, baseMetadata);
    default:
      logger.warn(`Unknown split strategy: ${splitStrategy}, falling back to 'section'`);
      return splitBySections(text, numPages, options, baseMetadata);
  }
}

/**
 * Split PDF content into simple fixed-size chunks
 */
function splitBySimpleChunks(
  text: string,
  numPages: number,
  options: Required<PDFParseOptions>,
  baseMetadata: Record<string, any>
): Omit<Document, 'id'>[] {
  const { chunkSize, chunkOverlap } = options;
  const chunks: Omit<Document, 'id'>[] = [];
  
  // Estimate content per page to track page numbers
  const avgCharsPerPage = text.length / numPages;
  
  for (let i = 0; i < text.length; i += (chunkSize - chunkOverlap)) {
    // Stop if we've reached the end of the text
    if (i >= text.length) break;
    
    // Extract chunk content with overlap
    const content = text.substring(i, i + chunkSize);
    
    // Skip empty chunks
    if (!content.trim()) continue;
    
    // Estimate page number based on character position
    const estimatedPage = Math.min(
      Math.ceil((i + chunkSize / 2) / avgCharsPerPage),
      numPages
    );
    
    // Create document chunk
    chunks.push({
      content,
      metadata: {
        ...baseMetadata,
        chunk_index: chunks.length,
        ...(options.includePageNumbers ? { page: estimatedPage } : {}),
      },
    });
  }
  
  return chunks;
}

/**
 * Split PDF content by paragraphs
 */
function splitByParagraphs(
  text: string,
  numPages: number,
  options: Required<PDFParseOptions>,
  baseMetadata: Record<string, any>
): Omit<Document, 'id'>[] {
  // Split by double newlines (common paragraph separator)
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  const chunks: Omit<Document, 'id'>[] = [];
  
  // Estimate content per page to track page numbers
  const avgCharsPerPage = text.length / numPages;
  
  let currentChunk = '';
  let chunkStart = 0;
  
  for (const paragraph of paragraphs) {
    // If adding this paragraph would exceed chunk size, save current chunk
    if (currentChunk.length > 0 && 
        (currentChunk.length + paragraph.length) > options.chunkSize) {
      
      // Estimate page based on position in text
      const estimatedPage = Math.min(
        Math.ceil((chunkStart + currentChunk.length / 2) / avgCharsPerPage),
        numPages
      );
      
      chunks.push({
        content: currentChunk,
        metadata: {
          ...baseMetadata,
          chunk_index: chunks.length,
          ...(options.includePageNumbers ? { page: estimatedPage } : {}),
        },
      });
      
      // Start a new chunk with overlap
      const overlapPoint = Math.max(0, currentChunk.length - options.chunkOverlap);
      currentChunk = currentChunk.substring(overlapPoint);
      chunkStart += overlapPoint;
    }
    
    // Add paragraph to current chunk
    currentChunk += (currentChunk.length > 0 ? '\n\n' : '') + paragraph;
  }
  
  // Add the final chunk if it's not empty
  if (currentChunk.trim().length > 0) {
    const estimatedPage = Math.min(
      Math.ceil((chunkStart + currentChunk.length / 2) / avgCharsPerPage),
      numPages
    );
    
    chunks.push({
      content: currentChunk,
      metadata: {
        ...baseMetadata,
        chunk_index: chunks.length,
        ...(options.includePageNumbers ? { page: estimatedPage } : {}),
      },
    });
  }
  
  return chunks;
}

/**
 * Split PDF content by detected sections/headers (most intelligent option)
 * This uses heuristics to detect section headers and create coherent sections
 */
function splitBySections(
  text: string,
  numPages: number,
  options: Required<PDFParseOptions>,
  baseMetadata: Record<string, any>
): Omit<Document, 'id'>[] {
  // First split into paragraphs
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  const chunks: Omit<Document, 'id'>[] = [];
  
  // Estimate content per page to track page numbers
  const avgCharsPerPage = text.length / numPages;
  let charCount = 0;
  
  // Heuristics for detecting headers
  // 1. Headers are typically short (< 200 chars)
  // 2. Often start with numbers (1., 1.1, I., A., etc.)
  // 3. Often in ALL CAPS or Title Case
  // 4. Usually don't end with punctuation
  const headerRegex = /^(?:\d+[.):]|[A-Z][.):]|[IVXLCDM]+[.):]|APPENDIX|Chapter|Section|CHAPTER|SECTION)/;
  const allCapsRegex = /^[A-Z0-9\s.,;:()\-–—]+$/;
  
  let currentSection = '';
  let currentTitle = '';
  let sectionStart = 0;
  
  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i];
    const isLikelyHeader = 
      (paragraph.length < 200 && headerRegex.test(paragraph)) ||
      (paragraph.length < 150 && allCapsRegex.test(paragraph)) ||
      (paragraph.length < 100 && !paragraph.endsWith('.') && paragraph.split(' ').length < 10);
    
    // If we found a header and have existing content, save the current section
    if (isLikelyHeader && currentSection.length > 0) {
      // Estimate page based on position
      const estimatedPage = Math.min(
        Math.ceil((sectionStart + currentSection.length / 2) / avgCharsPerPage),
        numPages
      );
      
      chunks.push({
        content: currentSection,
        metadata: {
          ...baseMetadata,
          section_title: currentTitle,
          chunk_index: chunks.length,
          ...(options.includePageNumbers ? { page: estimatedPage } : {}),
        },
      });
      
      // Reset for new section
      sectionStart = charCount;
      currentSection = '';
    }
    
    // If it's a header, set as current title, otherwise add to current section
    if (isLikelyHeader) {
      currentTitle = paragraph.trim();
      // Add header to section content as well
      currentSection = paragraph;
    } else {
      // Add paragraph to current section
      currentSection += (currentSection.length > 0 ? '\n\n' : '') + paragraph;
    }
    
    charCount += paragraph.length + 2; // +2 for newlines
    
    // If current section exceeds max chunk size, break it up
    if (currentSection.length > options.chunkSize * 1.5) {
      // Recursively chunk this large section using the paragraph method
      const subChunks = splitByParagraphs(
        currentSection,
        numPages,
        options,
        {
          ...baseMetadata,
          section_title: currentTitle,
        }
      );
      
      // Add all sub-chunks to our output
      chunks.push(...subChunks);
      
      // Reset current section
      sectionStart = charCount;
      currentSection = '';
    }
  }
  
  // Add the final section if not empty
  if (currentSection.trim().length > 0) {
    const estimatedPage = Math.min(
      Math.ceil((sectionStart + currentSection.length / 2) / avgCharsPerPage),
      numPages
    );
    
    chunks.push({
      content: currentSection,
      metadata: {
        ...baseMetadata,
        section_title: currentTitle,
        chunk_index: chunks.length,
        ...(options.includePageNumbers ? { page: estimatedPage } : {}),
      },
    });
  }
  
  return chunks;
}

/**
 * Parse a directory of PDFs and load into RAG system
 * @param dirPath Directory path containing PDFs
 * @param options Parse options
 * @returns Array of results for each processed PDF
 */
export async function parseDirectoryOfPDFs(
  dirPath: string,
  options: PDFParseOptions
): Promise<Record<string, PDFParseResult>> {
  try {
    logger.debug(`Processing directory of PDFs: ${dirPath}`);
    
    // Read directory contents
    const files = fs.readdirSync(dirPath);
    
    // Filter for PDF files
    const pdfFiles = files.filter(file => file.toLowerCase().endsWith('.pdf'));
    
    // Process each PDF
    const results: Record<string, PDFParseResult> = {};
    
    for (const pdfFile of pdfFiles) {
      const filePath = path.join(dirPath, pdfFile);
      try {
        results[pdfFile] = await parsePDF(filePath, options);
        logger.debug(`Successfully processed ${pdfFile}`);
      } catch (error) {
        logger.error(`Error processing ${pdfFile}:`, error);
        // Continue with other files even if one fails
      }
    }
    
    return results;
  } catch (error) {
    logger.error(`Error processing PDF directory ${dirPath}:`, error);
    throw error;
  }
} 