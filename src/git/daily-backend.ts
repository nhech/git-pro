export interface CommitRequest { amend: boolean; signoff: boolean; noVerify: boolean }
export interface RemoteInfo { name: string; fetchUrl?: string; pushUrl?: string }
export interface DailyBackend {
  stage(root: string, paths: readonly string[]): Promise<void>;
  commit(root: string, message: string, options: CommitRequest): Promise<void>;
  fetch(root: string, remote?: string): Promise<void>;
  push(root: string, remote: string, branch: string, setUpstream: boolean): Promise<void>;
  createBranch(root: string, name: string, checkout: boolean, base?: string): Promise<void>;
  checkout(root: string, name: string): Promise<void>;
  deleteBranch(root: string, name: string, force: boolean): Promise<void>;
  setUpstream(root: string, branch: string, upstream: string): Promise<void>;
  remotes(root: string): Promise<readonly RemoteInfo[]>;
}
