import { createHash } from 'node:crypto';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface ParsedTag {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export interface LabelRecord {
  readonly id: number;
  readonly name: string;
  readonly color: string;
}

export interface CommentRecord {
  readonly id: number;
  readonly nodeId: string;
  readonly body: string;
  readonly userLogin: string;
  readonly createdAt: string;
}

export interface IssueRecord {
  readonly id: number;
  readonly nodeId: string;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly labels: LabelRecord[];
  readonly comments: CommentRecord[];
  readonly createdAt: string;
  updatedAt: string;
  cachedJson?: Buffer;
}

export interface PullRecord {
  readonly id: number;
  readonly nodeId: string;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly createdAt: string;
}

export interface RepoRecord {
  readonly databaseId: number;
  readonly nodeId: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, LabelRecord>;
  readonly issues: IssueRecord[];
  readonly issuesByNumber: Map<number, IssueRecord>;
  readonly pulls: PullRecord[];
  readonly pullsByNumber: Map<number, PullRecord>;
  nextNumber: number;
  readonly lsRefsCache: Map<string, Buffer>;
}

export const ZERO_OID = '0'.repeat(40);
export const FIXED_EPOCH_SEC = 1_735_689_600;
export const FIXED_ISO = '2025-01-01T00:00:00Z';
export const DEFAULT_IDENT = `Forge Bot <bot@forge.local> ${FIXED_EPOCH_SEC} +0000`;

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const headerBlock = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? '' : text.slice(sep + 2);
  let tree = '';
  const parents: string[] = [];
  let author = DEFAULT_IDENT;
  let committer = DEFAULT_IDENT;
  for (const line of headerBlock.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  author?: string;
  committer?: string;
  message: string;
}): Buffer {
  const lines = [`tree ${input.tree}`];
  for (const p of input.parents) lines.push(`parent ${p}`);
  lines.push(`author ${input.author ?? DEFAULT_IDENT}`);
  lines.push(`committer ${input.committer ?? DEFAULT_IDENT}`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const aKey = a.mode === '40000' || a.mode === '040000' ? `${a.name}/` : a.name;
    const bKey = b.mode === '40000' || b.mode === '040000' ? `${b.name}/` : b.name;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    const mode = e.mode === '040000' ? '40000' : e.mode;
    parts.push(Buffer.from(`${mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const headerBlock = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? '' : text.slice(sep + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = DEFAULT_IDENT;
  for (const line of headerBlock.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function peelTag(objects: ReadonlyMap<string, GitObject>, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = objects.get(current);
    if (!obj) return null;
    if (obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return null;
}

export function isAncestor(
  objects: ReadonlyMap<string, GitObject>,
  ancestorOid: string,
  descendantOid: string,
): boolean {
  if (ancestorOid === descendantOid) return true;
  const visited = new Set<string>();
  const queue: string[] = [descendantOid];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (cur === ancestorOid) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const obj = objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    for (const p of commit.parents) {
      if (!visited.has(p)) queue.push(p);
    }
  }
  return false;
}

export function findMergeBase(
  objects: ReadonlyMap<string, GitObject>,
  aOid: string,
  bOid: string,
): string | null {
  const ancestorsA = new Set<string>();
  const qA: string[] = [aOid];
  while (qA.length > 0) {
    const cur = qA.shift()!;
    if (ancestorsA.has(cur)) continue;
    ancestorsA.add(cur);
    const obj = objects.get(cur);
    if (obj?.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) qA.push(p);
    }
  }
  const visitedB = new Set<string>();
  const qB: string[] = [bOid];
  while (qB.length > 0) {
    const cur = qB.shift()!;
    if (ancestorsA.has(cur)) return cur;
    if (visitedB.has(cur)) continue;
    visitedB.add(cur);
    const obj = objects.get(cur);
    if (obj?.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) qB.push(p);
    }
  }
  return null;
}

export function flattenTree(
  objects: ReadonlyMap<string, GitObject>,
  treeOid: string,
  prefix = '',
  out: Map<string, string> = new Map(),
): Map<string, string> {
  const obj = objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const full = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000' || entry.mode === '040000') {
      flattenTree(objects, entry.oid, full, out);
    } else {
      out.set(full, entry.oid);
    }
  }
  return out;
}

export function writeTreeFromFiles(
  objects: Map<string, GitObject>,
  files: ReadonlyMap<string, string>,
): string {
  const rootFiles = new Map<string, string>();
  const subdirs = new Map<string, Map<string, string>>();
  for (const [path, oid] of files) {
    const slash = path.indexOf('/');
    if (slash === -1) {
      rootFiles.set(path, oid);
    } else {
      const dir = path.slice(0, slash);
      const rest = path.slice(slash + 1);
      let sub = subdirs.get(dir);
      if (!sub) {
        sub = new Map();
        subdirs.set(dir, sub);
      }
      sub.set(rest, oid);
    }
  }
  const entries: TreeEntry[] = [];
  for (const [name, oid] of rootFiles) {
    entries.push({ mode: '100644', name, oid });
  }
  for (const [dir, sub] of subdirs) {
    const subOid = writeTreeFromFiles(objects, sub);
    entries.push({ mode: '40000', name: dir, oid: subOid });
  }
  const treeBuf = buildTree(entries);
  const treeOid = hashObject('tree', treeBuf);
  objects.set(treeOid, { type: 'tree', data: treeBuf });
  return treeOid;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class ForgeStore {
  viewerLogin: string | null = null;
  private reqCounter = 0;
  private repoIdCounter = 1000;
  private labelIdCounter = 2000;
  private issueIdCounter = 3000;
  private commentIdCounter = 4000;
  private pullIdCounter = 5000;
  private readonly reposByName = new Map<string, RepoRecord>();
  private readonly reposByNodeId = new Map<string, RepoRecord>();

  nextRequestId(): string {
    this.reqCounter += 1;
    return `req-${this.reqCounter}`;
  }

  getViewerLogin(): string {
    return this.viewerLogin ?? 'viewer';
  }

  /**
   * Lock viewerLogin on the first request naming an existing repo's owner,
   * then enforce strict ownership (foreign owner => 404).
   */
  resolveRepo(owner: string, name: string): RepoRecord | null {
    const repo = this.reposByName.get(name);
    if (!repo) return null;
    if (this.viewerLogin === null) {
      if (owner === 'viewer') return repo;
      this.viewerLogin = owner;
    }
    if (owner !== this.viewerLogin) {
      return null;
    }
    return repo;
  }

  requireRepo(owner: string, name: string): RepoRecord {
    const repo = this.resolveRepo(owner, name);
    if (!repo) throw new HttpError(404, 'Not Found');
    return repo;
  }

  getRepoByNodeId(nodeId: string): RepoRecord | null {
    return this.reposByNodeId.get(nodeId) ?? null;
  }

  listViewerRepos(): RepoRecord[] {
    return [...this.reposByName.values()];
  }

  createRepo(input: { name: string; description?: string; private?: boolean; auto_init?: boolean }): RepoRecord {
    const existing = this.reposByName.get(input.name);
    if (existing) {
      throw new HttpError(422, 'Repository creation failed: name already exists on this account');
    }
    this.repoIdCounter += 1;
    const databaseId = this.repoIdCounter;
    const nodeId = `R_kgDO${databaseId}`;
    const repo: RepoRecord = {
      databaseId,
      nodeId,
      name: input.name,
      description: input.description ?? '',
      isPrivate: input.private ?? false,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      issuesByNumber: new Map(),
      pulls: [],
      pullsByNumber: new Map(),
      nextNumber: 1,
      lsRefsCache: new Map(),
    };
    if (input.auto_init === true) {
      const blobBuf = Buffer.from(`# ${input.name}\n`, 'utf8');
      const blobOid = hashObject('blob', blobBuf);
      repo.objects.set(blobOid, { type: 'blob', data: blobBuf });
      const treeOid = writeTreeFromFiles(repo.objects, new Map([['README.md', blobOid]]));
      const commitBuf = buildCommit({ tree: treeOid, parents: [], message: 'Initial commit\n' });
      const commitOid = hashObject('commit', commitBuf);
      repo.objects.set(commitOid, { type: 'commit', data: commitBuf });
      repo.refs.set(`refs/heads/${repo.defaultBranch}`, commitOid);
    }
    this.reposByName.set(repo.name, repo);
    this.reposByNodeId.set(repo.nodeId, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): void {
    const repo = this.requireRepo(owner, name);
    this.reposByName.delete(repo.name);
    this.reposByNodeId.delete(repo.nodeId);
  }

  resolveRefOid(repo: RepoRecord, refOrSha?: string): string | null {
    if (!refOrSha) {
      return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    if (repo.objects.has(refOrSha)) return refOrSha;
    return (
      repo.refs.get(refOrSha) ??
      repo.refs.get(`refs/heads/${refOrSha}`) ??
      repo.refs.get(`refs/tags/${refOrSha}`) ??
      null
    );
  }

  putFileContent(
    repo: RepoRecord,
    path: string,
    input: { message: string; content: string; sha?: string; branch?: string },
  ): { contentSha: string; commitSha: string; created: boolean } {
    const branch = input.branch ?? repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const parentOid = repo.refs.get(refName) ?? null;

    const files = new Map<string, string>();
    if (parentOid) {
      const parentCommit = repo.objects.get(parentOid);
      if (parentCommit?.type === 'commit') {
        flattenTree(repo.objects, parseCommit(parentCommit.data).tree, '', files);
      }
    }

    const existingBlobSha = files.get(path);
    const created = existingBlobSha === undefined;
    if (!created && input.sha !== existingBlobSha) {
      throw new HttpError(409, `${path} does not match ${input.sha ?? 'missing sha'}`);
    }
    if (created && input.sha !== undefined) {
      throw new HttpError(409, `${path} does not exist`);
    }

    const contentBuf = Buffer.from(input.content, 'base64');
    const contentSha = hashObject('blob', contentBuf);
    repo.objects.set(contentSha, { type: 'blob', data: contentBuf });
    files.set(path, contentSha);

    const treeOid = writeTreeFromFiles(repo.objects, files);
    const commitBuf = buildCommit({
      tree: treeOid,
      parents: parentOid ? [parentOid] : [],
      message: input.message,
    });
    const commitSha = hashObject('commit', commitBuf);
    repo.objects.set(commitSha, { type: 'commit', data: commitBuf });
    repo.refs.set(refName, commitSha);
    repo.lsRefsCache.clear();

    return { contentSha, commitSha, created };
  }

  deleteFileContent(
    repo: RepoRecord,
    path: string,
    input: { message: string; sha: string; branch?: string },
  ): { commitSha: string } {
    const branch = input.branch ?? repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const parentOid = repo.refs.get(refName) ?? null;
    if (!parentOid) throw new HttpError(404, 'Not Found');

    const parentCommit = repo.objects.get(parentOid);
    if (!parentCommit || parentCommit.type !== 'commit') throw new HttpError(404, 'Not Found');
    const files = flattenTree(repo.objects, parseCommit(parentCommit.data).tree);

    const existingBlobSha = files.get(path);
    if (!existingBlobSha) throw new HttpError(404, 'Not Found');
    if (input.sha !== existingBlobSha) {
      throw new HttpError(409, `${path} does not match ${input.sha}`);
    }

    files.delete(path);
    const treeOid = writeTreeFromFiles(repo.objects, files);
    const commitBuf = buildCommit({
      tree: treeOid,
      parents: [parentOid],
      message: input.message,
    });
    const commitSha = hashObject('commit', commitBuf);
    repo.objects.set(commitSha, { type: 'commit', data: commitBuf });
    repo.refs.set(refName, commitSha);
    repo.lsRefsCache.clear();
    return { commitSha };
  }

  createLabel(repo: RepoRecord, name: string, color = 'ededed'): LabelRecord {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    this.labelIdCounter += 1;
    const label: LabelRecord = { id: this.labelIdCounter, name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: RepoRecord, input: { title: string; body?: string; labels?: readonly string[] }): IssueRecord {
    const resolvedLabels: LabelRecord[] = [];
    if (input.labels) {
      for (const lName of input.labels) {
        const label = repo.labels.get(lName);
        if (!label) {
          throw new HttpError(422, `Label "${lName}" does not exist`);
        }
        resolvedLabels.push(label);
      }
    }
    this.issueIdCounter += 1;
    const number = repo.nextNumber++;
    const issue: IssueRecord = {
      id: this.issueIdCounter,
      nodeId: `I_kwDO${repo.databaseId}_${number}`,
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: resolvedLabels,
      comments: [],
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
    };
    repo.issues.push(issue);
    repo.issuesByNumber.set(issue.number, issue);
    return issue;
  }

  addIssueComment(repo: RepoRecord, issue: IssueRecord, body: string): CommentRecord {
    this.commentIdCounter += 1;
    const comment: CommentRecord = {
      id: this.commentIdCounter,
      nodeId: `IC_kwDO${this.commentIdCounter}`,
      body,
      userLogin: this.getViewerLogin(),
      createdAt: FIXED_ISO,
    };
    issue.comments.push(comment);
    issue.cachedJson = undefined;
    return comment;
  }

  createPull(
    repo: RepoRecord,
    input: { title: string; body?: string; head: string; base: string },
  ): PullRecord {
    const headSha = this.resolveRefOid(repo, input.head);
    const baseSha = this.resolveRefOid(repo, input.base);
    if (!headSha || !baseSha) {
      throw new HttpError(422, 'Validation Failed: head or base branch not found');
    }
    this.pullIdCounter += 1;
    const number = repo.nextNumber++;
    const pull: PullRecord = {
      id: this.pullIdCounter,
      nodeId: `PR_kwDO${repo.databaseId}_${number}`,
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      headRef: input.head,
      headSha,
      baseRef: input.base,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: FIXED_ISO,
    };
    repo.pulls.push(pull);
    repo.pullsByNumber.set(pull.number, pull);
    return pull;
  }

  private getCommitFiles(repo: RepoRecord, commitOid: string): Map<string, string> {
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return new Map();
    return flattenTree(repo.objects, parseCommit(obj.data).tree);
  }

  getPullFiles(
    repo: RepoRecord,
    pull: PullRecord,
  ): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = this.resolveRefOid(repo, pull.headRef) ?? pull.headSha;
    const baseTip = pull.baseSha;
    const baseCommit = findMergeBase(repo.objects, baseTip, headTip) ?? baseTip;
    const baseFiles = this.getCommitFiles(repo, baseCommit);
    const headFiles = this.getCommitFiles(repo, headTip);

    const allPaths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
    const result: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...allPaths].sort()) {
      const bSha = baseFiles.get(path);
      const hSha = headFiles.get(path);
      if (bSha === hSha) continue;
      const bLines = bSha ? (repo.objects.get(bSha)?.data.toString('utf8').split('\n').length ?? 0) : 0;
      const hLines = hSha ? (repo.objects.get(hSha)?.data.toString('utf8').split('\n').length ?? 0) : 0;
      if (!bSha) {
        result.push({ filename: path, status: 'added', additions: Math.max(1, hLines), deletions: 0, changes: Math.max(1, hLines) });
      } else if (!hSha) {
        result.push({ filename: path, status: 'removed', additions: 0, deletions: Math.max(1, bLines), changes: Math.max(1, bLines) });
      } else {
        const adds = Math.max(1, hLines);
        const dels = Math.max(1, bLines);
        result.push({ filename: path, status: 'modified', additions: adds, deletions: dels, changes: adds + dels });
      }
    }
    return result;
  }

  mergePull(repo: RepoRecord, pull: PullRecord, commitMessage?: string): { sha: string; message: string } {
    if (pull.merged) {
      throw new HttpError(405, 'Pull Request is already merged');
    }
    if (pull.state === 'closed') {
      throw new HttpError(405, 'Pull Request is closed');
    }
    const baseRefShort = pull.baseRef.startsWith('refs/heads/')
      ? pull.baseRef.slice('refs/heads/'.length)
      : pull.baseRef;
    const baseRefName = `refs/heads/${baseRefShort}`;
    const currentBaseOid = repo.refs.get(baseRefName) ?? pull.baseSha;
    const currentHeadOid = this.resolveRefOid(repo, pull.headRef) ?? pull.headSha;

    const mergeBase = findMergeBase(repo.objects, currentBaseOid, currentHeadOid);
    const ancestorFiles = mergeBase ? this.getCommitFiles(repo, mergeBase) : new Map<string, string>();
    const baseFiles = this.getCommitFiles(repo, currentBaseOid);
    const headFiles = this.getCommitFiles(repo, currentHeadOid);

    const mergedFiles = new Map<string, string>(baseFiles);
    const allPaths = new Set<string>([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);

    for (const path of allPaths) {
      const a = ancestorFiles.get(path);
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      if (h === a) continue; // head made no change
      if (b !== a && b !== h) {
        // Both base and head modified the same path differently -> conflict!
        throw new HttpError(405, `Merge conflict on ${path}`);
      }
      if (h === undefined) mergedFiles.delete(path);
      else mergedFiles.set(path, h);
    }

    const treeOid = writeTreeFromFiles(repo.objects, mergedFiles);
    const msg = commitMessage ?? `${pull.title} (#${pull.number})\n`;
    const commitBuf = buildCommit({
      tree: treeOid,
      parents: [currentBaseOid],
      message: msg,
    });
    const mergeSha = hashObject('commit', commitBuf);
    repo.objects.set(mergeSha, { type: 'commit', data: commitBuf });
    repo.refs.set(baseRefName, mergeSha);
    repo.lsRefsCache.clear();

    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeCommitSha = mergeSha;

    return { sha: mergeSha, message: 'Pull Request successfully merged' };
  }

  findByNodeId(nodeId: string):
    | { kind: 'repo'; repo: RepoRecord }
    | { kind: 'issue'; repo: RepoRecord; issue: IssueRecord }
    | { kind: 'pull'; repo: RepoRecord; pull: PullRecord }
    | null {
    const repo = this.reposByNodeId.get(nodeId);
    if (repo) return { kind: 'repo', repo };
    for (const r of this.reposByName.values()) {
      for (const issue of r.issues) {
        if (issue.nodeId === nodeId) return { kind: 'issue', repo: r, issue };
      }
      for (const pull of r.pulls) {
        if (pull.nodeId === nodeId) return { kind: 'pull', repo: r, pull };
      }
    }
    return null;
  }
}
