import { Plugin } from "../types";
import { RAGInstance, VectorRAGInstance, DocumentRAGInstance } from "../types/rag";
import { logger } from "./logger";

/**
 * Convert a RAG instance to an array of tools that can be used by agents
 * @param rag The RAG instance to convert
 * @returns Array of Plugin tools for RAG functionality
 */
export function createRAGTools(rag: RAGInstance): Plugin[] {
  const tools: Plugin[] = [];

  // Common search tool available for all RAG types
  tools.push({
    name: "rag_search",
    description: "Search through documents using semantic similarity to find relevant information",
    parameters: [
      {
        name: "query",
        type: "string",
        description: "The search query to find relevant documents or content",
        required: true
      },
      {
        name: "limit",
        type: "number",
        description: "Maximum number of results to return",
        required: false,
        default: 5
      }
    ],
    execute: async (params: Record<string, any>) => {
      try {
        const query = params.query as string;
        const limit = params.limit as number | undefined;
        
        if (!query) {
          throw new Error("Query parameter is required");
        }
        
        const results = await rag.search(query, limit);
        return {
          success: true,
          results: results.map(r => ({
            content: r.content,
            metadata: r.metadata,
            similarity: r.similarity,
            sourceId: r.sourceId
          })),
          query: query,
          resultCount: results.length
        };
      } catch (error) {
        logger.error("Error executing RAG search:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error occurred during search",
          query: params.query
        };
      }
    }
  });

  // Vector RAG specific tools
  if ('searchByVector' in rag) {
    const vectorRAG = rag as VectorRAGInstance;
    
    tools.push({
      name: "rag_add_document",
      description: "Add a new document to the RAG system for future searches",
      parameters: [
        {
          name: "content",
          type: "string",
          description: "The document content to add",
          required: true
        },
        {
          name: "metadata",
          type: "object",
          description: "Additional metadata for the document",
          required: false,
          default: {}
        }
      ],
      execute: async (params: Record<string, any>) => {
        try {
          const content = params.content as string;
          const metadata = params.metadata as Record<string, any> | undefined;
          
          if (!content) {
            throw new Error("Content parameter is required");
          }
          
          const documentId = await vectorRAG.addDocument({
            content: content,
            metadata: metadata || {}
          });
          return {
            success: true,
            documentId,
            message: "Document added successfully"
          };
        } catch (error) {
          logger.error("Error adding document to RAG:", error);
          return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error occurred while adding document"
          };
        }
      }
    });

    tools.push({
      name: "rag_get_document",
      description: "Retrieve a specific document by its ID",
      parameters: [
        {
          name: "documentId",
          type: "string",
          description: "The ID of the document to retrieve",
          required: true
        }
      ],
      execute: async (params: Record<string, any>) => {
        try {
          const documentId = params.documentId as string;
          
          if (!documentId) {
            throw new Error("DocumentId parameter is required");
          }
          
          const document = await vectorRAG.getDocumentById(documentId);
          if (document) {
            return {
              success: true,
              document: {
                id: document.id,
                content: document.content,
                metadata: document.metadata
              }
            };
          } else {
            return {
              success: false,
              error: "Document not found",
              documentId: documentId
            };
          }
        } catch (error) {
          logger.error("Error retrieving document from RAG:", error);
          return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error occurred while retrieving document",
            documentId: params.documentId
          };
        }
      }
    });

    tools.push({
      name: "rag_delete_document",
      description: "Delete a document from the RAG system",
      parameters: [
        {
          name: "documentId",
          type: "string",
          description: "The ID of the document to delete",
          required: true
        }
      ],
      execute: async (params: Record<string, any>) => {
        try {
          const documentId = params.documentId as string;
          
          if (!documentId) {
            throw new Error("DocumentId parameter is required");
          }
          
          await vectorRAG.deleteDocument(documentId);
          return {
            success: true,
            message: "Document deleted successfully",
            documentId: documentId
          };
        } catch (error) {
          logger.error("Error deleting document from RAG:", error);
          return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error occurred while deleting document",
            documentId: params.documentId
          };
        }
      }
    });
  }

  // Document RAG specific tools
  if ('searchByMetadata' in rag) {
    const documentRAG = rag as DocumentRAGInstance;
    
    tools.push({
      name: "rag_search_by_metadata",
      description: "Search documents by their metadata properties",
      parameters: [
        {
          name: "filter",
          type: "object",
          description: "Metadata filter criteria as key-value pairs",
          required: true
        },
        {
          name: "limit",
          type: "number",
          description: "Maximum number of results to return",
          required: false,
          default: 5
        }
      ],
      execute: async (params: Record<string, any>) => {
        try {
          const filter = params.filter as Record<string, any>;
          const limit = params.limit as number | undefined;
          
          if (!filter) {
            throw new Error("Filter parameter is required");
          }
          
          const results = await documentRAG.searchByMetadata(filter, limit);
          return {
            success: true,
            results: results.map(r => ({
              content: r.content,
              metadata: r.metadata,
              similarity: r.similarity,
              sourceId: r.sourceId
            })),
            filter: filter,
            resultCount: results.length
          };
        } catch (error) {
          logger.error("Error executing RAG metadata search:", error);
          return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error occurred during metadata search",
            filter: params.filter
          };
        }
      }
    });
  }

  logger.debug(`Created ${tools.length} RAG tools for agent use`);
  return tools;
} 