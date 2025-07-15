import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { v4 as uuidv4 } from 'uuid';
import { Document } from '../types';

export interface PDFParseOptions {
  /**
   * Size of chunks
   */
  chunkSize?: number;
  
  /**
   * Overlap between chunks
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
      chunkSize: options.chunkSize || 1000,
      chunkOverlap: options.chunkOverlap || 200,
      includePageNumbers: options.includePageNumbers !== undefined ? options.includePageNumbers : true,
      metadata: options.metadata || {},
    };
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`PDF file not found: ${filePath}`);
    }
    
    // Read PDF file
    const dataBuffer = fs.readFileSync(filePath);
    
    // Use pdf-parse to extract text
    const pdfParse = await import('pdf-parse');
    const options_parse = {};
    const data = await pdfParse.default(dataBuffer, options_parse);
    
    const allText = data.text;
    const numPages = data.numpages;
    
    logger.debug(`PDF parsed successfully: ${allText.length} characters, ${numPages} pages`);
    
    // Create base metadata with document identification
    const baseMetadata = {
      source: path.basename(filePath),
      documentId: documentId,
      fileName: path.basename(filePath),
      filePath: filePath,
      ...opts.metadata,
    };
    
    // PDF metadata for the result
    const pdfMetadata = {
      title: data.info?.Title || path.basename(filePath),
      author: data.info?.Author,
      numPages: numPages,
      creationDate: data.info?.CreationDate ? new Date(data.info.CreationDate) : undefined,
    };
    
    // Split content into chunks
    const documents = splitByCharacterCount(allText, numPages, opts, baseMetadata);
    
    logger.debug(`PDF parsed successfully: ${documents.length} chunks created for document ${documentId}`);
    
    return {
      documents,
      pdfMetadata,
      documentId,
    };
  } catch (error) {
    logger.error(`PDF parsing failed for ${filePath}:`, error);
    throw error;
  }
}


/**
 * Split PDF content into fixed-size chunks by character count
 */
function splitByCharacterCount(
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

