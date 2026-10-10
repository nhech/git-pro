import * as path from 'node:path';
export interface OwnedEditor { node: string; helper: string }
export interface EditorJob extends OwnedEditor {file:string;token:string}
/** Git interprets editor values through its shell; quote only host-owned paths. */
export function editorCommand(editor: OwnedEditor,job?:{file:string;token:string;mode:'sequence'|'message'}): string {
  const quote = (value: string) => {
    if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('Editor helper must use absolute owned paths.');
    const normalized = process.platform==='win32'?value.replace(/\\/g,'/'):value;
    return `'${normalized.replace(/'/g, `'\\''`)}'`;
  };
  if(job&&!/^[a-f0-9-]{36}$/.test(job.token))throw new Error('Invalid editor job token.');
  return `${quote(editor.node)} ${quote(editor.helper)}${job?` ${quote(job.file)} '${job.token}' '${job.mode}'`:''}`;
}
