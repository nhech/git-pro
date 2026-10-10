/** Accept Both is limited to complete standard/diff3 text marker blocks. */
export function acceptBothText(text: string): string {
  const newline = text.includes('\r\n')?'\r\n':'\n', lines = text.split(/\r?\n/), result: string[]=[];
  let state: 'plain'|'ours'|'base'|'theirs'='plain', ours: string[]=[], theirs: string[]=[], blocks=0;
  for (const line of lines) {
    if (/^<<<<<<<(?: |$)/.test(line)) {if(state!=='plain')throw new Error('Nested conflict markers require manual resolution.');state='ours';ours=[];theirs=[];continue;}
    if (/^\|\|\|\|\|\|\|(?: |$)/.test(line)) {if(state!=='ours')throw new Error('Unexpected base marker.');state='base';continue;}
    if (line==='=======') {if(state!=='ours'&&state!=='base')throw new Error('Unexpected separator.');state='theirs';continue;}
    if (/^>>>>>>>(?: |$)/.test(line)) {if(state!=='theirs')throw new Error('Unexpected end marker.');result.push(...ours,...theirs);state='plain';blocks++;continue;}
    if (state==='plain')result.push(line);else if(state==='ours')ours.push(line);else if(state==='theirs')theirs.push(line);
  }
  if (state!=='plain'||!blocks) throw new Error('No complete standard conflict blocks. Resolve this file manually.');
  return result.join(newline);
}
export function hasConflictMarkers(text: string): boolean { return /^(?:<{7,}|={7,}|>{7,}|\|{7,})(?: |$)/m.test(text); }
