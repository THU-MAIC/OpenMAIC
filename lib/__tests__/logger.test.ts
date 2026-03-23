import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLogger } from '../logger';

describe('createLogger', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Default to info level, text format
    vi.stubEnv('LOG_LEVEL', 'info');
    vi.stubEnv('LOG_FORMAT', 'text');
  });

  it('creates a logger with all level methods', () => {
    const logger = createLogger('test');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('outputs info messages at info level', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger('MyTag');
    logger.info('hello', 'world');
    expect(spy).toHaveBeenCalledOnce();
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain('[INFO]');
    expect(output).toContain('[MyTag]');
    expect(output).toContain('hello world');
  });

  it('filters out debug messages at info level', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const logger = createLogger('test');
    logger.debug('should not appear');
    expect(spy).not.toHaveBeenCalled();
  });

  it('outputs debug messages when LOG_LEVEL=debug', () => {
    vi.stubEnv('LOG_LEVEL', 'debug');
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const logger = createLogger('test');
    logger.debug('visible');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('routes warn to console.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger('test');
    logger.warn('warning!');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0] as string).toContain('[WARN]');
  });

  it('routes error to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger('test');
    logger.error('fail');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0] as string).toContain('[ERROR]');
  });

  it('formats Error objects using stack trace', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createLogger('test');
    const err = new Error('boom');
    logger.error(err);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0] as string).toContain('boom');
  });

  it('outputs JSON when LOG_FORMAT=json', () => {
    vi.stubEnv('LOG_FORMAT', 'json');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger('svc');
    logger.info('hello');
    expect(spy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({
      level: 'INFO',
      tag: 'svc',
      message: 'hello',
    });
    expect(parsed.timestamp).toBeDefined();
  });

  it('serializes objects as JSON in messages', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger('test');
    logger.info({ key: 'value' });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0] as string).toContain('{"key":"value"}');
  });

  it('only outputs warn and error at warn level', () => {
    vi.stubEnv('LOG_LEVEL', 'warn');
    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger('test');
    logger.info('hidden');
    logger.warn('visible');
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});
