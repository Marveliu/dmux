import { describe, expect, it } from 'vitest';
import { formatPRSummary, parsePRSummary } from '../src/utils/prSummary.js';

describe('prSummary formatting', () => {
  it('formats title-only summaries without a trailing blank', () => {
    expect(formatPRSummary({ title: 'feat: add X', body: '' })).toBe('feat: add X');
  });

  it('separates title and body with a blank line', () => {
    const out = formatPRSummary({ title: 'fix: bug', body: '## Summary\n- thing' });
    expect(out).toBe('fix: bug\n\n## Summary\n- thing');
  });

  it('parses a simple title-only input', () => {
    expect(parsePRSummary('feat: add X')).toEqual({ title: 'feat: add X', body: '' });
  });

  it('splits title from multi-line body at the first newline', () => {
    const parsed = parsePRSummary('feat: add X\n\n## Summary\n- thing\n');
    expect(parsed.title).toBe('feat: add X');
    expect(parsed.body).toBe('## Summary\n- thing');
  });

  it('round-trips format -> parse', () => {
    const original = { title: 'chore: cleanup', body: 'removed dead code' };
    expect(parsePRSummary(formatPRSummary(original))).toEqual(original);
  });

  it('handles CRLF input and leading blank lines in body', () => {
    const parsed = parsePRSummary('feat: thing\r\n\r\n\r\nbody line\r\n');
    expect(parsed.title).toBe('feat: thing');
    expect(parsed.body).toBe('body line');
  });

  it('returns empty title and body for whitespace-only input', () => {
    expect(parsePRSummary('   \n\n  ')).toEqual({ title: '', body: '' });
  });
});
