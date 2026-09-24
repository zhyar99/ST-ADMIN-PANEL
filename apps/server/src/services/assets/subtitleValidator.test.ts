import { describe, expect, it } from 'vitest';

import { subtitleProblem } from './subtitleValidator';

const srt = (...timings: string[]) =>
  timings.map((t, i) => `${i + 1}\r\n${t}\r\nline ${i + 1}\r\n`).join('\r\n');

describe('subtitle upload validation', () => {
  it('accepts a complete SRT and VTT', () => {
    expect(subtitleProblem(srt('00:00:01,000 --> 00:00:03,000', '00:04:00,000 --> 00:04:02,000'))).toBeNull();
    expect(subtitleProblem('WEBVTT\n\n00:01.000 --> 00:03.000 align:start\nhi\n')).toBeNull();
  });

  it('rejects a file with an 11-minute hole and says where it is', () => {
    const problem = subtitleProblem(
      srt('00:49:58,000 --> 00:50:01,001', '01:01:15,001 --> 01:01:17,000'),
    );
    expect(problem).toContain('0:50:01');
    expect(problem).toContain('1:01:15');
  });

  it('rejects a file with no cues', () => {
    expect(subtitleProblem('not a subtitle')).toBe('the file contains no subtitle cues');
  });
});
