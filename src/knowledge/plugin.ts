import { ToolDefinition, ToolResult, ToolContext, ToolParameterValue } from '../plugin/types';

interface KnowledgeResult {
  content: string;
  similarity: number;
  metadata?: Record<string, string | number | boolean | null>;
}

interface AgentWithKnowledge {
  hasKnowledge(): boolean;
  searchKnowledge?(query: string, limit: number, threshold: number): Promise<KnowledgeResult[]>;
}

interface KnowledgeToolContext extends ToolContext {
  agent: AgentWithKnowledge;
}

export const knowledgeSearchTool: ToolDefinition = {
  name: 'search_knowledge',
  description: "Search through the agent's knowledge base for relevant information",
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
      description: 'Similarity threshold for results (default: 0.7)',
    },
  },
  handler: async (
    params: Record<string, ToolParameterValue>,
    context?: ToolContext
  ): Promise<ToolResult> => {
    // Extract and validate parameters
    const query = params.query as string;
    const limit = (params.limit as number) || 5;
    const threshold = (params.threshold as number) || 0.7;

    // Get agent instance from context
    const agent = (context as KnowledgeToolContext)?.agent;
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

    try {
      const results = await agent.searchKnowledge(query, limit, threshold);

      if (results.length === 0) {
        return {
          success: true,
          data: JSON.stringify({
            message: 'No relevant information found in knowledge base',
            results: [],
            query,
          }),
        };
      }

      return {
        success: true,
        data: JSON.stringify({
          message: `Found ${results.length} relevant result(s)`,
          results: results.map((result: KnowledgeResult) => ({
            content: result.content,
            similarity: result.similarity,
            metadata: result.metadata,
          })),
          query,
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
