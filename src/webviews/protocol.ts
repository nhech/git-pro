export type CommitMessage = { type: 'draft'; session: string; repositoryId: string; message: string } |
  { type: 'commit'; session: string; repositoryId: string; message: string; amend: boolean; signoff: boolean; noVerify: boolean; push: boolean } |
  { type: 'ready'; session: string } | { type: 'clearHistory'; session: string; repositoryId: string };
export function parseCommitMessage(value: unknown): CommitMessage {
  if (!value || typeof value !== 'object') throw new Error('Invalid composer message.');
  const item = value as Record<string, unknown>;
  if (typeof item.session !== 'string' || item.session.length > 100) throw new Error('Invalid session.');
  if (item.type === 'ready') return { type: 'ready', session: item.session };
  if (item.type === 'clearHistory' && typeof item.repositoryId === 'string' && item.repositoryId.length <= 4096) return { type: 'clearHistory', session: item.session, repositoryId: item.repositoryId };
  if (typeof item.repositoryId !== 'string' || item.repositoryId.length > 4096 || typeof item.message !== 'string' || item.message.length > 65536 || item.message.includes('\0')) throw new Error('Invalid commit payload.');
  if (item.type === 'draft') return { type: 'draft', session: item.session, repositoryId: item.repositoryId, message: item.message };
  if (item.type !== 'commit' || ['amend', 'signoff', 'noVerify', 'push'].some(key => typeof item[key] !== 'boolean')) throw new Error('Unknown composer action.');
  return { type: 'commit', session: item.session, repositoryId: item.repositoryId, message: item.message,
    amend: item.amend as boolean, signoff: item.signoff as boolean, noVerify: item.noVerify as boolean, push: item.push as boolean };
}
