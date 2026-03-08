/**
 * Test Server Manager
 *
 * Manages the lifecycle of test MCP server processes for integration testing.
 * Handles spawning, health checking, and cleanup of test servers.
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';

export interface ServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ServerState {
  name: string;
  process: ChildProcess | null;
  config: ServerConfig;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
  startedAt?: Date;
  stoppedAt?: Date;
  lastError?: string;
  pid?: number;
}

/**
 * Manages test MCP server processes
 */
export class TestServerManager extends EventEmitter {
  private servers: Map<string, ServerState> = new Map();
  private projectRoot: string;

  constructor(projectRoot?: string) {
    super();
    this.projectRoot =
      projectRoot || path.resolve(new URL('.', import.meta.url).pathname, '../..');
  }

  /**
   * Start a test server process
   */
  async startServer(name: string, config: ServerConfig): Promise<void> {
    // Check if already running
    const existing = this.servers.get(name);
    if (existing && existing.status === 'running') {
      throw new Error(`Server ${name} is already running`);
    }

    const state: ServerState = {
      name,
      process: null,
      config,
      status: 'starting',
    };
    this.servers.set(name, state);

    try {
      const proc = spawn(config.command, config.args || [], {
        cwd: config.cwd || this.projectRoot,
        env: { ...process.env, ...config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      state.process = proc;
      state.pid = proc.pid;

      // Handle stdout (MCP protocol messages)
      proc.stdout?.on('data', (data) => {
        this.emit('stdout', { name, data: data.toString() });
      });

      // Handle stderr (logs)
      proc.stderr?.on('data', (data) => {
        const message = data.toString();
        this.emit('stderr', { name, data: message });

        // Check for startup message
        if (message.includes('Server started') || message.includes('started')) {
          state.status = 'running';
          state.startedAt = new Date();
          this.emit('serverStarted', { name, pid: proc.pid });
        }
      });

      // Handle process exit
      proc.on('exit', (code, signal) => {
        state.status = 'stopped';
        state.stoppedAt = new Date();
        state.process = null;
        this.emit('serverStopped', { name, code, signal });
      });

      // Handle process error
      proc.on('error', (error) => {
        state.status = 'error';
        state.lastError = error.message;
        this.emit('serverError', { name, error });
      });

      // Wait a short time for the process to start
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check if process is still alive
      if (proc.exitCode !== null) {
        throw new Error(`Server ${name} exited immediately with code ${proc.exitCode}`);
      }

      state.status = 'running';
      state.startedAt = new Date();
    } catch (error) {
      state.status = 'error';
      state.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /**
   * Stop a specific server
   */
  async stopServer(name: string): Promise<void> {
    const state = this.servers.get(name);
    if (!state) {
      return; // Already not running
    }

    if (state.process && state.status === 'running') {
      state.status = 'stopping';

      // Send SIGTERM first
      state.process.kill('SIGTERM');

      // Wait for graceful shutdown
      const waitForExit = new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          // Force kill if still running
          if (state.process && state.status === 'stopping') {
            state.process.kill('SIGKILL');
          }
          resolve();
        }, 5000);

        state.process?.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      await waitForExit;
    }

    state.status = 'stopped';
    state.stoppedAt = new Date();
  }

  /**
   * Stop all managed servers
   */
  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.servers.keys()).map((name) => this.stopServer(name));
    await Promise.all(stopPromises);
  }

  /**
   * Check if a server is running
   */
  isRunning(name: string): boolean {
    const state = this.servers.get(name);
    return state?.status === 'running';
  }

  /**
   * Get server state
   */
  getServerState(name: string): ServerState | undefined {
    return this.servers.get(name);
  }

  /**
   * Wait for server to be ready (accepting connections)
   */
  async waitForReady(name: string, timeoutMs: number = 10000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const state = this.servers.get(name);

      if (!state) {
        return false;
      }

      if (state.status === 'running') {
        return true;
      }

      if (state.status === 'error' || state.status === 'stopped') {
        return false;
      }

      // Wait a bit before checking again
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return false;
  }

  /**
   * Get list of all managed servers
   */
  listServers(): ServerState[] {
    return Array.from(this.servers.values());
  }

  /**
   * Get path to test-echo server
   */
  getTestEchoServerPath(): string {
    return path.join(this.projectRoot, 'test/real-servers/test-echo-server/index.ts');
  }

  /**
   * Get path to test config file
   */
  getTestConfigPath(name: 'minimal' | 'with-sequential' | 'full-suite' = 'minimal'): string {
    return path.join(this.projectRoot, `test/real-servers/test-configs/${name}.json`);
  }

  /**
   * Start the test-echo server with default configuration
   */
  async startTestEchoServer(): Promise<void> {
    await this.startServer('test-echo', {
      command: 'npx',
      args: ['tsx', this.getTestEchoServerPath()],
      cwd: this.projectRoot,
    });
  }
}

/**
 * Create a server manager instance with the test-echo server pre-configured
 */
export function createTestServerManager(): TestServerManager {
  return new TestServerManager();
}

/**
 * Helper to run tests with a managed test server
 */
export async function withTestServer<T>(
  fn: (manager: TestServerManager) => Promise<T>
): Promise<T> {
  const manager = createTestServerManager();

  try {
    await manager.startTestEchoServer();
    await manager.waitForReady('test-echo', 10000);
    return await fn(manager);
  } finally {
    await manager.stopAll();
  }
}
