import { ToolDefinition } from '../plugin/types';

export const knowledgeSearchTool: ToolDefinition = {
  name: 'search_knowledge',
  description: 'Search through the agent\'s knowledge base for relevant information',
  parameters: {
    query: {
      name: 'query',
      type: 'string',
      description: 'The search query to find relevant information in the knowledge base',
      required: true
    },
    limit: {
      name: 'limit',
      type: 'number', 
      description: 'Maximum number of results to return (default: 5)'
    },
    threshold: {
      name: 'threshold',
      type: 'number',
      description: 'Similarity threshold for results (default: 0.7)'
    }
  },
  handler: async (params: any, context: any) => {
    const { query, limit = 5, threshold = 0.7 } = params;
    
    // Get agent instance from context
    const agent = context.agent;
    if (!agent) {
      throw new Error('Agent context not available');
    }

    // Check if agent has knowledge capability
    if (!agent.hasKnowledge() || !agent.searchKnowledge) {
      return {
        success: false,
        data: null,
        error: 'Agent does not have knowledge capabilities enabled'
      };
    }

    try {
      const results = await agent.searchKnowledge(query, limit, threshold);
      
      if (results.length === 0) {
        return {
          success: true,
          data: {
            message: 'No relevant information found in knowledge base',
            results: [],
            query
          }
        };
      }

      return {
        success: true,
        data: {
          message: `Found ${results.length} relevant result(s)`,
          results: results.map((result: any) => ({
            content: result.content,
            similarity: result.similarity,
            metadata: result.metadata
          })),
          query
        }
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: `Knowledge search failed: ${error}`
      };
    }
  }
};

export const knowledgeTools = [knowledgeSearchTool];