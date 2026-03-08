import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger, type LogLevel } from '../../src/utils/logger.js';

describe('logger', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let originalLevel: LogLevel;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    originalLevel = logger.getLevel();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    logger.setLevel(originalLevel);
  });

  describe('setLevel/getLevel', () => {
    it('should get and set log level', () => {
      logger.setLevel('debug');
      expect(logger.getLevel()).toBe('debug');

      logger.setLevel('error');
      expect(logger.getLevel()).toBe('error');
    });
  });

  describe('logger methods', () => {
    it('should have debug method', () => {
      expect(typeof logger.debug).toBe('function');
    });

    it('should have info method', () => {
      expect(typeof logger.info).toBe('function');
    });

    it('should have warn method', () => {
      expect(typeof logger.warn).toBe('function');
    });

    it('should have error method', () => {
      expect(typeof logger.error).toBe('function');
    });
  });

  describe('log level filtering', () => {
    it('should log error messages at error level', () => {
      logger.setLevel('error');
      logger.error('Test error message');
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should not log debug messages at error level', () => {
      logger.setLevel('error');
      logger.debug('Debug message');
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('should log all messages at debug level', () => {
      logger.setLevel('debug');

      logger.debug('Debug');
      logger.info('Info');
      logger.warn('Warn');
      logger.error('Error');

      expect(consoleSpy).toHaveBeenCalledTimes(4);
    });

    it('should log warn and error at warn level', () => {
      logger.setLevel('warn');

      logger.debug('Debug');
      logger.info('Info');
      expect(consoleSpy).not.toHaveBeenCalled();

      logger.warn('Warn');
      logger.error('Error');
      expect(consoleSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('log message format', () => {
    it('should include timestamp in log messages', () => {
      logger.setLevel('error');
      logger.error('Test message');

      const loggedMessage = consoleSpy.mock.calls[0][0] as string;
      expect(loggedMessage).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
    });

    it('should include log level in messages', () => {
      logger.setLevel('error');
      logger.error('Test message');

      const loggedMessage = consoleSpy.mock.calls[0][0] as string;
      expect(loggedMessage).toContain('[ERROR]');
    });

    it('should include meta data when provided', () => {
      logger.setLevel('error');
      logger.error('Test message', { key: 'value', count: 42 });

      const loggedMessage = consoleSpy.mock.calls[0][0] as string;
      expect(loggedMessage).toContain('key');
      expect(loggedMessage).toContain('value');
      expect(loggedMessage).toContain('42');
    });
  });
});
