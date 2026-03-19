import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../lib/logger';

describe('logger.ts', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Reset env vars
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_FORMAT;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('createLogger', () => {
    it('should create a logger with debug, info, warn, error methods', () => {
      const logger = createLogger('test');

      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
    });

    it('should log message with correct format', () => {
      const logger = createLogger('test');
      logger.info('Hello', 'World');

      expect(consoleSpy).toHaveBeenCalled();
      const logOutput = consoleSpy.mock.calls[0][0];
      expect(logOutput).toContain('[test]');
      expect(logOutput).toContain('Hello');
      expect(logOutput).toContain('World');
    });

    it('should include timestamp in log output', () => {
      const logger = createLogger('test');
      logger.info('Test message');

      expect(consoleSpy).toHaveBeenCalled();
      const logOutput = consoleSpy.mock.calls[0][0];
      // ISO timestamp format: YYYY-MM-DDTHH:mm:ss.sssZ
      expect(logOutput).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('log level filtering', () => {
    beforeEach(() => {
      consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it('should not log debug when LOG_LEVEL is info', () => {
      process.env.LOG_LEVEL = 'info';
      const logger = createLogger('test');
      logger.debug('This should not appear');

      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('should log info when LOG_LEVEL is info', () => {
      process.env.LOG_LEVEL = 'info';
      const logger = createLogger('test');
      logger.info('This should appear');

      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should log warn when LOG_LEVEL is warn', () => {
      process.env.LOG_LEVEL = 'warn';
      const logger = createLogger('test');
      logger.warn('Warning message');

      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should not log info when LOG_LEVEL is warn', () => {
      process.env.LOG_LEVEL = 'warn';
      const logger = createLogger('test');
      logger.info('This should not appear');

      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('should log error when LOG_LEVEL is error', () => {
      process.env.LOG_LEVEL = 'error';
      const logger = createLogger('test');
      logger.error('Error message');

      expect(consoleSpy).toHaveBeenCalled();
    });

    it('should default to info when LOG_LEVEL is invalid', () => {
      process.env.LOG_LEVEL = 'invalid_level';
      const logger = createLogger('test');

      logger.debug('Debug'); // should be filtered
      logger.info('Info'); // should appear

      expect(consoleSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('JSON format', () => {
    beforeEach(() => {
      consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it('should output JSON when LOG_FORMAT is json', () => {
      process.env.LOG_FORMAT = 'json';
      const logger = createLogger('test');
      logger.info('Test message');

      expect(consoleSpy).toHaveBeenCalled();
      const logOutput = consoleSpy.mock.calls[0][0];
      const parsed = JSON.parse(logOutput);

      expect(parsed).toHaveProperty('timestamp');
      expect(parsed).toHaveProperty('level');
      expect(parsed).toHaveProperty('tag');
      expect(parsed).toHaveProperty('message');
      expect(parsed.level).toBe('INFO');
      expect(parsed.tag).toBe('test');
    });

    it('should output human-readable format by default', () => {
      process.env.LOG_FORMAT = '';
      const logger = createLogger('test');
      logger.info('Test message');

      expect(consoleSpy).toHaveBeenCalled();
      const logOutput = consoleSpy.mock.calls[0][0];
      // Should not be valid JSON
      expect(() => JSON.parse(logOutput)).toThrow();
      // Should contain expected format elements
      expect(logOutput).toContain('[INFO]');
      expect(logOutput).toContain('[test]');
    });
  });

  describe('error handling', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('should log Error object with message', () => {
      const logger = createLogger('test');
      const error = new Error('Test error');
      logger.error(error);

      expect(errorSpy).toHaveBeenCalled();
      const logOutput = errorSpy.mock.calls[0][0];
      expect(logOutput).toContain('Test error');
    });

    it('should log string arguments', () => {
      const logger = createLogger('test');
      logger.info('String 1', 'String 2');

      expect(consoleSpy).toHaveBeenCalled();
      const logOutput = consoleSpy.mock.calls[0][0];
      expect(logOutput).toContain('String 1');
      expect(logOutput).toContain('String 2');
    });

    it('should log object arguments as JSON', () => {
      const logger = createLogger('test');
      logger.info({ key: 'value', num: 123 });

      expect(consoleSpy).toHaveBeenCalled();
      const logOutput = consoleSpy.mock.calls[0][0];
      expect(logOutput).toContain('key');
      expect(logOutput).toContain('value');
    });
  });
});