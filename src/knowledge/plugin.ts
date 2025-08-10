import { ToolDefinition, ToolResult, ToolContext, ToolParameterValue } from '../plugin/types';
import { DEFAULT_KNOWLEDGE_CONFIG } from './defaults';

interface KnowledgeResult {
  content: string;
  similarity: number;
  metadata?: Record<string, string | number | boolean | null>;
}

interface AgentWithKnowledge {
  hasKnowledge(): boolean;
  searchKnowledge?(query: string, limit: number, threshold: number): Promise<KnowledgeResult[]>;
  expandKnowledgeContext?(
    documentId: number,
    chunkIndex: number,
    expandBefore?: number,
    expandAfter?: number
  ): Promise<string[]>;
}

export const knowledgeSearchTool: ToolDefinition = {
  name: 'search_knowledge',
  description:
    "Search through the agent's knowledge base for relevant information. Start with default threshold (0.7), but if you get 0 results, immediately retry with a lower threshold like 0.5 or 0.4 to find more results.",
  parameters: {
    query: {
      name: 'query',
      type: 'string',
      description: 'The search query to find relevant information in the knowledge base',
      required: true,
    },
    limit: {
      name: 'limit',
      type: 'number',
      description: 'Maximum number of results to return (default: 5)',
    },
    threshold: {
      name: 'threshold',
      type: 'number',
      description:
        'Similarity threshold for results (0.0-1.0, default: 0.4). Lower values (0.3-0.5) return more results but less precise matches. Higher values (0.7-0.9) return fewer, more precise matches.',
    },
    expand_context: {
      name: 'expand_context',
      type: 'boolean',
      description:
        'Whether to expand context by including surrounding chunks from the same document for richer context (default: false)',
    },
    expand_before: {
      name: 'expand_before',
      type: 'number',
      description:
        'Number of chunks to include before each result when expanding context (default: 1)',
    },
    expand_after: {
      name: 'expand_after',
      type: 'number',
      description:
        'Number of chunks to include after each result when expanding context (default: 1)',
    },
  },
  handler: async (
    params: Record<string, ToolParameterValue>,
    context?: ToolContext
  ): Promise<ToolResult> => {
    try {
      // Extract and validate parameters
      const query = params.query as string;
      const limit = (params.limit as number) || DEFAULT_KNOWLEDGE_CONFIG.searchLimit;
      const threshold = (params.threshold as number) || DEFAULT_KNOWLEDGE_CONFIG.searchThreshold;
      const expandContext = (params.expand_context as boolean) || false;
      const expandBefore = (params.expand_before as number) || 1;
      const expandAfter = (params.expand_after as number) || 1;

      // Get agent instance from context
      const agent = context?.agent as AgentWithKnowledge;

      if (!agent) {
        throw new Error('Agent context not available');
      }

      // Check if agent has knowledge capability
      if (!agent.hasKnowledge() || !agent.searchKnowledge) {
        return {
          success: false,
          data: null,
          error: 'Agent does not have knowledge capabilities enabled',
        };
      }

      const results = await agent.searchKnowledge(query, limit, threshold);

      // Auto-retry with lower threshold if no results and threshold >= 0.4
      let finalResults = results;
      let retryMessage = '';

      if (results.length === 0 && threshold > 0.4) {
        const retryThreshold = 0.4;
        const retryResults = await agent.searchKnowledge(query, limit, retryThreshold);
        if (retryResults.length > 0) {
          finalResults = retryResults;
          retryMessage = ` (found with lower threshold ${retryThreshold})`;
        }
      }

      if (finalResults.length === 0) {
        return {
          success: true,
          data: JSON.stringify({
            message: 'No relevant information found in knowledge base',
            results: [],
            query,
          }),
        };
      }

      // Process results with optional context expansion
      let processedResults = finalResults.map((result: KnowledgeResult) => ({
        content: result.content,
        similarity: result.similarity,
        metadata: result.metadata,
      }));

      // Expand context if requested and agent supports it
      if (
        expandContext &&
        'expandKnowledgeContext' in agent &&
        typeof agent.expandKnowledgeContext === 'function'
      ) {
        try {
          processedResults = await Promise.all(
            finalResults.map(async (result: KnowledgeResult) => {
              // Extract document ID and chunk index from metadata
              const documentId = result.metadata?.documentId;
              const chunkIndex = result.metadata?.chunkIndex;

              if (
                typeof documentId === 'number' &&
                typeof chunkIndex === 'number' &&
                agent.expandKnowledgeContext
              ) {
                try {
                  const expandedChunks = await agent.expandKnowledgeContext(
                    documentId,
                    chunkIndex,
                    expandBefore,
                    expandAfter
                  );

                  // Combine expanded chunks into single content
                  const expandedContent = expandedChunks.join('\n\n');

                  return {
                    content: expandedContent,
                    similarity: result.similarity,
                    metadata: {
                      ...result.metadata,
                      expanded: true,
                      originalContent: result.content,
                      expandedChunks: expandedChunks.length,
                    },
                  };
                } catch (expandError) {
                  // If expansion fails, return original result
                  return {
                    content: result.content,
                    similarity: result.similarity,
                    metadata: {
                      ...result.metadata,
                      expandError:
                        expandError instanceof Error ? expandError.message : 'Expansion failed',
                    },
                  };
                }
              }

              // If no document ID or chunk index, return original
              return {
                content: result.content,
                similarity: result.similarity,
                metadata: result.metadata,
              };
            })
          );
        } catch {
          // If context expansion fails completely, continue with original results
          processedResults = finalResults.map((result: KnowledgeResult) => ({
            content: result.content,
            similarity: result.similarity,
            metadata: {
              ...result.metadata,
              expandError: 'Context expansion not supported',
            },
          }));
        }
      }

      return {
        success: true,
        data: JSON.stringify({
          message: `Found ${finalResults.length} relevant result(s)${expandContext ? ' with expanded context' : ''}${retryMessage}`,
          results: processedResults,
          query,
          expandedContext: expandContext,
        }),
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: `Knowledge search failed: ${error}`,
      };
    }
  },
};

export const knowledgeTools = [knowledgeSearchTool];
