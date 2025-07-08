// Type declarations for mammoth package
declare module 'mammoth' {
  interface ConvertToHtmlOptions {
    convertImage?: (image: any) => any;
    ignoreEmptyParagraphs?: boolean;
    includeEmbeddedStyleMap?: boolean;
    includeDefaultStyleMap?: boolean;
    styleMap?: string[];
    transformDocument?: (document: any) => any;
  }

  interface ConvertToHtmlResult {
    value: string;
    messages: Array<{
      type: string;
      message: string;
    }>;
  }

  interface ExtractRawTextResult {
    value: string;
    messages: Array<{
      type: string;
      message: string;
    }>;
  }

  export function convertToHtml(
    input: { path: string } | { buffer: Buffer },
    options?: ConvertToHtmlOptions
  ): Promise<ConvertToHtmlResult>;

  export function extractRawText(
    input: { path: string } | { buffer: Buffer }
  ): Promise<ExtractRawTextResult>;
}