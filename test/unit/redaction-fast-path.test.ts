import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../../src/security/redaction';

/** The implementation before the marker pre-check, kept verbatim as the oracle. */
function reference(value: string): string {
  return value
    .replace(/\b(?:https?|ssh|git|file):\/\/[^\s]+/gi, candidate => {
      try {
        const parsed = new URL(candidate); let changed = false;
        for (const key of parsed.searchParams.keys()) if (/^(?:access_token|token|auth|key|password|secret|signature|sig|code)$/i.test(key)) { parsed.searchParams.set(key, '[redacted]'); changed = true; }
        return changed ? parsed.toString() : candidate;
      } catch { return candidate; }
    })
    .replace(/\b((?:https?|ssh|git|file):\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:access_token|token|auth|key|password|secret|signature|sig|code)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/((?:https?|ssh|git|file):\/\/[^\s#]+)#[^\s]+/gi, '$1#[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[redacted]')
    .replace(/\b(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b((?:password|passwd|token|secret|oauth_token|extraheader)\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]');
}

test('marker pre-check returns plain labels untouched and still redacts every secret shape', () => {
  const secrets = [
    'fatal: could not read from https://user:hunter2@example.com/org/repo.git',
    'ssh://git@example.com/org/repo.git?token=abc123&x=1', 'https://example.com/a?access_token=s3cret#fragment-secret',
    'push ghp_ABCDEF0123456789abcdef0123456789abcdef failed', 'github_pat_11AAAA_secretsecretsecret', 'gho_abc123 and ghs_def456 and ghu_x ghr_y',
    'Authorization: Bearer abc.def.ghi', 'authorization=basic dXNlcjpwYXNz', 'password: hunter2', 'PASSWD=hunter2\nnext line', 'oauth_token=zzz', 'http.extraheader = AUTHORIZATION: basic abc',
    'url=file:///C:/secret/path?key=value', 'git://host/repo?sig=abc&code=def'
  ];
  const plain = ['src/index.ts', 'packages/pkg-1/src/dir/file_with_underscores.ts', 'README', 'main', 'feature/login-page', 'Modified', 'Git status X', '日本語/ファイル.txt', '', ' ', 'a b c', 'ghp', 'github_pat', 'gh_x'];
  for (const value of [...secrets, ...plain]) assert.equal(redact(value), reference(value), JSON.stringify(value));
  for (const value of plain) assert.equal(redact(value), value);
  for (const value of secrets) assert.notEqual(redact(value), value, `must still redact ${JSON.stringify(value)}`);
  assert.equal(redact(secrets[0]!).includes('hunter2'), false); assert.equal(redact(secrets[3]!).includes('ABCDEF'), false);
});

test('marker pre-check is equivalent to the full rule set on generated text', () => {
  const alphabet = ['a', 'b', 'Z', '0', '9', '_', '-', '.', '/', '\\', ':', '=', '?', '&', '#', '@', ' ', '\n', 'gh', 'p_', 'o_', 'github_pat_', 'http', 'https://', 'ssh://', 'file://', 'token', 'password', 'secret', 'key', 'Authorization', 'Bearer ', 'basic ', 'é', '日'];
  let seed = 0x2f6e2b1; const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  for (let sample = 0; sample < 4000; sample++) {
    let text = ''; const length = next() % 14;
    for (let index = 0; index < length; index++) text += alphabet[next() % alphabet.length];
    assert.equal(redact(text), reference(text), JSON.stringify(text));
  }
});
