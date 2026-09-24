import fs from 'node:fs/promises';

import { HttpError } from '../../middleware/errorHandler';
import { discardUpload } from './imageValidator';
import type { AssetKind } from './policy';

// ponytail: fixed 5-minute ceiling. A real film with a longer wordless stretch would be
// rejected; add an admin "upload anyway" override if one ever turns up.
export const MAX_SUBTITLE_GAP_MS = 5 * 60 * 1000;

const CUE_TIMING =
  /((?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3})[ \t]*-->[ \t]*((?:\d+:)?\d{1,2}:\d{2}[,.]\d{1,3})/g;

function toMs(stamp: string): number {
  const parts = stamp.replace(',', '.').split(':').map(Number);
  const seconds = parts.pop()!;
  const minutes = parts.pop()!;
  const hours = parts.pop() ?? 0;
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

export function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/** Returns why an SRT/VTT body is unusable, or null when it is fine. */
export function subtitleProblem(body: string): string | null {
  const cues = [...body.matchAll(CUE_TIMING)]
    .map((match) => ({ start: toMs(match[1]!), end: toMs(match[2]!) }))
    .sort((a, b) => a.start - b.start);

  if (cues.length === 0) return 'the file contains no subtitle cues';

  let coveredUntil = cues[0]!.end;
  for (const cue of cues.slice(1)) {
    if (cue.start - coveredUntil > MAX_SUBTITLE_GAP_MS) {
      return (
        `no subtitle lines between ${formatClock(coveredUntil)} and ${formatClock(cue.start)}. ` +
        'The file looks incomplete'
      );
    }
    coveredUntil = Math.max(coveredUntil, cue.end);
  }
  return null;
}

/** Rejects (and deletes) an uploaded subtitle file with no cues or a long hole in it. */
export async function validateSubtitle(absolutePath: string, kind: AssetKind): Promise<void> {
  if (kind !== 'SUBTITLE') return;
  const problem = subtitleProblem(await fs.readFile(absolutePath, 'utf8'));
  if (!problem) return;
  await discardUpload(absolutePath);
  throw new HttpError(400, 'INVALID_SUBTITLE', `Invalid subtitle file: ${problem}`);
}
