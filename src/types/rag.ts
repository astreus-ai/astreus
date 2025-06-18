import { DatabaseInstance } from "./database";
import { MemoryInstance } from "./memory";
import { ProviderInstance } from "./provider";

// Vector database type enum
export enum VectorDatabaseType {
  SAME_AS_MAIN = 'same_as_main',  // Use the same database as the main application
  POSTGRES = 'postgres',          // PostgreSQL with pgvector
  QDRANT = 'qdrant',              // Qdrant vector database
  PINECONE = 'pinecone',          // Pinecone vector database
  MILVUS = 'milvus',              // Milvus vector database
  WEAVIATE = 'weaviate',          // Weaviate vector database
}

// Vector database configuration
export interface VectorDatabaseConfig {
  /** Type of vector database to use */
  type: VectorDatabaseType;
  /** Connection string (if applicable) */
  connectionString?: string;
  /** API key (if applicable) */
  apiKey?: string;
  /** Environment (if applicable) */
  environment?: string;
  /** Namespace/index (if applicable) */
  namespace?: string;
  /** Base URL (if applicable) */
  baseUrl?: string;
  /** Any other custom options */
  options?: Record<string, any>;
}

// Document structure for document-based RAG
export interface Document {
  id: string;
  content: string;
  metadata: Record<string, any>;
  embedding?: number[]; // Optional embedding vector
}

// Chunk structure for vector-based RAG
export interface Chunk {
  id: string;
  documentId: string;
  content: string; 
  metadata: Record<string, any>;
  embedding: number[]; // Required embedding vector
}

// Result with similarity score for semantic search
export interface RAGResult {
  content: string;
  metadata: Record<string, any>;
  similarity?: number; // Similarity score (0-1)
  sourceId: string; // Document ID or Chunk ID
}

// Base RAG configuration
export interface RAGConfig {
  /** Required: Database instance for storing documents/chunks */
  database: DatabaseInstance;
  /** Optional: Memory instance for storing vector embeddings */
  memory?: MemoryInstance;
  /** Optional: Provider instance for generating embeddings */
  provider?: ProviderInstance;
  /** Optional: Custom table name for storing data */
  tableName?: string;
  /** Optional: Maximum number of results to retrieve */
  maxResults?: number;
  /** Optional: Vector database configuration */
  vectorDatabase?: VectorDatabaseConfig;
}

// Vector-based RAG configuration
export interface VectorRAGConfig extends RAGConfig {
  /** Optional: Chunk size for text splitting */
  chunkSize?: number;
  /** Optional: Chunk overlap for text splitting */
  chunkOverlap?: number;
}

// Document-based RAG configuration
export interface DocumentRAGConfig extends RAGConfig {
  /** Optional: Whether to store document embeddings */
  storeEmbeddings?: boolean;
}

// Base RAG instance
export interface RAGInstance {
  config: RAGConfig;
  search(query: string, limit?: number): Promise<RAGResult[]>;
}

// Vector-based RAG instance
export interface VectorRAGInstance extends RAGInstance {
  config: VectorRAGConfig;
  addDocument(document: Omit<Document, "id" | "embedding">): Promise<string>;
  getDocumentById(id: string): Promise<Document | null>;
  deleteDocument(id: string): Promise<void>;
  searchByVector(embedding: number[], limit?: number, threshold?: number): Promise<RAGResult[]>;
}

// Document-based RAG instance
export interface DocumentRAGInstance extends RAGInstance {
  config: DocumentRAGConfig;
  addDocument(document: Omit<Document, "id">): Promise<string>;
  getDocumentById(id: string): Promise<Document | null>;
  deleteDocument(id: string): Promise<void>;
}

// Factory functions
export type VectorRAGFactory = (config: VectorRAGConfig) => Promise<VectorRAGInstance>;
export type DocumentRAGFactory = (config: DocumentRAGConfig) => Promise<DocumentRAGInstance>;

// RAG type enum for the unified createRAG function
export enum RAGType {
  VECTOR = 'vector',
  DOCUMENT = 'document'
}

// Unified RAG factory config
export interface RAGFactoryConfig extends RAGConfig {
  type: RAGType;
  // Vector RAG specific options
  chunkSize?: number;  
  chunkOverlap?: number;
  // Document RAG specific options
  storeEmbeddings?: boolean;
}

// Unified RAG factory function type
export type RAGFactory = (config: RAGFactoryConfig) => Promise<VectorRAGInstance | DocumentRAGInstance>; 