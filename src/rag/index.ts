import { createVectorRAG } from "./vector";
import { createDocumentRAG } from "./document";
import { parsePDF } from "../utils/pdf-parser";
import { RAGType, RAGFactoryConfig, RAGFactory, VectorRAGConfig, DocumentRAGConfig } from "../types/rag";

/**
 * Unified factory function to create a RAG instance of the specified type
 * @param config Configuration with type to determine which RAG implementation to create
 * @returns Promise resolving to the appropriate RAG instance
 */
export const createRAG: RAGFactory = async (config: RAGFactoryConfig) => {
  const { type, ...baseConfig } = config;
  
  // Declare configs outside of switch statement to avoid lexical declaration errors
  let vectorConfig: VectorRAGConfig;
  let documentConfig: DocumentRAGConfig;
  
  switch (type) {
    case RAGType.VECTOR:
      // Create vector RAG config from the base config
      vectorConfig = {
        ...baseConfig,
        chunkSize: config.chunkSize,
        chunkOverlap: config.chunkOverlap
      };
      return createVectorRAG(vectorConfig);
      
    case RAGType.DOCUMENT:
      // Create document RAG config from the base config
      documentConfig = {
        ...baseConfig,
        storeEmbeddings: config.storeEmbeddings
      };
      return createDocumentRAG(documentConfig);
      
    default:
      throw new Error(`Unknown RAG type: ${type}`);
  }
};

// Re-export PDF processing utilities
export { parsePDF };

// Re-export types
export * from "../types/rag";

// Re-export configuration
export * from "./config"; 