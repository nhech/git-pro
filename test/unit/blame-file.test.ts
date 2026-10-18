import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageBucket, ageBuckets, blockAt, escapeMarkdown, gutterText, gutterWidth, parseBlameFile, plainText } from '../../src/git/history/blame-file';
import { describeAge, shortAge } from '../../src/utils/age';
import { buildReadCommand } from '../../src/git/command-builders';

const a = 'a'.repeat(40), b = 'b'.repeat(40), none = '0'.repeat(40);
const meta = (author: string, time: number, summary: string, extra = '') => `author ${author}\nauthor-mail <${author.toLowerCase()}@example.test>\nauthor-time ${time}\nauthor-tz +0000\ncommitter ${author}\ncommitter-mail <c@example.test>\ncommitter-time ${time}\ncommitter-tz +0000\nsummary ${summary}\n${extra}filename f.txt\n`;
/** What `git blame --porcelain` prints for five lines: a, a, b, a again (its details are not repeated), and one that is not committed. */
const porcelain = [
  `${a} 1 1 2\n${meta('Alice', 1_700_000_000, 'First')}\tline1\n${a} 2 2\n\tline2\n`,
  `${b} 1 3 1\n${meta('Bob', 1_700_100_000, 'Second', `previous ${a} f.txt\n`)}\tline3\n`,
  `${a} 3 4 1\n\tline4\n`,
  `${none} 4 5 1\n${meta('Not Committed Yet', 1_700_200_000, 'Version of f.txt from f.txt')}\tline5\n`,
].join('');

test('the porcelain blame of a file becomes blocks of consecutive lines, with a commit\'s details read from its first appearance', () => {
  const file = parseBlameFile(Buffer.from(porcelain));
  assert.equal(file.lines, 5);
  assert.deepEqual(file.blocks.map(block => [block.start, block.length, block.commit.oid, block.commit.author, block.commit.summary, block.commit.timestamp, block.commit.uncommitted]), [
    [0, 2, a, 'Alice', 'First', 1_700_000_000, false], [2, 1, b, 'Bob', 'Second', 1_700_100_000, false], [3, 1, a, 'Alice', 'First', 1_700_000_000, false], [4, 1, none, 'Not Committed Yet', 'Version of f.txt from f.txt', 1_700_200_000, true]]);
  assert.equal(file.blocks[0]!.commit, file.blocks[2]!.commit, 'one commit, one record');
  assert.ok(Object.isFrozen(file) && Object.isFrozen(file.blocks[0]));
  assert.deepEqual(parseBlameFile(Buffer.from('')).blocks, []);
});

test('output that is not a whole blame is refused, and a file past the bound is said to be too long', () => {
  assert.throws(() => parseBlameFile(Buffer.from('\tcontent without a header\n')), /Invalid blame output/);
  assert.throws(() => parseBlameFile(Buffer.from(`${a} 1 1 1\n${meta('Alice', 1, 'x')}\tline\n${a} 2 3 1\n\tline\n`)), /Incomplete blame output/, 'a line with no owner');
  assert.throws(() => parseBlameFile(Buffer.from(`${a} 1 1 1\nauthor Alice\n\tline\n`)), /Truncated blame metadata/, 'no author-time');
  assert.throws(() => parseBlameFile(Buffer.from(`${a} 1 1 1\nauthor-time 5\n\tline\n`)), /Truncated blame metadata/, 'no author');
  assert.throws(() => parseBlameFile(Buffer.from(`${a} 1 1 1\nauthor Alice\nauthor-time soon\n\tline\n`)), /Truncated blame metadata/);
  for (const bad of [`${a} 1 0 1`, `${a} 1 -1 1`, `${a} 1 1.5 1`]) assert.throws(() => parseBlameFile(Buffer.from(`${bad}\n${meta('Alice', 1, 'x')}\tline\n`)), /too many lines|Invalid blame output/, bad);
  assert.throws(() => parseBlameFile(Buffer.from(`${a} 1 4 1\n${meta('Alice', 1, 'x')}\tline\n`), 3), /too many lines to blame/);
  assert.equal(parseBlameFile(Buffer.from(`${a} 1 3 1\n${meta('Alice', 1, 'x')}\tline\n${a} 2 1 1\n\tl\n${a} 3 2 1\n\tl\n`), 3).lines, 3, 'lines in any order, as long as all are there');
});

test('what a repository calls itself is shortened and cleaned before it reaches the screen', () => {
  const evil = `Mal\u202elory\u0007 ${'x'.repeat(300)}\tand more`;
  const file = parseBlameFile(Buffer.from(`${a} 1 1 1\n${meta(evil, 1, `subject\u2066hidden\u2069\t${'y'.repeat(2000)}`)}\tline\n`));
  const commit = file.blocks[0]!.commit;
  assert.ok(commit.author.length <= 200 && commit.author.startsWith('Mal lory') && commit.author.endsWith('…'), commit.author); assert.doesNotMatch(commit.author + commit.summary, /[\u202e\u0007\u2066\u2069\t\n]/);
  assert.ok(commit.summary.length <= 1000 && commit.summary.startsWith('subject hidden y'));
  assert.equal(plainText('  a \t b\n c  ', 20), 'a b c'); assert.equal(plainText('日本語のテキスト', 4), '日本語…', 'cut by characters, not code units'); assert.equal(plainText('😀😀😀😀', 3), '😀😀…'); assert.equal(plainText('abc', 3), 'abc'); assert.equal(plainText('', 5), '');
});

test('a change is placed in one of eight steps of age, and the gutter shows hash, author and age at a fixed width', () => {
  const now = 1_800_000_000_000, day = 86_400;
  assert.deepEqual([0, 1, 2, 7, 30, 31, 90, 180, 365, 366, 730, 731, 5000].map(days => ageBucket(now / 1000 - days * day, now)), [0, 0, 1, 1, 2, 3, 3, 4, 5, 6, 6, 7, 7]);
  assert.equal(ageBucket(now / 1000 + 1000, now), 0, 'a commit dated in the future is as new as it gets'); assert.equal(ageBuckets, 8);
  const block = parseBlameFile(Buffer.from(porcelain)).blocks[0]!, text = gutterText(block, (1_700_000_000 + 3 * 86_400) * 1000, true);
  assert.equal(Array.from(text).length, gutterWidth); assert.equal(text.replace(/\u00a0/g, ' ').trimEnd(), 'aaaaaaa Alice 3d'); assert.doesNotMatch(text, / /, 'no plain blanks that could collapse');
  assert.equal(gutterText(block, 1_700_000_000_000, false), '\u00a0'.repeat(gutterWidth), 'the lines after the first only carry the tint');
  const uncommitted = parseBlameFile(Buffer.from(porcelain)).blocks[3]!; assert.equal(gutterText(uncommitted, 1_700_300_000_000, true).replace(/\u00a0/g, ' ').trimEnd(), 'Not committed yet');
  const long = parseBlameFile(Buffer.from(`${a} 1 1 1\n${meta('A very long author name indeed', 1_700_000_000, 'x')}\tl\n`)).blocks[0]!;
  assert.equal(Array.from(gutterText(long, 1_700_000_000_000, true)).length, gutterWidth); assert.match(gutterText(long, 1_700_000_000_000, true).replace(/\u00a0/g, ' '), /^aaaaaaa A very long a… now/);
  assert.equal(shortAge(1000, 1000), 'now'); assert.equal(shortAge(0, 59_000), 'now'); assert.equal(shortAge(0, 5 * 60_000), '5m'); assert.equal(shortAge(0, 3 * 3600_000), '3h'); assert.equal(shortAge(0, 12 * 86_400_000), '12d');
  assert.equal(shortAge(0, 29 * 86_400_000), '29d'); assert.equal(shortAge(0, 30 * 86_400_000), '1mo'); assert.equal(shortAge(0, 364 * 86_400_000), '12mo'); assert.equal(shortAge(0, 365 * 86_400_000), '1y'); assert.equal(shortAge(0, 800 * 86_400_000), '2y'); assert.equal(shortAge(5000, 0), 'now');
  assert.equal(describeAge(0, 90_000), '1 minute ago');
});

test('the block of a line is found by bisection, and text is escaped before it goes into Markdown', () => {
  const blocks = parseBlameFile(Buffer.from(porcelain)).blocks;
  assert.deepEqual([0, 1, 2, 3, 4, 5, -1].map(line => blockAt(blocks, line)?.start ?? null), [0, 0, 2, 3, 4, null, null]);
  assert.equal(blockAt([], 0), undefined);
  assert.equal(escapeMarkdown('[click](command:evil) *bold* `code` <b>x</b> a_b #1 | ~~'), '\\[click\\]\\(command\\:evil\\) \\*bold\\* \\`code\\` \\<b\\>x\\</b\\> a\\_b \\#1 \\| \\~\\~');
  assert.equal(escapeMarkdown('plain words'), 'plain words'); assert.equal(escapeMarkdown('a\\b'), 'a\\\\b');
});

test('the whole-file blame is one porcelain read of a literal path, without the repository\'s textconv programs', () => {
  const args = buildReadCommand({ kind: 'blameFile', path: 'src/a b.ts' });
  assert.deepEqual(args.slice(args.indexOf('blame')), ['blame', '--no-textconv', '--porcelain', '--', 'src/a b.ts']); assert.ok(args.includes('--literal-pathspecs') && args.includes('core.fsmonitor=false'));
  for (const bad of ['', '/etc/passwd', '../x', 'C:\\x', 'a/../../b']) assert.throws(() => buildReadCommand({ kind: 'blameFile', path: bad }), /Invalid history path/, bad);
});
