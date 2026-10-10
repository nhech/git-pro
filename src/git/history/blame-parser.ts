import { validateOid } from '../../security/refs';
import { decode } from './history-parser';
export interface BlameLine { oid: string; originalLine: number; line: number; author: string; timestamp: number; summary: string; content: string; uncommitted: boolean }
export function parseBlame(buffer: Buffer): BlameLine {
  const lines = decode(buffer).split('\n'); const header = lines.shift()?.match(/^([a-f0-9]{40}|[a-f0-9]{64}) (\d+) (\d+)(?: \d+)?$/i);
  if (!header) throw new Error('Invalid blame header.');
  const fields = new Map<string, string>(); let content: string | undefined;
  for (const line of lines) {
    if (line.startsWith('\t')) { content = line.slice(1); break; }
    const separator = line.indexOf(' '); if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const timestamp = Number(fields.get('author-time'));
  if (content === undefined || !fields.has('author') || !Number.isSafeInteger(timestamp)) throw new Error('Truncated blame metadata.');
  return { oid: validateOid(header[1]!), originalLine: Number(header[2]), line: Number(header[3]), author: fields.get('author')!, timestamp, summary: fields.get('summary') ?? '', content, uncommitted: /^0+$/.test(header[1]!) };
}
