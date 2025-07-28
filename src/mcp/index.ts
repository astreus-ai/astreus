import { spawn, ChildProcess } from 'child_process';
import { IAgentModule, IAgent } from '../agent/types';
import { MCPValue } from './types';
import { MCPServerConfig, MCPTool, MCPToolResult, MCPServerDefinition } from './types';
import { Logger } from '../logger/types';

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
  private logger: Logger;

  constructor(private agent: IAgent) {
    this.logger = agent.logger;
    
    // User-facing info log
    this.logger.info('MCP module initialized');
    
    this.logger.debug('MCP module initialized', {
      agentId: agent.id,
      agentName: agent.name
    });
  }

  async initialize(): Promise<void> {
    // User-facing info log
    this.logger.info('MCP module ready');
    
    this.logger.debug('MCP module initialization completed');
  }

  public async startMCPServer(name: string, config: MCPServerConfig): Promise<void> {
    // User-facing info log
    this.logger.info(`Starting MCP server: ${name}`);
    
    this.logger.debug('Starting MCP server', {
      name,
      command: config.command || 'none',
      hasArgs: !!config.args?.length,
      hasUrl: !!config.url,
      hasCwd: !!config.cwd,
      hasEnv: !!config.env
    });
    
    if (config.url) {
      // SSE server - tools will be fetched when needed
      this.logger.info(`SSE MCP server registered: ${name}`);
      this.logger.debug('SSE MCP server registered (deferred start)', { name, url: config.url });
      return;
    }

    if (!config.command) {
      this.logger.debug('No command provided for MCP server', { name });
      return;
    }

    // Validate command and args to prevent command injection
    if (typeof config.command !== 'string' || config.command.trim() === '') {
      this.logger.error(`Invalid command for MCP server: ${name}`);
      this.logger.debug('MCP server command validation failed', {
        name,
        command: config.command,
        commandType: typeof config.command
      });
      throw new Error(`Invalid command for MCP server '${name}': command must be a non-empty string`);
    }

    // Sanitize command - only allow alphanumeric, hyphens, underscores, and forward slashes
    const sanitizedCommand = config.command.replace(/[^a-zA-Z0-9\-_/]/g, '');
    if (sanitizedCommand !== config.command) {
      this.logger.error(`Unsafe command for MCP server: ${name}`);
      this.logger.debug('MCP server command sanitization failed', {
        name,
        originalCommand: config.command,
        sanitizedCommand
      });
      throw new Error(`Invalid command for MCP server '${name}': contains unsafe characters`);
    }

    // Validate args array
    const args = config.args || [];
    if (!Array.isArray(args)) {
      this.logger.error(`Invalid args for MCP server: ${name}`);
      this.logger.debug('MCP server args validation failed', {
        name,
        args,
        argsType: typeof args
      });
      throw new Error(`Invalid args for MCP server '${name}': args must be an array`);
    }

    // Validate each argument
    for (const arg of args) {
      if (typeof arg !== 'string') {
        this.logger.error(`Invalid argument for MCP server: ${name}`);
        this.logger.debug('MCP server argument validation failed', {
          name,
          invalidArg: arg,
          argType: typeof arg
        });
        throw new Error(`Invalid argument for MCP server '${name}': all arguments must be strings`);
      }
    }

    // Use process.env by default, only override if explicitly provided
    const envVars = config.env ? { ...process.env, ...config.env } : process.env;
    
    this.logger.debug('Spawning MCP server process', {
      name,
      command: config.command,
      argCount: args.length,
      cwd: config.cwd || 'default',
      hasCustomEnv: !!config.env
    });
    
    const childProcess = spawn(config.command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: envVars,
      cwd: config.cwd
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
            this.logger.debug('Received MCP message', { 
              serverName: name, 
              method: message.method,
              id: message.id,
              hasResult: !!message.result
            });
            this.handleMessage(name, message);
          } catch (error) {
            this.logger.debug('Failed to parse MCP message', {
              serverName: name,
              line,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }
    });

    childProcess.stderr?.on('data', (data: Buffer) => {
      this.logger.debug('MCP server stderr', {
        serverName: name,
        stderr: data.toString().trim()
      });
    });

    childProcess.on('error', (error) => {
      this.logger.error(`MCP server error: ${name}`);
      this.logger.debug('MCP server process error', {
        serverName: name,
        error: error.message,
        hasStack: !!error.stack
      });
      this.processes.delete(name);
    });

    childProcess.on('exit', (code, signal) => {
      this.logger.info(`MCP server exited: ${name}`);
      this.logger.debug('MCP server process exit', {
        serverName: name,
        exitCode: code,
        signal
      });
      this.processes.delete(name);
    });

    this.processes.set(name, childProcess);

    // User-facing success message
    this.logger.info(`MCP server started: ${name}`);
    
    this.logger.debug('MCP server process started', {
      name,
      pid: childProcess.pid || 0,
      processCount: this.processes.size
    });

    // Initialize
    this.logger.debug('Sending initialize message to MCP server', { serverName: name });
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
    this.logger.debug('Requesting tools list from MCP server', { serverName: name });
    this.sendToServer(name, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    });
  }

  public handleMessage(serverName: string, message: MCPMessage): void {
    if (message.method === 'tools/list' && message.result?.tools) {
      // User-facing info log
      this.logger.info(`Discovered ${message.result.tools.length} tools from ${serverName}`);
      
      this.logger.debug('Processing tools list from MCP server', {
        serverName,
        toolCount: message.result.tools.length,
        toolNames: message.result.tools.map(t => t.name)
      });
      
      for (const tool of message.result.tools) {
        const toolKey = `${serverName}:${tool.name}`;
        this.tools.set(toolKey, tool);
        
        this.logger.debug('Registered MCP tool', {
          serverName,
          toolName: tool.name,
          toolKey,
          description: tool.description
        });
      }
      
      this.logger.debug('MCP tools registration completed', {
        serverName,
        totalTools: this.tools.size,
        serverTools: Array.from(this.tools.keys()).filter(k => k.startsWith(`${serverName}:`))
      });
    }
  }

  public sendToServer(name: string, message: MCPMessage): void {
    const childProcess = this.processes.get(name);
    if (childProcess?.stdin) {
      this.logger.debug('Sending message to MCP server', {
        serverName: name,
        method: message.method || 'unknown',
        id: message.id || 0,
        hasParams: !!message.params
      });
      childProcess.stdin.write(JSON.stringify(message) + '\n');
    } else {
      this.logger.debug('Cannot send message - MCP server not available', {
        serverName: name,
        method: message.method || 'unknown',
        processExists: !!childProcess,
        hasStdin: !!childProcess?.stdin
      });
    }
  }

  getMCPTools(): MCPTool[] {
    const tools = Array.from(this.tools.values());
    
    this.logger.debug('Retrieved MCP tools', {
      toolCount: tools.length,
      toolNames: tools.map(t => t.name)
    });
    
    return tools;
  }

  // Framework-style: Add single MCP server
  async addMCPServer(serverDef: MCPServerDefinition): Promise<void> {
    // User-facing info log
    this.logger.info(`Adding MCP server: ${serverDef.name}`);
    
    this.logger.debug('Adding MCP server definition', {
      name: serverDef.name,
      command: serverDef.command || 'none',
      hasArgs: !!serverDef.args?.length,
      hasUrl: !!serverDef.url,
      hasCwd: !!serverDef.cwd,
      hasEnv: !!serverDef.env
    });
    
    const config: MCPServerConfig = {
      command: serverDef.command,
      args: serverDef.args,
      env: serverDef.env,
      url: serverDef.url,
      cwd: serverDef.cwd
    };

    this.servers.set(serverDef.name, config);
    await this.startMCPServer(serverDef.name, config);
    
    // User-facing success message
    this.logger.info(`MCP server added: ${serverDef.name}`);
    
    this.logger.debug('MCP server added successfully', {
      name: serverDef.name,
      totalServers: this.servers.size
    });
  }

  // Framework-style: Add multiple servers from array
  async addMCPServers(servers: MCPServerDefinition[]): Promise<void> {
    // User-facing info log
    this.logger.info(`Adding ${servers.length} MCP servers`);
    
    this.logger.debug('Adding multiple MCP servers', {
      serverCount: servers.length,
      serverNames: servers.map(s => s.name)
    });
    
    for (const serverDef of servers) {
      await this.addMCPServer(serverDef);
    }
    
    // User-facing success message
    this.logger.info(`Added ${servers.length} MCP servers`);
    
    this.logger.debug('Multiple MCP servers added successfully', {
      addedCount: servers.length,
      totalServers: this.servers.size
    });
  }

  // Framework-style: Remove runtime server
  removeMCPServer(name: string): void {
    // User-facing info log
    this.logger.info(`Removing MCP server: ${name}`);
    
    this.logger.debug('Removing MCP server', {
      name,
      hasProcess: this.processes.has(name),
      hasServerConfig: this.servers.has(name)
    });
    
    const childProcess = this.processes.get(name);
    if (childProcess) {
      this.logger.debug('Killing MCP server process', {
        name,
        pid: childProcess.pid || 0
      });
      childProcess.kill();
      this.processes.delete(name);
    }
    this.servers.delete(name);
    
    // Remove tools from this server
    const toolsToRemove = [];
    for (const [toolName] of this.tools.entries()) {
      if (toolName.startsWith(`${name}:`)) {
        toolsToRemove.push(toolName);
        this.tools.delete(toolName);
      }
    }
    
    // User-facing success message
    this.logger.info(`MCP server removed: ${name}`);
    
    this.logger.debug('MCP server removed successfully', {
      name,
      removedTools: toolsToRemove,
      remainingServers: this.servers.size,
      remainingTools: this.tools.size
    });
  }

  async callMCPTool(toolName: string, args: Record<string, MCPValue>): Promise<MCPToolResult> {
    const [serverName, actualToolName] = toolName.split(':');
    
    // User-facing info log
    this.logger.info(`Calling MCP tool: ${actualToolName} on ${serverName}`);
    
    this.logger.debug('Calling MCP tool', {
      fullToolName: toolName,
      serverName,
      actualToolName,
      args: Object.keys(args),
      argCount: Object.keys(args).length
    });
    
    // Check if server exists (either from config or runtime)
    const childProcess = this.processes.get(serverName);
    if (!childProcess) {
      this.logger.debug('MCP server not running, attempting to start', { serverName });
      
      // Try to start server if it exists
      const serverConfig = this.servers.get(serverName);
      if (serverConfig) {
        await this.startMCPServer(serverName, serverConfig);
      } else {
        this.logger.error(`MCP server not found: ${serverName}`);
        this.logger.debug('MCP server not found in configuration', {
          serverName,
          availableServers: Array.from(this.servers.keys())
        });
        return { content: [{ type: 'text', text: 'Server not found' }], isError: true };
      }
    }
    
    return new Promise((resolve) => {
      const id = Date.now();
      const proc = this.processes.get(serverName);
      
      if (!proc) {
        this.logger.error(`MCP server not available: ${serverName}`);
        this.logger.debug('MCP server process not available after start attempt', { serverName });
        resolve({ content: [{ type: 'text', text: 'Server not available' }], isError: true });
        return;
      }

      this.logger.debug('Setting up MCP tool call handler', {
        serverName,
        actualToolName,
        callId: id
      });

      const handler = (data: Buffer) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            try {
              const response = JSON.parse(line);
              if (response.id === id) {
                proc.stdout?.off('data', handler);
                
                const result = response.result || { content: [{ type: 'text', text: 'No result' }] };
                const isError = !!response.error;
                
                if (isError) {
                  this.logger.error(`MCP tool call failed: ${actualToolName}`);
                  this.logger.debug('MCP tool call error response', {
                    serverName,
                    actualToolName,
                    callId: id,
                    error: response.error
                  });
                } else {
                  // User-facing success message
                  this.logger.info(`MCP tool completed: ${actualToolName}`);
                  
                  this.logger.debug('MCP tool call successful', {
                    serverName,
                    actualToolName,
                    callId: id,
                    hasContent: !!result.content
                  });
                }
                
                resolve(result);
                return;
              }
            } catch (error) {
              this.logger.debug('Failed to parse MCP tool response', {
                serverName,
                actualToolName,
                callId: id,
                line,
                error: error instanceof Error ? error.message : String(error)
              });
            }
          }
        }
      };

      proc.stdout?.on('data', handler);

      this.logger.debug('Sending MCP tool call request', {
        serverName,
        actualToolName,
        callId: id
      });

      this.sendToServer(serverName, {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: actualToolName, arguments: args }
      });

      // Timeout
      setTimeout(() => {
        proc.stdout?.off('data', handler);
        
        this.logger.error(`MCP tool call timeout: ${actualToolName}`);
        this.logger.debug('MCP tool call timeout', {
          serverName,
          actualToolName,
          callId: id,
          timeoutMs: 10000
        });
        
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