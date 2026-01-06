import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { IAgentModule, IAgent } from '../agent/types';
import { MCPValue } from './types';
import {
  MCPServerConfig,
  MCPTool,
  MCPToolResult,
  MCPServerDefinition,
  MCPJsonSchema,
} from './types';
import { Logger } from '../logger/types';
import * as fs from 'fs';
import { ToolError } from '../errors';

// Default timeout for MCP tool calls (in milliseconds)
const DEFAULT_TOOL_CALL_TIMEOUT = 30000;
// Maximum number of MCP servers allowed
const MAX_MCP_SERVERS = 10;
// Maximum buffer size for stdout (10MB)
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

interface MCPMessage {
  jsonrpc: string;
  id?: string | number;
  method?: string;
  params?: Record<string, MCPValue>;
  result?: {
    tools?: MCPTool[];
  } & Record<string, MCPValue>;
  error?: {
    code: number;
    message: string;
    data?: MCPValue;
  };
}

export class MCP implements IAgentModule {
  readonly name = 'mcp';
  public processes: Map<string, ChildProcess> = new Map();
  public tools: Map<string, MCPTool> = new Map();
  public servers: Map<string, MCPServerConfig> = new Map();
  private logger: Logger;
  private pendingCallbacks: Map<
    string,
    { resolve: (result: MCPToolResult) => void; timeoutId: NodeJS.Timeout }
  > = new Map();
  private messageHandlers: Map<string, (data: Buffer) => void> = new Map();
  private toolCallTimeout: number = DEFAULT_TOOL_CALL_TIMEOUT;
  private forceKillTimers: Map<number, NodeJS.Timeout> = new Map();

  constructor(private agent: IAgent) {
    this.logger = agent.logger;

    // User-facing info log
    this.logger.info('MCP module initialized');

    this.logger.debug('MCP module initialized', {
      agentId: agent.id,
      agentName: agent.name,
    });
  }

  async initialize(): Promise<void> {
    // User-facing info log
    this.logger.info('MCP module ready');

    this.logger.debug('MCP module initialization completed');
  }

  /**
   * Set the timeout for MCP tool calls
   * @param timeoutMs Timeout in milliseconds
   */
  setToolCallTimeout(timeoutMs: number): void {
    if (timeoutMs <= 0) {
      this.logger.warn('Invalid timeout value, using default');
      this.toolCallTimeout = DEFAULT_TOOL_CALL_TIMEOUT;
      return;
    }
    this.toolCallTimeout = timeoutMs;
    this.logger.debug('Tool call timeout set', { timeoutMs });
  }

  /**
   * Cleanup resources for a specific server
   * @param name Server name
   */
  private cleanupServerResources(name: string): void {
    // Remove message handler
    const handler = this.messageHandlers.get(name);
    if (handler) {
      const proc = this.processes.get(name);
      if (proc?.stdout) {
        proc.stdout.off('data', handler);
      }
      this.messageHandlers.delete(name);
    }

    // Cancel pending callbacks for this server
    // This prevents memory leaks and hanging promises when server crashes
    for (const [callId, callback] of this.pendingCallbacks.entries()) {
      // Check if this callback is related to the server being cleaned up
      // We can't directly check server association, so we cancel all pending callbacks
      // when a server crashes to be safe
      clearTimeout(callback.timeoutId);
      callback.resolve({
        content: [{ type: 'text', text: `Server '${name}' crashed or was terminated` }],
        isError: true,
      });
      this.pendingCallbacks.delete(callId);
      this.logger.debug('Cancelled pending callback due to server cleanup', {
        serverName: name,
        callId,
      });
    }

    // Remove process
    this.processes.delete(name);

    // Remove tools from this server
    for (const [toolName] of this.tools.entries()) {
      if (toolName.startsWith(`${name}:`)) {
        this.tools.delete(toolName);
      }
    }
  }

  /**
   * Cleanup all resources - call this before destroying the MCP instance
   */
  async cleanup(): Promise<void> {
    this.logger.info('Cleaning up MCP module');

    // Cancel all pending callbacks
    for (const [callId, callback] of this.pendingCallbacks.entries()) {
      clearTimeout(callback.timeoutId);
      callback.resolve({
        content: [{ type: 'text', text: 'MCP cleanup - call cancelled' }],
        isError: true,
      });
      this.pendingCallbacks.delete(callId);
    }

    // Remove all message handlers
    for (const [serverName, handler] of this.messageHandlers.entries()) {
      const proc = this.processes.get(serverName);
      if (proc?.stdout) {
        proc.stdout.off('data', handler);
      }
      this.messageHandlers.delete(serverName);
    }

    // Clear any existing force kill timers
    for (const [pid, timer] of this.forceKillTimers.entries()) {
      clearTimeout(timer);
      this.forceKillTimers.delete(pid);
    }

    // Kill all processes and wait for them to exit
    const exitPromises: Promise<void>[] = [];

    for (const [name, proc] of this.processes.entries()) {
      this.logger.debug('Killing MCP server process during cleanup', { name, pid: proc.pid ?? 0 });

      // Create a promise that resolves when the process exits
      const exitPromise = new Promise<void>((resolve) => {
        // If already killed, resolve immediately
        if (proc.killed) {
          resolve();
          return;
        }

        // Set up exit handler
        const exitHandler = () => {
          // Clean up force kill timer if it exists
          if (proc.pid) {
            const timer = this.forceKillTimers.get(proc.pid);
            if (timer) {
              clearTimeout(timer);
              this.forceKillTimers.delete(proc.pid);
            }
          }
          resolve();
        };

        proc.once('exit', exitHandler);
        proc.once('error', exitHandler);

        // Send SIGTERM for graceful shutdown
        proc.kill('SIGTERM');

        // Set up force kill timer if process has a PID
        if (proc.pid) {
          const forceKillTimer = setTimeout(() => {
            if (!proc.killed) {
              proc.kill('SIGKILL');
            }
            this.forceKillTimers.delete(proc.pid!);
            // If still not exited after SIGKILL, resolve anyway
            setTimeout(() => resolve(), 500);
          }, 5000);
          this.forceKillTimers.set(proc.pid, forceKillTimer);
        } else {
          // No PID, resolve after a short delay
          setTimeout(() => resolve(), 100);
        }
      });

      exitPromises.push(exitPromise);
    }

    // Wait for all processes to exit (with a maximum timeout)
    await Promise.race([
      Promise.all(exitPromises),
      new Promise<void>((resolve) => setTimeout(resolve, 10000)), // 10 second max wait
    ]);

    // Clear any remaining force kill timers
    for (const [pid, timer] of this.forceKillTimers.entries()) {
      clearTimeout(timer);
      this.forceKillTimers.delete(pid);
    }

    this.processes.clear();
    this.tools.clear();
    this.servers.clear();

    this.logger.info('MCP module cleanup completed');
  }

  /**
   * Alias for cleanup() - for consistent destroy() method naming across modules
   */
  async destroy(): Promise<void> {
    return this.cleanup();
  }

  public async startMCPServer(name: string, config: MCPServerConfig): Promise<void> {
    // User-facing info log
    this.logger.info(`Starting MCP server: ${name}`);

    this.logger.debug('Starting MCP server', {
      name,
      command: config.command ?? 'none',
      hasArgs: !!config.args?.length,
      hasUrl: !!config.url,
      hasCwd: !!config.cwd,
      hasEnv: !!config.env,
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
        commandType: typeof config.command,
      });
      throw new Error(
        `Invalid command for MCP server '${name}': command must be a non-empty string`
      );
    }

    // Strict command validation - only allow absolute paths or simple command names
    const command = config.command.trim();
    const isAbsolutePath = command.startsWith('/');
    const isSimpleCommand = /^[a-zA-Z0-9_-]+$/.test(command);

    if (!isAbsolutePath && !isSimpleCommand) {
      this.logger.error(`Unsafe command for MCP server: ${name}`);
      this.logger.debug(
        'MCP server command validation failed - not absolute path or simple command',
        {
          name,
          command,
          isAbsolutePath,
          isSimpleCommand,
        }
      );
      throw new Error(
        `Invalid command for MCP server '${name}': command must be an absolute path or simple command name`
      );
    }

    // For absolute paths, ensure they exist and are executable
    if (isAbsolutePath) {
      try {
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
          error: error instanceof Error ? error.message : String(error),
        });
        throw new Error(
          `Invalid command file for MCP server '${name}': ${error instanceof Error ? error.message : 'file access error'}`
        );
      }
    }

    // Validate args array
    const args = config.args ?? [];
    if (!Array.isArray(args)) {
      this.logger.error(`Invalid args for MCP server: ${name}`);
      this.logger.debug('MCP server args validation failed', {
        name,
        args,
        argsType: typeof args,
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
          argIndex: i,
        });
        throw new Error(`Invalid argument for MCP server '${name}': all arguments must be strings`);
      }

      // Check for dangerous patterns in arguments
      // Only block specific dangerous options/patterns, allow normal CLI args
      const dangerousPatterns = [
        /[;&|`$(){}[\]]/, // Shell metacharacters
        /\.\./, // Directory traversal
        /\/etc\/|\/proc\/|\/sys\//, // System directories
      ];

      // Dangerous command-line options that could lead to code execution
      const dangerousOptions = [
        '--eval',
        '-e', // Node.js eval
        '--exec', // Execute command
        '--import', // Dynamic import (Node.js)
        '-c', // Python/Ruby command execution
        '--command', // Shell command execution
        '-i', // Interactive mode (some interpreters)
      ];

      for (const pattern of dangerousPatterns) {
        if (pattern.test(arg)) {
          this.logger.error(`Dangerous argument detected for MCP server: ${name}`);
          this.logger.debug('MCP server dangerous argument detected', {
            name,
            arg: arg.slice(0, 50), // Truncate for logging
            argIndex: i,
            pattern: pattern.toString(),
          });
          throw new Error(
            `Dangerous argument for MCP server '${name}': argument contains unsafe characters or patterns`
          );
        }
      }

      // Check for dangerous options (case-insensitive for options, exact match for values)
      const lowerArg = arg.toLowerCase();
      for (const dangerousOpt of dangerousOptions) {
        if (lowerArg === dangerousOpt || lowerArg.startsWith(`${dangerousOpt}=`)) {
          this.logger.error(`Dangerous option detected for MCP server: ${name}`);
          this.logger.debug('MCP server dangerous option detected', {
            name,
            arg: arg.slice(0, 50),
            argIndex: i,
            matchedOption: dangerousOpt,
          });
          throw new Error(
            `Dangerous argument for MCP server '${name}': option '${dangerousOpt}' is not allowed`
          );
        }
      }

      // Limit argument length to prevent buffer overflow attacks
      if (arg.length > 1000) {
        this.logger.error(`Argument too long for MCP server: ${name}`);
        this.logger.debug('MCP server argument too long', {
          name,
          argIndex: i,
          argLength: arg.length,
          maxLength: 1000,
        });
        throw new Error(
          `Argument too long for MCP server '${name}': maximum length is 1000 characters`
        );
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
            envKey: key,
          });
          throw new Error(
            `Invalid environment variable key for MCP server '${name}': '${key}' contains invalid characters`
          );
        }

        // Validate environment variable value
        if (typeof value !== 'string' && value !== undefined) {
          this.logger.error(`Invalid environment variable value for MCP server: ${name}`);
          this.logger.debug('MCP server environment variable value validation failed', {
            name,
            envKey: key,
            valueType: typeof value,
          });
          throw new Error(
            `Invalid environment variable value for MCP server '${name}': '${key}' must be a string`
          );
        }

        // Check for dangerous patterns in environment values
        if (value && typeof value === 'string') {
          if (value.includes('\x00') || value.length > 10000) {
            this.logger.error(`Dangerous environment variable value for MCP server: ${name}`);
            this.logger.debug('MCP server dangerous environment variable detected', {
              name,
              envKey: key,
              valueLength: value.length,
            });
            throw new Error(
              `Dangerous environment variable value for MCP server '${name}': '${key}' contains unsafe content`
            );
          }
        }
      }
    }

    // Use process.env by default, only override if explicitly provided
    const envVars = config.env ? { ...process.env, ...config.env } : process.env;

    // Check process limits to prevent resource exhaustion
    if (this.processes.size >= MAX_MCP_SERVERS) {
      this.logger.error(`Too many MCP servers running for agent: ${this.agent.name}`);
      this.logger.debug('MCP server limit reached', {
        name,
        currentProcesses: this.processes.size,
        maxProcesses: MAX_MCP_SERVERS,
        agentId: this.agent.id,
      });
      throw new Error(
        `Cannot start MCP server '${name}': maximum number of MCP servers (${MAX_MCP_SERVERS}) reached`
      );
    }

    this.logger.debug('Spawning MCP server process', {
      name,
      command: config.command,
      argCount: args.length,
      cwd: config.cwd ?? 'default',
      hasCustomEnv: !!config.env,
    });

    let childProcess: ChildProcess;
    try {
      // Check Node.js version for spawn timeout support (Node.js 15+)
      const nodeVersion = process.versions.node.split('.').map(Number);
      const supportsSpawnTimeout = nodeVersion[0] >= 15;

      interface SpawnOptionsWithTimeout {
        stdio: ['pipe', 'pipe', 'pipe'];
        env: NodeJS.ProcessEnv;
        cwd?: string;
        detached: boolean;
        timeout?: number;
      }

      const spawnOptions: SpawnOptionsWithTimeout = {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: envVars,
        cwd: config.cwd,
        detached: false, // Prevent process from becoming session leader
      };

      // Only add timeout option if Node.js version supports it
      if (supportsSpawnTimeout) {
        spawnOptions.timeout = 5000; // Timeout for process startup
      } else {
        this.logger.debug('Node.js version does not support spawn timeout', {
          nodeVersion: process.versions.node,
          requiredVersion: '15.0.0',
        });
      }

      childProcess = spawn(config.command, args, spawnOptions);
    } catch (spawnError) {
      this.logger.error(`Failed to spawn MCP server process: ${name}`);
      this.logger.debug('MCP server spawn error', {
        name,
        error: spawnError instanceof Error ? spawnError.message : String(spawnError),
      });
      throw new Error(
        `Failed to spawn MCP server '${name}': ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`
      );
    }

    // Verify the process was created successfully
    if (!childProcess.pid) {
      this.logger.error(`MCP server process failed to start: ${name}`);
      throw new Error(`MCP server '${name}' process failed to start - no PID assigned`);
    }

    let buffer = '';
    const stdout = childProcess.stdout;
    if (stdout) {
      stdout.on('data', (data: Buffer) => {
        buffer += data.toString();

        // Prevent buffer overflow by truncating if it exceeds the limit
        if (buffer.length > MAX_BUFFER_SIZE) {
          const originalLength = buffer.length;
          const truncatedBytes = originalLength - MAX_BUFFER_SIZE;
          buffer = buffer.slice(-MAX_BUFFER_SIZE);
          this.logger.warn(
            `MCP buffer truncated due to size limit for server: ${name}. Discarded ${truncatedBytes} bytes (${(truncatedBytes / 1024 / 1024).toFixed(2)} MB). This may indicate the server is producing excessive output or malformed JSON.`
          );
          this.logger.debug('MCP buffer truncation details', {
            serverName: name,
            originalLength,
            truncatedBytes,
            maxBufferSize: MAX_BUFFER_SIZE,
            retainedLength: buffer.length,
          });
        }

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const message = JSON.parse(line);
              this.logger.debug('Received MCP message', {
                serverName: name,
                method: message.method,
                id: message.id,
                hasResult: !!message.result,
              });
              this.handleMessage(name, message);
            } catch (error) {
              this.logger.debug('Failed to parse MCP message', {
                serverName: name,
                line,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      });
    } else {
      this.logger.warn(`MCP server '${name}' has no stdout - communication may be limited`);
    }

    const stderr = childProcess.stderr;
    if (stderr) {
      stderr.on('data', (data: Buffer) => {
        const stderrOutput = data.toString().trim();
        this.logger.error(`MCP server stderr (${name}): ${stderrOutput}`);
        this.logger.debug('MCP server stderr', {
          serverName: name,
          stderr: stderrOutput,
        });
      });
    }

    childProcess.on('error', (error) => {
      this.logger.error(`MCP server error: ${name}`);
      this.logger.debug('MCP server process error', {
        serverName: name,
        error: error.message,
        hasStack: !!error.stack,
      });
      // Clean up associated resources
      this.cleanupServerResources(name);
    });

    childProcess.on('exit', (code, signal) => {
      this.logger.info(`MCP server exited: ${name}`);
      this.logger.debug('MCP server process exit', {
        serverName: name,
        exitCode: code ?? null,
        signal: signal ?? null,
      });
      // Clean up associated resources
      this.cleanupServerResources(name);
    });

    this.processes.set(name, childProcess);

    // User-facing success message
    this.logger.info(`MCP server started: ${name}`);

    this.logger.debug('MCP server process started', {
      name,
      pid: childProcess.pid ?? 0,
      processCount: this.processes.size,
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
        clientInfo: { name: 'astreus', version: '1.0.0' },
      },
    });

    // List tools
    this.logger.debug(`Requesting tools list from MCP server: ${name}`);
    this.sendToServer(name, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
  }

  public handleMessage(serverName: string, message: MCPMessage): void {
    this.logger.debug(
      `Received MCP message from ${serverName}: method=${message.method}, id=${message.id}`
    );
    this.logger.debug('Full MCP message', { serverName, message: JSON.stringify(message) });

    // Handle tools/list response - can be either method response or result-only message
    if (
      (message.method === 'tools/list' || (message.id === 2 && message.result?.tools)) &&
      message.result?.tools
    ) {
      // User-facing info log
      this.logger.info(`Discovered ${message.result.tools.length} tools from ${serverName}`);

      this.logger.debug('Processing tools list from MCP server', {
        serverName,
        toolCount: message.result.tools.length,
        toolNames: message.result.tools.map((t) => t.name),
      });

      for (const tool of message.result.tools) {
        const toolKey = `${serverName}:${tool.name}`;
        this.tools.set(toolKey, tool);

        this.logger.debug(`Registered MCP tool: ${serverName}:${tool.name} - ${tool.description}`);
        this.logger.debug('Registered MCP tool', {
          serverName,
          toolName: tool.name,
          toolKey,
          description: tool.description,
        });
      }

      this.logger.info(
        `MCP tools registration completed for ${serverName}: ${this.tools.size} total tools`
      );
      this.logger.debug('MCP tools registration completed', {
        serverName,
        totalTools: this.tools.size,
        serverTools: Array.from(this.tools.keys()).filter((k) => k.startsWith(`${serverName}:`)),
      });
    } else if (message.result) {
      this.logger.debug(`MCP message result from ${serverName}: ${JSON.stringify(message.result)}`);
    } else if (message.error) {
      this.logger.error(`MCP error from ${serverName}: ${JSON.stringify(message.error)}`);
    } else {
      this.logger.debug(
        `MCP message from ${serverName} (no result/error): ${JSON.stringify(message)}`
      );
    }
  }

  public sendToServer(name: string, message: MCPMessage): void {
    const childProcess = this.processes.get(name);
    if (childProcess?.stdin) {
      this.logger.debug(`Sending to ${name}: ${message.method} (id: ${message.id})`);
      this.logger.debug('Sending message to MCP server', {
        serverName: name,
        method: message.method ?? 'unknown',
        id: message.id ?? 0,
        hasParams: !!message.params,
        message: JSON.stringify(message),
      });
      childProcess.stdin.write(JSON.stringify(message) + '\n');
    } else {
      this.logger.error(`Cannot send message to ${name} - MCP server not available`);
      this.logger.debug('Cannot send message - MCP server not available', {
        serverName: name,
        method: message.method ?? 'unknown',
        processExists: !!childProcess,
        hasStdin: !!childProcess?.stdin,
      });
    }
  }

  getMCPTools(): MCPTool[] {
    const tools = Array.from(this.tools.values());

    this.logger.debug(
      `MCP has ${tools.length} tools available: ${tools.map((t) => t.name).join(', ')}`
    );
    this.logger.debug('Retrieved MCP tools', {
      toolCount: tools.length,
      toolNames: tools.map((t) => t.name),
    });

    return tools;
  }

  /**
   * Validate a server definition before adding it
   * @param serverDef The server definition to validate
   * @throws Error if the server definition is invalid
   */
  private validateServerDefinition(serverDef: MCPServerDefinition): void {
    // Validate name
    if (!serverDef.name || typeof serverDef.name !== 'string') {
      throw new Error('Server definition must have a valid name');
    }

    if (serverDef.name.trim() === '') {
      throw new Error('Server name cannot be empty');
    }

    // Check for invalid characters in name
    if (!/^[a-zA-Z0-9_-]+$/.test(serverDef.name)) {
      throw new Error(
        `Server name '${serverDef.name}' contains invalid characters. Use only alphanumeric, underscore, and dash.`
      );
    }

    // Must have either command or url
    if (!serverDef.command && !serverDef.url) {
      throw new Error(`Server '${serverDef.name}' must have either a command or url`);
    }

    // Cannot have both command and url
    if (serverDef.command && serverDef.url) {
      throw new Error(`Server '${serverDef.name}' cannot have both command and url`);
    }

    // Validate url format if provided
    if (serverDef.url) {
      try {
        new URL(serverDef.url);
      } catch {
        throw new Error(`Server '${serverDef.name}' has invalid URL: ${serverDef.url}`);
      }
    }

    // Check for duplicate server names
    if (this.servers.has(serverDef.name)) {
      throw new Error(`Server '${serverDef.name}' already exists`);
    }
  }

  // Framework-style: Add single MCP server
  async addMCPServer(serverDef: MCPServerDefinition): Promise<void> {
    // Validate server definition first
    this.validateServerDefinition(serverDef);

    // User-facing info log
    this.logger.info(`Adding MCP server: ${serverDef.name}`);

    this.logger.debug('Adding MCP server definition', {
      name: serverDef.name,
      command: serverDef.command ?? 'none',
      hasArgs: !!serverDef.args?.length,
      hasUrl: !!serverDef.url,
      hasCwd: !!serverDef.cwd,
      hasEnv: !!serverDef.env,
    });

    const config: MCPServerConfig = {
      command: serverDef.command,
      args: serverDef.args,
      env: serverDef.env,
      url: serverDef.url,
      cwd: serverDef.cwd,
    };

    this.servers.set(serverDef.name, config);

    try {
      await this.startMCPServer(serverDef.name, config);
    } catch (error) {
      // Rollback on failure
      this.servers.delete(serverDef.name);
      throw error;
    }

    // User-facing success message
    this.logger.info(`MCP server added: ${serverDef.name}`);

    this.logger.debug('MCP server added successfully', {
      name: serverDef.name,
      totalServers: this.servers.size,
    });
  }

  // Framework-style: Add multiple servers from array
  async addMCPServers(servers: MCPServerDefinition[]): Promise<void> {
    // User-facing info log
    this.logger.info(`Adding ${servers.length} MCP servers`);

    this.logger.debug('Adding multiple MCP servers', {
      serverCount: servers.length,
      serverNames: servers.map((s) => s.name),
    });

    for (const serverDef of servers) {
      await this.addMCPServer(serverDef);
    }

    // User-facing success message
    this.logger.info(`Added ${servers.length} MCP servers`);

    this.logger.debug('Multiple MCP servers added successfully', {
      addedCount: servers.length,
      totalServers: this.servers.size,
    });
  }

  // Framework-style: Remove runtime server
  removeMCPServer(name: string): void {
    // User-facing info log
    this.logger.info(`Removing MCP server: ${name}`);

    this.logger.debug('Removing MCP server', {
      name,
      hasProcess: this.processes.has(name),
      hasServerConfig: this.servers.has(name),
    });

    // Remove message handler first to prevent memory leaks
    const handler = this.messageHandlers.get(name);
    const childProcess = this.processes.get(name);
    if (handler && childProcess?.stdout) {
      childProcess.stdout.off('data', handler);
      this.messageHandlers.delete(name);
    }

    if (childProcess) {
      this.logger.debug('Killing MCP server process', {
        name,
        pid: childProcess.pid ?? 0,
      });
      childProcess.kill('SIGTERM');
      this.processes.delete(name);
    }
    this.servers.delete(name);

    // Remove tools from this server
    const toolsToRemove: string[] = [];
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
      remainingTools: this.tools.size,
    });
  }

  /**
   * Validate MCP tool parameters against inputSchema (JSON Schema)
   * @param tool The MCP tool definition
   * @param args The arguments to validate
   * @returns Error message if validation fails, null if successful
   */
  private validateMCPToolParameters(tool: MCPTool, args: Record<string, MCPValue>): string | null {
    const schema = tool.inputSchema;

    if (!schema || !schema.properties) {
      // No schema defined, skip validation
      return null;
    }

    this.logger.debug('Validating MCP tool parameters', {
      toolName: tool.name,
      expectedParams: Object.keys(schema.properties || {}),
      providedParams: Object.keys(args),
      requiredParams: schema.required || [],
    });

    // Check required parameters
    if (schema.required && Array.isArray(schema.required)) {
      for (const requiredParam of schema.required) {
        if (args[requiredParam] === undefined || args[requiredParam] === null) {
          this.logger.debug('Required MCP parameter missing', {
            toolName: tool.name,
            paramName: requiredParam,
          });
          return `Required parameter '${requiredParam}' is missing`;
        }
      }
    }

    // Validate parameter types against schema
    for (const [paramName, paramValue] of Object.entries(args)) {
      const paramSchema = schema.properties?.[paramName];

      if (!paramSchema) {
        // Unknown parameter - log warning but allow (some tools accept additional params)
        this.logger.debug('Unknown parameter provided to MCP tool', {
          toolName: tool.name,
          paramName,
        });
        continue;
      }

      const typeError = this.validateMCPParameterType(paramValue, paramSchema, paramName);
      if (typeError) {
        return typeError;
      }
    }

    this.logger.debug('MCP tool parameter validation successful', {
      toolName: tool.name,
      validatedParams: Object.keys(args).length,
    });

    return null;
  }

  /**
   * Validate a single parameter value against its JSON schema
   */
  private validateMCPParameterType(
    value: MCPValue,
    schema: MCPJsonSchema,
    paramName: string
  ): string | null {
    if (value === null) {
      // null is generally allowed unless schema explicitly forbids it
      return null;
    }

    const expectedType = schema.type;
    const actualType = Array.isArray(value) ? 'array' : typeof value;

    switch (expectedType) {
      case 'string':
        if (typeof value !== 'string') {
          return `Parameter '${paramName}' expected string, got ${actualType}`;
        }
        // Validate enum if present
        if (schema.enum && !schema.enum.includes(value)) {
          return `Parameter '${paramName}' must be one of: ${schema.enum.join(', ')}`;
        }
        break;
      case 'number':
      case 'integer':
        if (typeof value !== 'number') {
          return `Parameter '${paramName}' expected ${expectedType}, got ${actualType}`;
        }
        if (expectedType === 'integer' && !Number.isInteger(value)) {
          return `Parameter '${paramName}' expected integer, got float`;
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          return `Parameter '${paramName}' expected boolean, got ${actualType}`;
        }
        break;
      case 'array':
        if (!Array.isArray(value)) {
          return `Parameter '${paramName}' expected array, got ${actualType}`;
        }
        // Validate array items if schema.items is defined
        if (schema.items && Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) {
            const itemError = this.validateMCPParameterType(
              value[i] as MCPValue,
              schema.items,
              `${paramName}[${i}]`
            );
            if (itemError) {
              return itemError;
            }
          }
        }
        break;
      case 'object':
        if (typeof value !== 'object' || Array.isArray(value)) {
          return `Parameter '${paramName}' expected object, got ${actualType}`;
        }
        // Validate nested properties if defined
        if (schema.properties && typeof value === 'object' && value !== null) {
          const objValue = value as Record<string, MCPValue>;
          for (const [nestedKey, nestedSchema] of Object.entries(schema.properties)) {
            if (objValue[nestedKey] !== undefined) {
              const nestedError = this.validateMCPParameterType(
                objValue[nestedKey],
                nestedSchema,
                `${paramName}.${nestedKey}`
              );
              if (nestedError) {
                return nestedError;
              }
            }
          }
        }
        break;
      default:
        // Unknown type, skip validation
        break;
    }

    return null;
  }

  async callMCPTool(toolName: string, args: Record<string, MCPValue>): Promise<MCPToolResult> {
    // Handle both formats: "tool_name" and "server:tool_name"
    let serverName: string;
    let actualToolName: string;
    let toolKey: string;

    if (toolName.includes(':')) {
      [serverName, actualToolName] = toolName.split(':');
      toolKey = toolName;
    } else {
      // Find all tools with this name across servers
      const matchingTools = Array.from(this.tools.keys()).filter((key) =>
        key.endsWith(`:${toolName}`)
      );

      if (matchingTools.length === 0) {
        // Create normalized ToolError for consistent error handling
        const toolError = new ToolError(
          `MCP tool '${toolName}' not found`,
          toolName,
          'mcp',
          'not_found',
          false
        );
        this.logger.error(`MCP tool not found: ${toolName}`, toolError);
        this.logger.debug('MCP tool not found', {
          requestedTool: toolName,
          availableTools: Array.from(this.tools.keys()),
        });
        return { content: [{ type: 'text', text: toolError.message }], isError: true };
      }

      if (matchingTools.length > 1) {
        // Multiple tools with same name - warn and use deterministic selection (alphabetical)
        matchingTools.sort();
        this.logger.warn(
          `MCP tool name '${toolName}' is ambiguous - found in ${matchingTools.length} servers: ${matchingTools.join(', ')}. Using '${matchingTools[0]}' (alphabetically first). Consider using full name with server prefix.`
        );
        this.logger.debug('MCP tool name ambiguity detected', {
          requestedTool: toolName,
          matchingTools,
          selectedTool: matchingTools[0],
        });
      }

      toolKey = matchingTools[0];
      [serverName, actualToolName] = toolKey.split(':');
    }

    // Get tool definition for validation
    const tool = this.tools.get(toolKey);
    if (tool) {
      // Validate parameters against inputSchema
      const validationError = this.validateMCPToolParameters(tool, args);
      if (validationError) {
        // Create normalized ToolError for validation failures
        const toolError = new ToolError(
          `MCP tool '${actualToolName}' validation failed: ${validationError}`,
          actualToolName,
          'mcp',
          'validation',
          true // Validation errors are recoverable - LLM can try with correct parameters
        );
        this.logger.error(`MCP tool parameter validation failed: ${actualToolName}`, toolError);
        this.logger.debug('MCP tool parameter validation error', {
          toolName: actualToolName,
          serverName,
          validationError,
          providedArgs: Object.keys(args),
        });
        return { content: [{ type: 'text', text: toolError.message }], isError: true };
      }
    }

    // User-facing info log
    this.logger.debug(`Calling MCP tool: ${actualToolName} on ${serverName}`);

    this.logger.debug('Calling MCP tool', {
      fullToolName: toolName,
      serverName,
      actualToolName,
      args: Object.keys(args),
      argCount: Object.keys(args).length,
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
        // Create normalized ToolError for server not found
        const toolError = new ToolError(
          `MCP server '${serverName}' not found for tool '${actualToolName}'`,
          actualToolName,
          'mcp',
          'not_found',
          false
        );
        this.logger.error(`MCP server not found: ${serverName}`, toolError);
        this.logger.debug('MCP server not found in configuration', {
          serverName,
          availableServers: Array.from(this.servers.keys()),
        });
        return { content: [{ type: 'text', text: toolError.message }], isError: true };
      }
    }

    return new Promise((resolve) => {
      // Use UUID for unique message ID to avoid collisions with concurrent calls
      const id = randomUUID();
      const proc = this.processes.get(serverName);

      if (!proc) {
        this.logger.error(`MCP server not available: ${serverName}`);
        this.logger.debug('MCP server process not available after start attempt', { serverName });
        resolve({ content: [{ type: 'text', text: 'Server not available' }], isError: true });
        return;
      }

      // Ensure stdout is available
      const stdout = proc.stdout;
      if (!stdout) {
        this.logger.error(`MCP server stdout not available: ${serverName}`);
        resolve({
          content: [{ type: 'text', text: 'Server stdout not available' }],
          isError: true,
        });
        return;
      }

      this.logger.debug('Setting up MCP tool call handler', {
        serverName,
        actualToolName,
        callId: id,
      });

      let resolved = false;

      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          stdout.off('data', handler);
          const pendingCallback = this.pendingCallbacks.get(id);
          if (pendingCallback) {
            clearTimeout(pendingCallback.timeoutId);
            this.pendingCallbacks.delete(id);
          }
        }
      };

      const handler = (data: Buffer) => {
        if (resolved) return;

        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            try {
              const response = JSON.parse(line);
              if (response.id === id) {
                cleanup();

                const result = response.result ?? {
                  content: [{ type: 'text', text: 'No result' }],
                };
                const isError = !!response.error;

                if (isError) {
                  this.logger.error(`MCP tool call failed: ${actualToolName}`);
                  this.logger.debug('MCP tool call error response', {
                    serverName,
                    actualToolName,
                    callId: id,
                    error: response.error,
                  });
                } else {
                  // User-facing success message
                  this.logger.debug(`MCP tool completed: ${actualToolName}`);

                  this.logger.debug('MCP tool call successful', {
                    serverName,
                    actualToolName,
                    callId: id,
                    hasContent: !!result.content,
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
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      };

      stdout.on('data', handler);

      // Set up timeout with configurable duration
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          cleanup();

          // Create normalized ToolError for timeout
          const toolError = new ToolError(
            `MCP tool '${actualToolName}' timed out after ${this.toolCallTimeout}ms`,
            actualToolName,
            'mcp',
            'timeout',
            true // Timeout errors are recoverable - can retry
          );
          this.logger.error(`MCP tool call timeout: ${actualToolName}`, toolError);
          this.logger.debug('MCP tool call timeout', {
            serverName,
            actualToolName,
            callId: id,
            timeoutMs: this.toolCallTimeout,
          });

          resolve({ content: [{ type: 'text', text: toolError.message }], isError: true });
        }
      }, this.toolCallTimeout);

      // Store callback for cleanup
      this.pendingCallbacks.set(id, { resolve, timeoutId });

      this.logger.debug('Sending MCP tool call request', {
        serverName,
        actualToolName,
        callId: id,
      });

      this.sendToServer(serverName, {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: actualToolName, arguments: args },
      });
    });
  }
}

// Agent-based MCP instances - each agent gets its own MCP instance
const mcpInstances = new Map<string, MCP>();

/**
 * Get or create an MCP instance for a specific agent.
 * Each agent has its own isolated MCP instance to prevent cross-contamination.
 * @param agent The agent to get the MCP instance for (required)
 * @returns The MCP instance for the agent
 */
export function getMCP(agent?: IAgent): MCP {
  if (!agent) {
    throw new Error('Agent is required to get MCP instance');
  }
  const agentId = agent.id;
  let instance = mcpInstances.get(agentId);
  if (!instance) {
    instance = new MCP(agent);
    mcpInstances.set(agentId, instance);
  }
  return instance;
}

/**
 * Reset the MCP instance for a specific agent - cleans up all resources
 * @param agentId The agent ID to reset MCP for. If not provided, resets all instances.
 */
export async function resetMCPInstance(agentId?: string): Promise<void> {
  if (agentId) {
    const instance = mcpInstances.get(agentId);
    if (instance) {
      await instance.cleanup();
      mcpInstances.delete(agentId);
    }
  } else {
    // Reset all instances
    for (const [id, instance] of mcpInstances.entries()) {
      await instance.cleanup();
      mcpInstances.delete(id);
    }
  }
}

/**
 * Cleanup MCP instance for a specific agent
 * @param agentId The agent ID to cleanup MCP for
 */
export async function cleanupMCPForAgent(agentId: string): Promise<void> {
  const mcp = mcpInstances.get(agentId);
  if (mcp) {
    // Wait for async cleanup to complete properly
    try {
      await mcp.cleanup?.();
    } catch {
      // Ignore cleanup errors during destruction
    }
    mcpInstances.delete(agentId);
  }
}

export * from './types';
