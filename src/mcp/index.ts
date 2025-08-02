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
    [key: string]: unknown;
  };
  error?: {
    code: number;
    message: string;
    data?: unknown;
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

    // Strict command validation - only allow absolute paths or simple command names
    const command = config.command.trim();
    const isAbsolutePath = command.startsWith('/');
    const isSimpleCommand = /^[a-zA-Z0-9_-]+$/.test(command);
    
    if (!isAbsolutePath && !isSimpleCommand) {
      this.logger.error(`Unsafe command for MCP server: ${name}`);
      this.logger.debug('MCP server command validation failed - not absolute path or simple command', {
        name,
        command,
        isAbsolutePath,
        isSimpleCommand
      });
      throw new Error(`Invalid command for MCP server '${name}': command must be an absolute path or simple command name`);
    }

    // For absolute paths, ensure they exist and are executable
    if (isAbsolutePath) {
      try {
        const fs = await import('fs');
        const stats = fs.statSync(command);
        if (!stats.isFile()) {
          throw new Error(`Command is not a file: ${command}`);
        }
        // Check if file is executable (basic check)
        fs.accessSync(command, fs.constants.F_OK | fs.constants.X_OK);
      } catch (error) {
        this.logger.error(`Command file validation failed for MCP server: ${name}`);
        this.logger.debug('MCP server command file validation failed', {
          name,
          command,
          error: error instanceof Error ? error.message : String(error)
        });
        throw new Error(`Invalid command file for MCP server '${name}': ${error instanceof Error ? error.message : 'file access error'}`);
      }
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

    // Validate each argument to prevent injection
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (typeof arg !== 'string') {
        this.logger.error(`Invalid argument for MCP server: ${name}`);
        this.logger.debug('MCP server argument validation failed', {
          name,
          invalidArg: arg,
          argType: typeof arg,
          argIndex: i
        });
        throw new Error(`Invalid argument for MCP server '${name}': all arguments must be strings`);
      }
      
      // Check for dangerous patterns in arguments
      const dangerousPatterns = [
        /[;&|`$(){}[\]]/,  // Shell metacharacters
        /\.\./,            // Directory traversal
        /\/etc\/|\/proc\/|\/sys\//,  // System directories
        /^-/               // Options that start with dash (could be dangerous)
      ];
      
      for (const pattern of dangerousPatterns) {
        if (pattern.test(arg)) {
          this.logger.error(`Dangerous argument detected for MCP server: ${name}`);
          this.logger.debug('MCP server dangerous argument detected', {
            name,
            arg: arg.slice(0, 50), // Truncate for logging
            argIndex: i,
            pattern: pattern.toString()
          });
          throw new Error(`Dangerous argument for MCP server '${name}': argument contains unsafe characters or patterns`);
        }
      }
      
      // Limit argument length to prevent buffer overflow attacks
      if (arg.length > 1000) {
        this.logger.error(`Argument too long for MCP server: ${name}`);
        this.logger.debug('MCP server argument too long', {
          name,
          argIndex: i,
          argLength: arg.length,
          maxLength: 1000
        });
        throw new Error(`Argument too long for MCP server '${name}': maximum length is 1000 characters`);
      }
    }

    // Validate environment variables to prevent injection
    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        // Validate environment variable key
        if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
          this.logger.error(`Invalid environment variable key for MCP server: ${name}`);
          this.logger.debug('MCP server environment variable key validation failed', {
            name,
            envKey: key
          });
          throw new Error(`Invalid environment variable key for MCP server '${name}': '${key}' contains invalid characters`);
        }
        
        // Validate environment variable value
        if (typeof value !== 'string' && value !== undefined) {
          this.logger.error(`Invalid environment variable value for MCP server: ${name}`);
          this.logger.debug('MCP server environment variable value validation failed', {
            name,
            envKey: key,
            valueType: typeof value
          });
          throw new Error(`Invalid environment variable value for MCP server '${name}': '${key}' must be a string`);
        }
        
        // Check for dangerous patterns in environment values
        if (value && typeof value === 'string') {
          if (value.includes('\x00') || value.length > 10000) {
            this.logger.error(`Dangerous environment variable value for MCP server: ${name}`);
            this.logger.debug('MCP server dangerous environment variable detected', {
              name,
              envKey: key,
              valueLength: value.length
            });
            throw new Error(`Dangerous environment variable value for MCP server '${name}': '${key}' contains unsafe content`);
          }
        }
      }
    }

    // Use process.env by default, only override if explicitly provided
    const envVars = config.env ? { ...process.env, ...config.env } : process.env;
    
    // Check process limits to prevent resource exhaustion
    if (this.processes.size >= 10) {
      this.logger.error(`Too many MCP servers running for agent: ${this.agent.name}`);
      this.logger.debug('MCP server limit reached', {
        name,
        currentProcesses: this.processes.size,
        maxProcesses: 10,
        agentId: this.agent.id
      });
      throw new Error(`Cannot start MCP server '${name}': maximum number of MCP servers (10) reached`);
    }

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
      cwd: config.cwd,
      detached: false, // Prevent process from becoming session leader
      timeout: 5000   // Timeout for process startup
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
      const stderr = data.toString().trim();
      this.logger.error(`MCP server stderr (${name}): ${stderr}`);
      this.logger.debug('MCP server stderr', {
        serverName: name,
        stderr
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
    this.logger.debug(`Sending initialize message to MCP server: ${name}`);
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
    this.logger.debug(`Requesting tools list from MCP server: ${name}`);
    this.sendToServer(name, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    });
  }

  public handleMessage(serverName: string, message: MCPMessage): void {
    this.logger.debug(`Received MCP message from ${serverName}: method=${message.method}, id=${message.id}`);
    this.logger.debug('Full MCP message', { serverName, message: JSON.stringify(message) });
    
    // Handle tools/list response - can be either method response or result-only message
    if ((message.method === 'tools/list' || (message.id === 2 && message.result?.tools)) && message.result?.tools) {
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
        
        this.logger.debug(`Registered MCP tool: ${serverName}:${tool.name} - ${tool.description}`);
        this.logger.debug('Registered MCP tool', {
          serverName,
          toolName: tool.name,
          toolKey,
          description: tool.description
        });
      }
      
      this.logger.info(`MCP tools registration completed for ${serverName}: ${this.tools.size} total tools`);
      this.logger.debug('MCP tools registration completed', {
        serverName,
        totalTools: this.tools.size,
        serverTools: Array.from(this.tools.keys()).filter(k => k.startsWith(`${serverName}:`))
      });
    } else if (message.result) {
      this.logger.debug(`MCP message result from ${serverName}: ${JSON.stringify(message.result)}`);
    } else if (message.error) {
      this.logger.error(`MCP error from ${serverName}: ${JSON.stringify(message.error)}`);
    } else {
      this.logger.debug(`MCP message from ${serverName} (no result/error): ${JSON.stringify(message)}`);
    }
  }

  public sendToServer(name: string, message: MCPMessage): void {
    const childProcess = this.processes.get(name);
    if (childProcess?.stdin) {
      this.logger.debug(`Sending to ${name}: ${message.method} (id: ${message.id})`);
      this.logger.debug('Sending message to MCP server', {
        serverName: name,
        method: message.method || 'unknown',
        id: message.id || 0,
        hasParams: !!message.params,
        message: JSON.stringify(message)
      });
      childProcess.stdin.write(JSON.stringify(message) + '\n');
    } else {
      this.logger.error(`Cannot send message to ${name} - MCP server not available`);
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
    
    this.logger.debug(`MCP has ${tools.length} tools available: ${tools.map(t => t.name).join(', ')}`);
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
    // Handle both formats: "tool_name" and "server:tool_name"
    let serverName: string;
    let actualToolName: string;
    
    if (toolName.includes(':')) {
      [serverName, actualToolName] = toolName.split(':');
    } else {
      // Find the tool in all servers
      const foundTool = Array.from(this.tools.keys()).find(key => key.endsWith(`:${toolName}`));
      if (foundTool) {
        [serverName, actualToolName] = foundTool.split(':');
      } else {
        // User-facing error log
        this.logger.error(`MCP tool not found: ${toolName}`);
        this.logger.debug('MCP tool not found', {
          requestedTool: toolName,
          availableTools: Array.from(this.tools.keys())
        });
        return { content: [{ type: 'text', text: 'Tool not found' }], isError: true };
      }
    }
    
    // User-facing info log
    this.logger.debug(`Calling MCP tool: ${actualToolName} on ${serverName}`);
    
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
                  this.logger.debug(`MCP tool completed: ${actualToolName}`);
                  
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