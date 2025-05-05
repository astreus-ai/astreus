import OpenAI from "openai";
import dotenv from "dotenv";
import logger from "../utils/logger";

// Initialize environment variables
dotenv.config();

// Default embedding model to use - this model is more widely supported than the newer models
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * Simple utility for generating embeddings without requiring provider setup
 */
export class Embedding {
  private static client: OpenAI | null = null;

  /**
   * Initialize the OpenAI client if not already initialized
   */
  private static initClient(): OpenAI {
    if (!this.client) {
      const apiKey =
        process.env.OPENAI_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;

      if (!apiKey) {
        throw new Error(
          "OpenAI API key is required for embeddings - set OPENAI_API_KEY or OPENAI_EMBEDDING_API_KEY"
        );
      }

      this.client = new OpenAI({
        apiKey,
        baseURL: "https://api.openai.com/v1",
      });
    }

    return this.client;
  }

  /**
   * Generate an embedding for the given text
   * @param text Text to generate embedding for
   * @param model Embedding model to use (default: text-embedding-ada-002)
   * @returns Embedding vector as array of numbers
   */
  static async generateEmbedding(
    text: string,
    model: string = process.env.OPENAI_EMBEDDING_MODEL ||
      DEFAULT_EMBEDDING_MODEL
  ): Promise<number[]> {
    try {
      if (!text || typeof text !== "string") {
        throw new Error("Invalid text input for embedding generation");
      }

      const client = this.initClient();
      logger.debug(`Generating embedding for text with model: ${model}`);

      const response = await client.embeddings.create({
        model,
        input: text,
        encoding_format: "float",
      });

      return response.data[0].embedding;
    } catch (error) {
      logger.error("Error generating embedding:", error);
      throw error;
    }
  }

  /**
   * Calculate cosine similarity between two embedding vectors
   * @param embedding1 First embedding vector
   * @param embedding2 Second embedding vector
   * @returns Similarity score (1.0 = identical, 0.0 = completely different)
   */
  static calculateSimilarity(
    embedding1: number[],
    embedding2: number[]
  ): number {
    if (!embedding1 || !embedding2 || embedding1.length !== embedding2.length) {
      return 0;
    }

    // Calculate dot product
    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;

    for (let i = 0; i < embedding1.length; i++) {
      dotProduct += embedding1[i] * embedding2[i];
      magnitude1 += embedding1[i] * embedding1[i];
      magnitude2 += embedding2[i] * embedding2[i];
    }

    magnitude1 = Math.sqrt(magnitude1);
    magnitude2 = Math.sqrt(magnitude2);

    // Avoid division by zero
    if (magnitude1 === 0 || magnitude2 === 0) {
      return 0;
    }

    // Return cosine similarity
    return dotProduct / (magnitude1 * magnitude2);
  }

  /**
   * Find similar texts based on embedding similarity
   * @param queryEmbedding Embedding to compare against
   * @param textEmbeddings Array of objects with text and embedding
   * @param limit Maximum number of results to return
   * @returns Array of results sorted by similarity (highest first)
   */
  static findSimilarTexts(
    queryEmbedding: number[],
    textEmbeddings: Array<{ text: string; embedding: number[] }>,
    limit: number = 5
  ): Array<{ text: string; similarity: number }> {
    if (!queryEmbedding || !textEmbeddings || textEmbeddings.length === 0) {
      return [];
    }

    // Calculate similarity for each text
    const similarities = textEmbeddings
      .map(({ text, embedding }) => ({
        text,
        similarity: this.calculateSimilarity(queryEmbedding, embedding),
      }))
      // Sort by similarity (highest first)
      .sort((a, b) => b.similarity - a.similarity)
      // Limit number of results
      .slice(0, limit);

    return similarities;
  }

  /**
   * Check if embeddings are available (OpenAI API key and valid model)
   * @param model Optional model to test
   * @returns True if embeddings are available, false otherwise
   */
  static async isAvailable(model?: string): Promise<boolean> {
    try {
      // Check if API key exists
      const apiKey =
        process.env.OPENAI_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        logger.warn("OpenAI API key not found for embeddings");
        return false;
      }

      // Try to generate a test embedding
      const testEmbedding = await this.generateEmbedding("test", model);
      return Array.isArray(testEmbedding) && testEmbedding.length > 0;
    } catch (error) {
      logger.warn("Embedding test failed:", error);
      return false;
    }
  }

  /**
   * List available embedding models from OpenAI
   * @returns Array of model IDs
   */
  static async listAvailableModels(): Promise<string[]> {
    try {
      const client = this.initClient();
      const models = await client.models.list();

      return models.data
        .filter((model) => model.id.includes("embedding"))
        .map((model) => model.id);
    } catch (error) {
      logger.error("Error listing available models:", error);
      return [];
    }
  }
} 