/** Every rule below needs ':' or '=' (URLs, headers, key=value) or a GitHub token prefix to match anything. */
const SECRET_MARKERS = /[:=]|gh[pousr]_|github_pat_/;
/** Only sanitized messages may cross the logging/notification boundary. */
export function redact(value: string): string {
  // Most labels (file paths, branch names, status words) carry no marker; skip seven regex passes for them.
  if (!SECRET_MARKERS.test(value)) return value;
  return value
    .replace(/\b(?:https?|ssh|git|file):\/\/[^\s]+/gi, candidate=>{
      try{
        const parsed=new URL(candidate);let changed=false;
        for(const key of parsed.searchParams.keys())if(/^(?:access_token|token|auth|key|password|secret|signature|sig|code)$/i.test(key)){parsed.searchParams.set(key,'[redacted]');changed=true;}
        return changed?parsed.toString():candidate;
      }catch{return candidate;}
    })
    .replace(/\b((?:https?|ssh|git|file):\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:access_token|token|auth|key|password|secret|signature|sig|code)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/((?:https?|ssh|git|file):\/\/[^\s#]+)#[^\s]+/gi, '$1#[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[redacted]')
    .replace(/\b(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b((?:password|passwd|token|secret|oauth_token|extraheader)\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]');
}
