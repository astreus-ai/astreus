import { spawn, ChildProcess } from 'child_process';
import { IAgentModule, IAgent } from '../agent/types';
import { MCPValue } from './types';
import { MCPServerConfig, MCPTool, MCPToolResult, MCPServerDefinition } from './types';

interface MCPMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: Record<string, MCPValue>;
  result?: {
    tools?: MCPTool[];
  };
}

export class MCP implements IAgentModule {
  readonly name = 'mcp';
  public processes: Map<string, ChildProcess> = new Map();
  public tools: Map<string, MCPTool> = new Map();
  public servers: Map<string, MCPServerConfig> = new Map();

  constructor(private agent: IAgent) {}

  async initialize(): Promise<void> {
    // MCP manager is ready to use immediately
  }

  public async startMCPServer(name: string, config: MCPServerConfig): Promise<void> {
    if (config.url) {
      // SSE server - tools will be fetched when needed
      return;
    }

    if (!config.command) return;

    // Validate command and args to prevent command injection
    if (typeof config.command !== 'string' || config.command.trim() === '') {
      throw new Error(`Invalid command for MCP server '${name}': command must be a non-empty string`);
    }

    // Sanitize command - only allow alphanumeric, hyphens, underscores, and forward slashes
    const sanitizedCommand = config.command.replace(/[^a-zA-Z0-9\-_/]/g, '');
    if (sanitizedCommand !== config.command) {
      throw new Error(`Invalid command for MCP server '${name}': contains unsafe characters`);
    }

    // Validate args array
    const args = config.args || [];
    if (!Array.isArray(args)) {
      throw new Error(`Invalid args for MCP server '${name}': args must be an array`);
    }

    // Validate each argument
    for (const arg of args) {
      if (typeof arg !== 'string') {
        throw new Error(`Invalid argument for MCP server '${name}': all arguments must be strings`);
      }
    }

    // Use process.env by default, only override if explicitly provided
    const envVars = config.env ? { ...process.env, ...config.env } : process.env;
    
    const childProcess = spawn(config.command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: envVars
    });

    let buffer = '';
    childProcess.stdout?.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            this.handleMessage(name, message);
          } catch {
            // Ignore parse errors
          }
        }
      }
    });

    childProcess.on('error', () => {
      this.processes.delete(name);
    });

    this.processes.set(name, childProcess);

    // Initialize
    this.sendToServer(name, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'astreus', version: '1.0.0' }
      }
    });

    // List tools
    this.sendToServer(name, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    });
  }

  public handleMessage(serverName: string, message: MCPMessage): void {
    if (message.method === 'tools/list' && message.result?.tools) {
      for (const tool of message.result.tools) {
        this.tools.set(`${serverName}:${tool.name}`, tool);
      }
    }
  }

  public sendToServer(name: string, message: MCPMessage): void {
    const childProcess = this.processes.get(name);
    if (childProcess?.stdin) {
      childProcess.stdin.write(JSON.stringify(message) + '\n');
    }
  }

  getMCPTools(): MCPTool[] {
    return Array.from(this.tools.values());
  }

  // Framework-style: Add single MCP server
  async addMCPServer(serverDef: MCPServerDefinition): Promise<void> {
    const config: MCPServerConfig = {
      command: serverDef.command,
      args: serverDef.args,
      env: serverDef.env,
      url: serverDef.url,
      cwd: serverDef.cwd
    };

    this.servers.set(serverDef.name, config);
    await this.startMCPServer(serverDef.name, config);
  }

  // Framework-style: Add multiple servers from array
  async addMCPServers(servers: MCPServerDefinition[]): Promise<void> {
    for (const serverDef of servers) {
      await this.addMCPServer(serverDef);
    }
  }

  // Framework-style: Remove runtime server
  removeMCPServer(name: string): void {
    const childProcess = this.processes.get(name);
    if (childProcess) {
      childProcess.kill();
      this.processes.delete(name);
    }
    this.servers.delete(name);
    
    // Remove tools from this server
    for (const [toolName] of this.tools.entries()) {
      if (toolName.startsWith(`${name}:`)) {
        this.tools.delete(toolName);
      }
    }
  }

  async callMCPTool(toolName: string, args: Record<string, MCPValue>): Promise<MCPToolResult> {
    const [serverName, actualToolName] = toolName.split(':');
    
    // Check if server exists (either from config or runtime)
    const childProcess = this.processes.get(serverName);
    if (!childProcess) {
      // Try to start server if it exists
      const serverConfig = this.servers.get(serverName);
      if (serverConfig) {
        await this.startMCPServer(serverName, serverConfig);
      } else {
        return { content: [{ type: 'text', text: 'Server not found' }], isError: true };
      }
    }
    
    return new Promise((resolve) => {
      const id = Date.now();
      const proc = this.processes.get(serverName);
      
      if (!proc) {
        resolve({ content: [{ type: 'text', text: 'Server not available' }], isError: true });
        return;
      }

      const handler = (data: Buffer) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            try {
              const response = JSON.parse(line);
              if (response.id === id) {
                proc.stdout?.off('data', handler);
                resolve(response.result || { content: [{ type: 'text', text: 'No result' }] });
                return;
              }
            } catch {
              // Continue
            }
          }
        }
      };

      proc.stdout?.on('data', handler);

      this.sendToServer(serverName, {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: actualToolName, arguments: args }
      });

      // Timeout
      setTimeout(() => {
        proc.stdout?.off('data', handler);
        resolve({ content: [{ type: 'text', text: 'Timeout' }], isError: true });
      }, 10000);
    });
  }
}

// Global instance
let mcpInstance: MCP | null = null;

export function getMCP(agent?: IAgent): MCP {
  if (!mcpInstance && agent) {
    mcpInstance = new MCP(agent);
  }
  if (!mcpInstance) {
    throw new Error('MCP not initialized. Call with agent first.');
  }
  return mcpInstance;
}

export * from './types';