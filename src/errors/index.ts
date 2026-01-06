/**
 * Custom Error Classes for Astreus
 *
 * These error classes provide structured error handling with:
 * - Error cause chaining (ES2022 Error cause)
 * - Provider/service context
 * - Proper error names for debugging
 *
 * Graceful Degradation Notes:
 * - LLMApiError: Provider failures should trigger retry with exponential backoff
 * - DatabaseError: Non-critical DB operations can use cached data as fallback
 * - MCPConnectionError: MCP server failures allow agent to continue without that tool
 * - SubAgentError: Sub-agent failures return partial results when possible
 */

/**
 * Base error class for all Astreus errors
 * Provides consistent error structure with cause chaining
 */
export class AstreusError extends Error {
  public readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.cause = cause;
    this.name = 'AstreusError';
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Get the full error chain as a string for logging
   */
  getFullStack(): string {
    let fullStack = this.stack || this.message;
    if (this.cause instanceof Error) {
      fullStack += `\nCaused by: ${this.cause.stack || this.cause.message}`;
    }
    return fullStack;
  }
}

/**
 * Error thrown when an LLM API request fails
 * Use this for OpenAI, Claude, Gemini, Ollama provider errors
 *
 * Graceful Degradation:
 * - Retry with exponential backoff (already implemented in providers)
 * - For embedding failures: continue without semantic search
 * - For vision failures: return text-based analysis if available
 */
export class LLMApiError extends AstreusError {
  constructor(
    message: string,
    public readonly provider: string,
    cause?: Error
  ) {
    super(message, cause);
    this.name = 'LLMApiError';
  }
}

/**
 * Error thrown for database operations
 * Use this for connection, query, and schema errors
 *
 * Graceful Degradation:
 * - Memory operations: Fall back to in-memory cache
 * - Agent config: Use default configuration
 * - Context storage: Continue without persistence
 */
export class DatabaseError extends AstreusError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = 'DatabaseError';
  }
}

/**
 * Error thrown when MCP server connection or communication fails
 * Use this for MCP process spawn, message, and tool call errors
 *
 * Graceful Degradation:
 * - Tool discovery: Agent continues without MCP tools
 * - Tool call failure: Return error result to LLM for alternative approach
 * - Server crash: Attempt reconnection on next tool call
 */
export class MCPConnectionError extends AstreusError {
  constructor(
    message: string,
    public readonly serverName: string,
    cause?: Error
  ) {
    super(message, cause);
    this.name = 'MCPConnectionError';
  }
}

/**
 * Error thrown when sub-agent operations fail
 * Use this for delegation, coordination, and execution errors
 *
 * Graceful Degradation:
 * - Single sub-agent failure: Return results from successful sub-agents
 * - All sub-agents fail: Fall back to main agent processing
 * - Timeout: Return partial results with timeout indication
 */
export class SubAgentError extends AstreusError {
  constructor(
    message: string,
    public readonly agentId?: string,
    cause?: Error
  ) {
    super(message, cause);
    this.name = 'SubAgentError';
  }
}

/**
 * Error thrown when context operations fail
 * Use this for context compression, loading, and storage errors
 *
 * Graceful Degradation:
 * - Compression failure: Use uncompressed context (may hit token limits)
 * - Load failure: Start with empty context
 * - Save failure: Log warning and continue (context lost on restart)
 */
export class ContextError extends AstreusError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = 'ContextError';
  }
}

/**
 * Error thrown when knowledge base operations fail
 * Use this for document indexing, search, and retrieval errors
 *
 * Graceful Degradation:
 * - Search failure: Continue without knowledge augmentation
 * - Index failure: Log warning and skip document
 * - Embedding failure: Fall back to keyword search
 */
export class KnowledgeError extends AstreusError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = 'KnowledgeError';
  }
}

/**
 * Error thrown when vision analysis fails
 * Use this for image processing and analysis errors
 *
 * Graceful Degradation:
 * - Analysis failure: Return error message to user
 * - Unsupported format: Suggest alternative formats
 * - Model unavailable: Fall back to text description request
 */
export class VisionError extends AstreusError {
  constructor(
    message: string,
    public readonly provider: string,
    cause?: Error
  ) {
    super(message, cause);
    this.name = 'VisionError';
  }
}

/**
 * Error thrown when configuration is invalid
 * This is typically a non-recoverable error requiring user intervention
 */
export class ConfigurationError extends AstreusError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = 'ConfigurationError';
  }
}

/**
 * Error thrown when a Graph node execution fails
 * Provides detailed error chain with node context for debugging
 *
 * Graceful Degradation:
 * - Node failure: Skip dependent nodes, continue with independent ones
 * - Critical node failure: Mark graph as failed, return partial results
 * - Timeout: Return timeout error with node context
 */
export class GraphNodeError extends AstreusError {
  constructor(
    message: string,
    public readonly nodeId: string,
    public readonly nodeName: string,
    public readonly step: 'initialization' | 'dependency_check' | 'execution' | 'result_processing',
    public readonly graphId?: string,
    public readonly parentNodeId?: string,
    cause?: Error
  ) {
    super(message, cause);
    this.name = 'GraphNodeError';
  }

  /**
   * Get error chain information for debugging
   */
  getErrorChain(): {
    nodeId: string;
    nodeName: string;
    step: string;
    graphId?: string;
    parentNodeId?: string;
    message: string;
    cause?: string;
  } {
    return {
      nodeId: this.nodeId,
      nodeName: this.nodeName,
      step: this.step,
      graphId: this.graphId,
      parentNodeId: this.parentNodeId,
      message: this.message,
      cause: this.cause instanceof Error ? this.cause.message : undefined,
    };
  }
}

/**
 * Error thrown when a tool call fails (Plugin or MCP)
 * Provides normalized error structure across all tool types
 *
 * Graceful Degradation:
 * - Tool not found: Return error message to LLM
 * - Validation failure: Return validation error to LLM
 * - Execution failure: Return error with context for LLM to try alternative
 * - Timeout: Return timeout error with retry suggestion
 */
export class ToolError extends AstreusError {
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly toolType: 'plugin' | 'mcp' | 'unknown',
    public readonly errorType: 'not_found' | 'validation' | 'execution' | 'timeout' | 'unknown',
    public readonly recoverable: boolean = true,
    cause?: Error
  ) {
    super(message, cause);
    this.name = 'ToolError';
  }

  /**
   * Get normalized error response for LLM
   */
  toToolResult(): { success: false; error: string; recoverable: boolean; toolType: string } {
    return {
      success: false,
      error: this.message,
      recoverable: this.recoverable,
      toolType: this.toolType,
    };
  }
}

/**
 * Type guard to check if an error is a GraphNodeError
 */
export function isGraphNodeError(error: unknown): error is GraphNodeError {
  return error instanceof GraphNodeError;
}

/**
 * Type guard to check if an error is a ToolError
 */
export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError;
}

/**
 * Type guard to check if an error is an AstreusError
 */
export function isAstreusError(error: unknown): error is AstreusError {
  return error instanceof AstreusError;
}

/**
 * Type guard to check if an error is an LLMApiError
 */
export function isLLMApiError(error: unknown): error is LLMApiError {
  return error instanceof LLMApiError;
}

/**
 * Type guard to check if an error is a DatabaseError
 */
export function isDatabaseError(error: unknown): error is DatabaseError {
  return error instanceof DatabaseError;
}

/**
 * Type guard to check if an error is an MCPConnectionError
 */
export function isMCPConnectionError(error: unknown): error is MCPConnectionError {
  return error instanceof MCPConnectionError;
}

/**
 * Type guard to check if an error is a SubAgentError
 */
export function isSubAgentError(error: unknown): error is SubAgentError {
  return error instanceof SubAgentError;
}

/**
 * Wrap an error with proper cause chaining
 * Helper function for consistent error wrapping
 *
 * Note: The error class constructor signature is (message, ...contextArgs, cause?)
 * So we need to place the cause at the end of the args array
 */
export function wrapError<T extends AstreusError>(
  ErrorClass: new (message: string, ...args: unknown[]) => T,
  message: string,
  cause: unknown,
  ...contextArgs: unknown[]
): T {
  const originalError = cause instanceof Error ? cause : new Error(String(cause));
  // Place cause at the end as per AstreusError subclass constructor signatures
  // e.g., LLMApiError(message, provider, cause?), MCPConnectionError(message, serverName, cause?)
  return new ErrorClass(message, ...contextArgs, originalError) as T;
}

/**
 * Type-safe wrapError for LLMApiError
 */
export function wrapLLMApiError(message: string, provider: string, cause: unknown): LLMApiError {
  const originalError = cause instanceof Error ? cause : new Error(String(cause));
  return new LLMApiError(message, provider, originalError);
}

/**
 * Type-safe wrapError for MCPConnectionError
 */
export function wrapMCPConnectionError(
  message: string,
  serverName: string,
  cause: unknown
): MCPConnectionError {
  const originalError = cause instanceof Error ? cause : new Error(String(cause));
  return new MCPConnectionError(message, serverName, originalError);
}

/**
 * Type-safe wrapError for SubAgentError
 */
export function wrapSubAgentError(
  message: string,
  agentId: string | undefined,
  cause: unknown
): SubAgentError {
  const originalError = cause instanceof Error ? cause : new Error(String(cause));
  return new SubAgentError(message, agentId, originalError);
}

/**
 * Type-safe wrapError for VisionError
 */
export function wrapVisionError(message: string, provider: string, cause: unknown): VisionError {
  const originalError = cause instanceof Error ? cause : new Error(String(cause));
  return new VisionError(message, provider, originalError);
}

/**
 * Type-safe wrapError for simple errors (no extra context)
 */
export function wrapSimpleError<T extends AstreusError>(
  ErrorClass: new (message: string, cause?: Error) => T,
  message: string,
  cause: unknown
): T {
  const originalError = cause instanceof Error ? cause : new Error(String(cause));
  return new ErrorClass(message, originalError);
}
