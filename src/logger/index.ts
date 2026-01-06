import pino from 'pino';
import { Logger as ILogger, LoggerConfig, LogLevel, LogData } from './types';

export class Logger implements ILogger {
  private pino: pino.Logger;
  public config: LoggerConfig;
  private transportWorker: pino.Logger | null = null;

  constructor(config: Partial<LoggerConfig> = {}) {
    const envLevel = process.env.LOG_LEVEL;
    const validLevels: LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent', 'success'];
    const isValidLogLevel = (level: string | undefined): level is LogLevel =>
      level !== undefined && validLevels.includes(level as LogLevel);

    this.config = {
      level: isValidLogLevel(envLevel) ? envLevel : 'info',
      debug: config.debug ?? false,
      enableConsole: true,
      enableFile: false,
      ...config,
    };

    // If LOG_LEVEL is 'silent', create a silent logger
    if (envLevel === 'silent') {
      this.pino = pino({ level: 'silent' });
      return;
    }

    // Create pino instance with pretty printing in development
    const isProduction = process.env.NODE_ENV === 'production';

    const pinoConfig: pino.LoggerOptions = {
      level: this.config.level === 'success' ? 'info' : this.config.level,
      formatters: {
        level: (label) => {
          return { level: label };
        },
      },
      base: {
        framework: 'Astreus',
      },
      timestamp: this.config.debug ? pino.stdTimeFunctions.isoTime : false,
    };

    // Pretty print in development, JSON in production
    if (!isProduction && this.config.enableConsole) {
      this.pino = pino({
        ...pinoConfig,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: false,
            ignore: this.config.debug
              ? 'pid,hostname,framework,level,time,module,agent,err'
              : 'pid,hostname,framework,level,time,module,agent,data,err',
            messageFormat:
              '\x1b[36mAstreus [\x1b[34m{agent}\x1b[36m] {module}\x1b[0m → \x1b[32m{msg}\x1b[0m',
            customColors: 'info:cyan,warn:yellow,error:red',
            hideObject: !this.config.debug,
            singleLine: false,
            messageKey: 'msg',
          },
        },
      });
      // Store reference to transport worker for cleanup
      this.transportWorker = this.pino;
    } else {
      this.pino = pino(pinoConfig);
    }
  }

  private formatLogObject(
    message: string,
    module: string = 'Core',
    data?: LogData,
    error?: Error,
    agentName?: string
  ): Record<string, LogData> {
    const logObject: Record<string, LogData> = {
      msg: message,
      module,
      framework: 'Astreus',
      agent: agentName ?? this.config.agentName ?? 'System',
    };

    if (data) {
      logObject.data = data;
    }

    if (error) {
      logObject.err = {
        message: error.message,
        stack: error.stack ?? null,
        name: error.name,
      };
    }

    return logObject;
  }

  debug(message: string, data?: LogData, agentName?: string): void {
    const logObj = this.formatLogObject(message, 'Core', data, undefined, agentName);
    this.pino.debug(logObj);
  }

  info(message: string, data?: LogData, agentName?: string): void {
    const logObj = this.formatLogObject(message, 'Core', data, undefined, agentName);
    this.pino.info(logObj);
  }

  warn(message: string, data?: LogData, agentName?: string): void {
    const logObj = this.formatLogObject(message, 'Core', data, undefined, agentName);
    this.pino.warn(logObj);
  }

  error(message: string, error?: Error, data?: LogData, agentName?: string): void {
    const logObj = this.formatLogObject(message, 'Core', data, error, agentName);
    this.pino.error(logObj);
  }

  success(message: string, data?: LogData, agentName?: string): void {
    // Pino doesn't have success level, use info with success marker
    const logObj = this.formatLogObject(message, 'Core', data, undefined, agentName);
    logObj.level = 'success';
    this.pino.info(logObj);
  }

  // Add a public log method for custom module names
  log(
    level: LogLevel,
    message: string,
    module: string = 'Core',
    data?: LogData,
    error?: Error,
    agentName?: string
  ): void {
    const logObj = this.formatLogObject(message, module, data, error, agentName);

    switch (level) {
      case 'debug':
        this.pino.debug(logObj);
        break;
      case 'info':
      case 'success':
        this.pino.info(logObj);
        break;
      case 'warn':
        this.pino.warn(logObj);
        break;
      case 'error':
        this.pino.error(logObj);
        break;
      case 'silent':
        // Silent level - do not log anything
        break;
      default: {
        // Exhaustive check - this ensures all LogLevel cases are handled
        const _exhaustiveCheck: never = level;
        throw new Error(`Unknown log level: ${_exhaustiveCheck}`);
      }
    }
  }

  setLevel(level: LogLevel): void {
    this.config.level = level;
    this.pino.level = level === 'success' ? 'info' : level;
  }

  setDebug(debug: boolean): void {
    // Skip if no change
    if (this.config.debug === debug) return;

    // Cleanup old transport worker before replacing
    this.cleanupTransportWorker();

    this.config.debug = debug;
    // Recreate pino instance with new debug setting
    const isProduction = process.env.NODE_ENV === 'production';

    const pinoConfig: pino.LoggerOptions = {
      level: this.config.level === 'success' ? 'info' : this.config.level,
      formatters: {
        level: (label) => {
          return { level: label };
        },
      },
      base: {
        framework: 'Astreus',
      },
      timestamp: debug ? pino.stdTimeFunctions.isoTime : false,
    };

    if (!isProduction && this.config.enableConsole) {
      this.pino = pino({
        ...pinoConfig,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: false,
            ignore: debug
              ? 'pid,hostname,framework,level,time,module,agent,err'
              : 'pid,hostname,framework,level,time,module,agent,data,err',
            messageFormat:
              '\x1b[36mAstreus [\x1b[34m{agent}\x1b[36m] {module}\x1b[0m → \x1b[32m{msg}\x1b[0m',
            customColors: 'info:cyan,warn:yellow,error:red',
            hideObject: !debug,
            singleLine: false,
            messageKey: 'msg',
          },
        },
      });
      // Store reference to transport worker for cleanup
      this.transportWorker = this.pino;
    } else {
      this.pino = pino(pinoConfig);
      this.transportWorker = null;
    }
  }

  /**
   * Cleanup the transport worker to prevent memory leaks
   */
  private cleanupTransportWorker(): void {
    if (this.transportWorker) {
      // Flush any pending logs
      if (this.transportWorker.flush) {
        this.transportWorker.flush();
      }
      // End the transport stream if available (pino with transport uses destination stream)
      // Access the internal stream property for cleanup
      const pinoStreamSymbol = Symbol.for('pino.stream');
      const transportInstance = this.transportWorker as unknown as Record<symbol, unknown>;
      const destination = transportInstance[pinoStreamSymbol] as { end?: () => void } | undefined;
      if (destination?.end) {
        destination.end();
      }
      this.transportWorker = null;
    }
  }

  /**
   * Flush any pending log entries and cleanup resources.
   * Call this before application shutdown.
   */
  async flush(): Promise<void> {
    return new Promise((resolve, reject) => {
      // pino.flush accepts a callback for async completion
      if (this.pino.flush) {
        this.pino.flush((err?: Error) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Dispose of the logger instance and cleanup resources.
   */
  dispose(): void {
    // Cleanup transport worker (includes flush)
    this.cleanupTransportWorker();

    // Flush any pending logs synchronously if possible
    if (this.pino.flush) {
      this.pino.flush();
    }
  }
}

// Global logger instance
// WARNING: This global logger is NOT thread-safe for concurrent initialization.
// In multi-threaded environments (e.g., worker threads), each thread should create
// its own Logger instance or synchronize access to the global logger.
// For agent-specific logging, prefer creating agent-scoped Logger instances.
let globalLogger: Logger | null = null;

// Proper async mutex implementation for thread-safe logger initialization
class AsyncMutex {
  private locked = false;
  private queue: (() => void)[] = [];

  async acquire(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    } else {
      this.locked = false;
    }
  }
}

const loggerMutex = new AsyncMutex();

// Synchronous getLogger - uses double-check locking pattern
export function getLogger(config?: Partial<LoggerConfig>): Logger {
  // Fast path - already initialized (atomic read)
  if (globalLogger) return globalLogger;

  // For synchronous contexts, create immediately if not exists
  // This is safe because Logger construction is synchronous
  if (!globalLogger) {
    globalLogger = new Logger({ agentName: 'System', ...config });
  }
  return globalLogger;
}

// Async version for proper mutex-protected initialization
export async function getLoggerAsync(config?: Partial<LoggerConfig>): Promise<Logger> {
  // Fast path - already initialized
  if (globalLogger) return globalLogger;

  await loggerMutex.acquire();
  try {
    // Double-check after acquiring lock
    if (!globalLogger) {
      globalLogger = new Logger({ agentName: 'System', ...config });
    }
    return globalLogger;
  } finally {
    loggerMutex.release();
  }
}

export async function initializeLogger(config: Partial<LoggerConfig>): Promise<Logger> {
  await loggerMutex.acquire();
  try {
    // Dispose of existing logger before creating new one to prevent memory leaks
    if (globalLogger) {
      globalLogger.dispose();
    }
    globalLogger = new Logger(config);
    return globalLogger;
  } finally {
    loggerMutex.release();
  }
}

// Synchronous initialization
export function initializeLoggerSync(config: Partial<LoggerConfig>): Logger {
  // Dispose of existing logger before creating new one to prevent memory leaks
  if (globalLogger) {
    globalLogger.dispose();
  }
  globalLogger = new Logger(config);
  return globalLogger;
}

/**
 * Cleanup the global logger instance.
 * Call this during application shutdown to ensure proper resource cleanup.
 */
export async function shutdownLogger(): Promise<void> {
  // Capture reference and null first to prevent race conditions
  const logger = globalLogger;
  globalLogger = null;

  if (logger) {
    await logger.flush();
    logger.dispose();
  }
}

/**
 * Reset the global logger instance (useful for testing).
 */
export function resetLogger(): void {
  if (globalLogger) {
    globalLogger.dispose();
    globalLogger = null;
  }
}

export * from './types';
