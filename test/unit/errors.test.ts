import { describe, it, expect } from 'vitest';
import {
  ExecutionError,
  TimeoutError,
  RuntimeError,
  SyntaxError,
  SecurityError,
  ConnectionError,
  ToolNotFoundError,
  ServerNotFoundError,
} from '../../src/utils/errors.js';

describe('errors', () => {
  describe('ExecutionError', () => {
    it('should create error with type and message', () => {
      const error = new ExecutionError('runtime', 'Test error');
      expect(error.message).toBe('Test error');
      expect(error.name).toBe('ExecutionError');
      expect(error.type).toBe('runtime');
      expect(error instanceof Error).toBe(true);
    });

    it('should include line number if provided', () => {
      const error = new ExecutionError('syntax', 'Error', { line: 10 });
      expect(error.line).toBe(10);
    });

    it('should serialize to JSON', () => {
      const error = new ExecutionError('runtime', 'Test error', { line: 5 });
      const json = error.toJSON();
      expect(json.type).toBe('runtime');
      expect(json.message).toBe('Test error');
      expect(json.line).toBe(5);
    });
  });

  describe('SyntaxError', () => {
    it('should create syntax error with line number', () => {
      const error = new SyntaxError('Unexpected token', 10);
      expect(error.message).toBe('Unexpected token');
      expect(error.name).toBe('SyntaxError');
      expect(error.type).toBe('syntax');
      expect(error.line).toBe(10);
    });

    it('should handle missing line number', () => {
      const error = new SyntaxError('Syntax error');
      expect(error.line).toBeUndefined();
    });
  });

  describe('RuntimeError', () => {
    it('should create runtime error with message', () => {
      const error = new RuntimeError('Undefined variable');
      expect(error.message).toBe('Undefined variable');
      expect(error.name).toBe('RuntimeError');
      expect(error.type).toBe('runtime');
    });

    it('should include stack trace if provided', () => {
      const error = new RuntimeError('Error', 'at line 10\nat line 20');
      expect(error.stack).toContain('at line 10');
    });
  });

  describe('TimeoutError', () => {
    it('should create timeout error with duration', () => {
      const error = new TimeoutError(30000);
      expect(error.message).toContain('30000');
      expect(error.name).toBe('TimeoutError');
      expect(error.type).toBe('timeout');
    });
  });

  describe('SecurityError', () => {
    it('should create security error', () => {
      const error = new SecurityError('Access denied');
      expect(error.message).toBe('Access denied');
      expect(error.name).toBe('SecurityError');
      expect(error.type).toBe('security');
    });
  });

  describe('ConnectionError', () => {
    it('should create connection error with server name', () => {
      const error = new ConnectionError('myserver', 'Connection refused');
      expect(error.message).toContain('myserver');
      expect(error.message).toContain('Connection refused');
      expect(error.name).toBe('ConnectionError');
      expect(error.type).toBe('connection');
    });
  });

  describe('ToolNotFoundError', () => {
    it('should create tool not found error', () => {
      const error = new ToolNotFoundError('myserver', 'mytool');
      expect(error.message).toContain('mytool');
      expect(error.message).toContain('myserver');
      expect(error.name).toBe('ToolNotFoundError');
      expect(error.type).toBe('tool_not_found');
    });
  });

  describe('ServerNotFoundError', () => {
    it('should create server not found error', () => {
      const error = new ServerNotFoundError('myserver');
      expect(error.message).toContain('myserver');
      expect(error.name).toBe('ServerNotFoundError');
      expect(error.type).toBe('server_not_found');
    });
  });
});
