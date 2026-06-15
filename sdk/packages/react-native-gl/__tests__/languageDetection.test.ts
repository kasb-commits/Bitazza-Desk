/**
 * Tests for GL-specific language detection logic.
 * No React Native runtime needed — pure TS functions.
 */
import { detectLanguage } from '../src/languageDetection';

const SUPPORTED = ['en', 'zh', 'ms', 'vi', 'id'];

describe('detectLanguage', () => {
  test('detects Thai script', () => {
    expect(detectLanguage('สวัสดี', 'en', SUPPORTED)).toBe('en'); // Thai not in GL list → clamp to en
  });

  test('detects Chinese script', () => {
    expect(detectLanguage('你好', 'en', SUPPORTED)).toBe('zh');
  });

  test('falls back to device locale for vi', () => {
    expect(detectLanguage('Hello world', 'vi-VN', SUPPORTED)).toBe('vi');
  });

  test('falls back to device locale for id', () => {
    expect(detectLanguage('Hello', 'id-ID', SUPPORTED)).toBe('id');
  });

  test('falls back to device locale for ms', () => {
    expect(detectLanguage('Hello', 'ms-MY', SUPPORTED)).toBe('ms');
  });

  test('returns en as final fallback', () => {
    expect(detectLanguage('Hello world', 'unknown-XX', SUPPORTED)).toBe('en');
  });

  test('clamps unsupported locale to en', () => {
    expect(detectLanguage('', 'fr-FR', ['en', 'zh'])).toBe('en');
  });

  test('empty text + no locale → en', () => {
    expect(detectLanguage('', '', SUPPORTED)).toBe('en');
  });
});
