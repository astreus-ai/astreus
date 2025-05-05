// Type definitions for modules without TypeScript definitions

declare module 'pdf-parse' {
  interface PDFInfo {
    Title?: string;
    Author?: string;
    Subject?: string;
    CreationDate?: string;
    ModDate?: string;
    Producer?: string;
    Creator?: string;
    [key: string]: any;
  }

  interface PDFData {
    text: string;
    info: PDFInfo;
    metadata: any;
    numpages: number;
    version: string;
  }

  function pdfParse(
    dataBuffer: Buffer,
    options?: {
      pagerender?: (pageData: any) => string,
      max?: number,
      version?: string
    }
  ): Promise<PDFData>;

  export default pdfParse;
} 