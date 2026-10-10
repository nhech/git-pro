export function validateBranchName(name: string): string {
  if (!name || name.startsWith('-') || name.startsWith('/') || name.endsWith('/') ||
    name.endsWith('.') || name.includes('..') || name.includes('@{') || name === '@' ||
    /[\s\x00-\x1f\x7f~^:?*\[\\]/.test(name) ||
    name.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    throw new Error('Invalid Git branch name.');
  }
  return name;
}

export function validateOid(oid: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(oid)) throw new Error('Invalid full object ID.');
  return oid;
}
