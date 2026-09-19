import { describe, it, expect } from 'vitest';
import { redactSecrets, normalizeError, extractSignals, generateSignature } from './analyze';

describe('redactSecrets', () => {
  it('redacts emails', () => {
    expect(redactSecrets('User test@example.com logged in')).toBe('User <REDACTED> logged in');
  });

  it('redacts AWS keys', () => {
    expect(redactSecrets('Key: AKIAIOSFODNN7EXAMPLE')).toBe('Key: <REDACTED>');
  });
  
  it('redacts JWTs', () => {
    expect(redactSecrets('Token: eyJhbGci.eyJzdWIi.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')).toBe('Token: <REDACTED>');
  });
});

describe('normalizeError', () => {
  it('replaces line numbers and paths', () => {
    const raw = 'Error at /usr/src/app/index.js:42:15';
    expect(normalizeError(raw)).toBe('Error at <PATH>:<N>:<N>');
  });

  it('collapses repeated lines', () => {
    const raw = 'Error!\nRetry failed\nRetry failed\nRetry failed\nDone';
    expect(normalizeError(raw)).toBe('Error!\nRetry failed\n... x 3\nDone');
  });
});

describe('extractSignals', () => {
  it('extracts known service names', () => {
    const raw = 'Failure in checkout-service caused ETIMEDOUT';
    const signals = extractSignals(raw);
    expect(signals.service).toBe('checkout-service');
    expect(signals.errorType).toBe('ETIMEDOUT');
  });
});

describe('generateSignature', () => {
  it('generates a stable signature', async () => {
    const sig1 = await generateSignature('ETIMEDOUT', 'checkout-service', 'Error\nFrame1\nFrame2');
    const sig2 = await generateSignature('ETIMEDOUT', 'checkout-service', 'Error\nFrame1\nFrame2');
    expect(sig1).toBe(sig2);
    expect(sig1).toHaveLength(40);
  });
});
