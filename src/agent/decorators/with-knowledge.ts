import { BaseAgent } from '../base';
import { Knowledge } from '../../knowledge';

export function withKnowledge(BaseClass: typeof BaseAgent) {
  class KnowledgeAgent extends BaseClass {
    public knowledge = new Knowledge();

    constructor(data: any) {
      super(data);
    }

    async ask(prompt: string, options?: { useTools?: boolean; [key: string]: any }): Promise<string> {
      if (!this.data.id) {
        throw new Error('Agent must have an ID to use knowledge');
      }

      if (!this.hasKnowledge()) {
        return super.ask(prompt, options);
      }

      // Get relevant context from knowledge base
      const context = await this.knowledge.getContext(this.data.id, prompt);
      
      let enhancedPrompt = prompt;
      if (context) {
        enhancedPrompt = `Context from knowledge base:\n${context}\n\nUser query: ${prompt}`;
      }

      return super.ask(enhancedPrompt, options);
    }

    async addKnowledge(content: string, title?: string, metadata?: any) {
      if (!this.data.id) {
        throw new Error('Agent must have an ID to use knowledge');
      }
      return this.knowledge.addDocument(this.data.id, content, title, metadata);
    }

    async getKnowledgeDocuments() {
      if (!this.data.id) {
        throw new Error('Agent must have an ID to use knowledge');
      }
      return this.knowledge.getDocuments(this.data.id);
    }

    async deleteKnowledgeDocument(documentId: number) {
      return this.knowledge.deleteDocument(documentId);
    }

    async searchKnowledge(query: string, limit?: number, threshold?: number) {
      if (!this.data.id) {
        throw new Error('Agent must have an ID to use knowledge');
      }
      return this.knowledge.search(this.data.id, query, limit, threshold);
    }

    async clearKnowledge() {
      if (!this.data.id) {
        throw new Error('Agent must have an ID to use knowledge');
      }
      return this.knowledge.clearAgentKnowledge(this.data.id);
    }

    async addKnowledgeFromFile(filePath: string, metadata?: any) {
      if (!this.data.id) {
        throw new Error('Agent must have an ID to use knowledge');
      }
      return this.knowledge.addDocumentFromFile(this.data.id, filePath, metadata);
    }

    async addKnowledgeFromDirectory(dirPath: string, metadata?: any) {
      if (!this.data.id) {
        throw new Error('Agent must have an ID to use knowledge');
      }
      return this.knowledge.addDocumentsFromDirectory(this.data.id, dirPath, metadata);
    }
  }
  
  return KnowledgeAgent;
}