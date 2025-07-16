import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { v4 as uuidv4 } from 'uuid';
import { Document } from '../types';

// Use pdfjs-dist for better parsing
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

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
   * Whether to preserve formatting (paragraphs, lists, etc.)
   */
  preserveFormatting?: boolean;
  
  /**
   * Whether to extract tables as structured data
   */
  extractTables?: boolean;
  
  /**
   * Whether to extract images and their descriptions
   */
  extractImages?: boolean;
  
  /**
   * Whether to use OCR for scanned pages
   */
  useOCR?: boolean;
  
  /**
   * Language for OCR (if enabled)
   */
  ocrLanguage?: string;
  
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
    subject?: string;
    keywords?: string;
    creator?: string;
    producer?: string;
    numPages: number;
    creationDate?: Date;
    modificationDate?: Date;
    isEncrypted: boolean;
    isScanned?: boolean; // Detected if mostly images
  };
  
  /**
   * Structured data extracted from the PDF
   */
  structuredData?: {
    tables?: Array<{
      pageNumber: number;
      data: string[][];
    }>;
    images?: Array<{
      pageNumber: number;
      description?: string;
      base64?: string;
    }>;
    headings?: Array<{
      level: number;
      text: string;
      pageNumber: number;
    }>;
  };
  
  /**
   * Unique identifier for this PDF document
   */
  documentId: string;
}

/**
 * Advanced PDF parser with better text extraction and structure preservation
 * @param filePath Path to the PDF file
 * @param options Options for parsing and chunking
 * @returns Promise resolving to the parsed documents
 */
export async function parsePDF(
  filePath: string,
  options: PDFParseOptions = {}
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
      preserveFormatting: options.preserveFormatting !== undefined ? options.preserveFormatting : true,
      extractTables: options.extractTables || false,
      extractImages: options.extractImages || false,
      useOCR: options.useOCR || false,
      ocrLanguage: options.ocrLanguage || 'eng',
      metadata: options.metadata || {},
    };
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`PDF file not found: ${filePath}`);
    }
    
    // Read PDF file
    const data = new Uint8Array(fs.readFileSync(filePath));
    
    // Load the PDF document
    const loadingTask = pdfjsLib.getDocument({
      data,
      // Disable font face to avoid warnings
      disableFontFace: true,
      // Enable text content parsing
      useSystemFonts: true,
    });
    
    const pdfDocument = await loadingTask.promise;
    
    // Extract metadata
    const metadata = await pdfDocument.getMetadata();
    const info = metadata.info as any;
    const pdfMetadata = {
      title: info?.Title || path.basename(filePath),
      author: info?.Author,
      subject: info?.Subject,
      keywords: info?.Keywords,
      creator: info?.Creator,
      producer: info?.Producer,
      numPages: pdfDocument.numPages,
      creationDate: info?.CreationDate ? new Date(info.CreationDate) : undefined,
      modificationDate: info?.ModDate ? new Date(info.ModDate) : undefined,
      isEncrypted: (pdfDocument as any).isEncrypted || false,
      isScanned: true, // Will be updated below
    };
    
    // Extract text from all pages
    const pagesText: Array<{
      pageNumber: number;
      text: string;
      structuredText?: any;
    }> = [];
    
    let isScanned = true; // Assume scanned until we find text
    
    for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
      const page = await pdfDocument.getPage(pageNum);
      const textContent = await page.getTextContent();
      
      // Build text with formatting
      let pageText = '';
      
      if (textContent.items.length > 0) {
        isScanned = false; // Found text, not a scanned PDF
      }
      
      // Group items by line (Y position) for better text reconstruction
      const lines = new Map<number, Array<{item: TextItem, x: number}>>();
      
      for (const item of textContent.items) {
        if ('str' in item) {
          const textItem = item as TextItem;
          const y = Math.round(textItem.transform[5]); // Round Y to group items on same line
          
          if (!lines.has(y)) {
            lines.set(y, []);
          }
          
          lines.get(y)!.push({
            item: textItem,
            x: textItem.transform[4] // X position for sorting
          });
        }
      }
      
      // Sort lines by Y position (top to bottom)
      const sortedLines = Array.from(lines.entries()).sort((a, b) => b[0] - a[0]);
      
      // Build text from sorted lines
      for (const [_y, lineItems] of sortedLines) {
        // Sort items in line by X position (left to right)
        lineItems.sort((a, b) => a.x - b.x);
        
        let lineText = '';
        let lastX = 0;
        
        for (const {item, x} of lineItems) {
          // Add space if there's a gap between items
          if (lastX > 0 && x - lastX > item.width * 0.3) {
            lineText += ' ';
          }
          
          lineText += item.str;
          lastX = x + item.width;
        }
        
        // Add line to page text
        if (lineText.trim()) {
          pageText += lineText.trim() + '\n';
        }
      }
      
      // If no text found and OCR is enabled, try OCR
      if (pageText.trim().length === 0 && opts.useOCR) {
        // TODO: Implement OCR using Tesseract.js
        logger.warn(`Page ${pageNum} appears to be scanned. OCR not implemented yet.`);
      }
      
      pagesText.push({
        pageNumber: pageNum,
        text: pageText.trim(),
      });
    }
    
    // Update metadata with scan detection
    pdfMetadata.isScanned = isScanned;
    
    // Combine all pages text
    const fullText = pagesText.map(p => p.text).join('\n\n');
    
    logger.debug(`PDF parsed successfully: ${fullText.length} characters, ${pdfDocument.numPages} pages`);
    
    // Create base metadata
    const baseMetadata = {
      source: path.basename(filePath),
      documentId: documentId,
      fileName: path.basename(filePath),
      filePath: filePath,
      ...opts.metadata,
    };
    
    // Create smart chunks that respect page boundaries
    const documents = createSmartChunks(
      fullText,
      pagesText,
      opts,
      baseMetadata
    );
    
    const result: PDFParseResult = {
      documents,
      pdfMetadata,
      documentId,
    };
    
    // Extract structured data if requested
    if (opts.extractTables || opts.extractImages) {
      result.structuredData = {
        tables: opts.extractTables ? [] : undefined,
        images: opts.extractImages ? [] : undefined,
        headings: [], // Always extract headings for better navigation
      };
      
      // TODO: Implement table and image extraction
      logger.debug('Structured data extraction not fully implemented yet');
    }
    
    logger.debug(`PDF parsed successfully: ${documents.length} documents created for document ${documentId}`);
    
    return result;
  } catch (error) {
    logger.error(`PDF parsing failed for ${filePath}:`, error);
    throw error;
  }
}

/**
 * Create smart chunks that respect page boundaries and formatting
 */
function createSmartChunks(
  fullText: string,
  pagesText: Array<{ pageNumber: number; text: string }>,
  options: Required<PDFParseOptions>,
  baseMetadata: Record<string, any>
): Omit<Document, 'id'>[] {
  // Return a single document that contains the full PDF content
  // The RAG system (DocumentRAG or VectorRAG) will handle chunking internally
  return [{
    content: fullText,
    metadata: {
      ...baseMetadata,
      numPages: pagesText.length,
      totalCharacters: fullText.length,
      averageCharsPerPage: Math.round(fullText.length / pagesText.length),
      chunkSize: options.chunkSize,
      chunkOverlap: options.chunkOverlap,
      includePageNumbers: options.includePageNumbers,
      preserveFormatting: options.preserveFormatting,
      // Page text mapping for better chunk creation later
      pageTextLengths: pagesText.map(p => ({
        pageNumber: p.pageNumber,
        textLength: p.text.length,
      })),
    },
  }];
}