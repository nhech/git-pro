import type { Memento } from 'vscode';
import type { RebaseJobInfo, RebaseJournal } from './interactive.service';

export function workspaceRebaseJournal(state: Pick<Memento, 'get'|'update'>): RebaseJournal {
  return {
    get: async id => state.get<RebaseJobInfo>(`gitPro.rebaseJob:${id}`),
    put: async (id, job) => { await state.update(`gitPro.rebaseJob:${id}`, job); }
  };
}
