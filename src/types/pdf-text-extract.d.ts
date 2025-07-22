declare module 'pdf-text-extract' {
  function pdfTextExtract(filePath: string, callback: (err: any, pages: string[]) => void): void;
  export = pdfTextExtract;
}