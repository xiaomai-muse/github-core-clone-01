import type { ServerResponse } from 'node:http';
import { sendJson } from './rest.ts';
import { HttpError, type ForgeStore, type IssueRecord, type PullRecord, type RepoRecord } from './store.ts';

interface GqlSelection {
  readonly kind: 'field' | 'inlineFragment';
  readonly alias?: string;
  readonly name: string; // field name or typeCondition for inlineFragment
  readonly args?: Record<string, unknown>;
  readonly selections?: readonly GqlSelection[];
}

interface GqlDocument {
  readonly opType: 'query' | 'mutation';
  readonly selections: readonly GqlSelection[];
}

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():[]!$@='.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      let s = '';
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          const esc = src[i + 1]!;
          if (esc === 'n') s += '\n';
          else if (esc === 't') s += '\t';
          else s += esc;
          i += 2;
        } else {
          s += src[i]!;
          i += 1;
        }
      }
      i += 1; // closing quote
      tokens.push({ kind: 'string', value: s });
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i + 1;
      while (j < src.length && /[0-9.eE+-]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'number', value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character in GraphQL query: ${ch}`);
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private readonly tokens: readonly Token[];
  private readonly variables: Readonly<Record<string, unknown>>;

  constructor(tokens: readonly Token[], variables: Readonly<Record<string, unknown>>) {
    this.tokens = tokens;
    this.variables = variables;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos++];
    if (!t) throw new Error('Unexpected end of GraphQL query');
    return t;
  }

  private isPunct(val: string): boolean {
    const t = this.peek();
    return t?.kind === 'punct' && t.value === val;
  }

  private expectPunct(val: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== val) {
      throw new Error(`Expected '${val}' in GraphQL query`);
    }
  }

  parseDocument(): GqlDocument {
    let opType: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first?.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      opType = first.value;
      this.next();
      if (this.peek()?.kind === 'name') this.next(); // optional operation name
      if (this.isPunct('(')) this.skipParens();
    }
    const selections = this.parseSelectionSet();
    return { opType, selections };
  }

  private skipParens(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (t.kind === 'punct' && t.value === '(') depth += 1;
      else if (t.kind === 'punct' && t.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const out: GqlSelection[] = [];
    while (!this.isPunct('}')) {
      if (this.isPunct('...')) {
        this.next();
        const onTok = this.next();
        if (onTok.kind === 'name' && onTok.value === 'on') {
          const typeTok = this.next();
          if (typeTok.kind !== 'name') throw new Error('Expected type name after on');
          const selections = this.parseSelectionSet();
          out.push({ kind: 'inlineFragment', name: typeTok.value, selections });
        } else {
          throw new Error('Named fragments not supported');
        }
        continue;
      }

      const firstTok = this.next();
      if (firstTok.kind !== 'name') throw new Error('Expected field name');
      let alias: string | undefined;
      let name = firstTok.value;
      if (this.isPunct(':')) {
        this.next();
        const nameTok = this.next();
        if (nameTok.kind !== 'name') throw new Error('Expected field name after alias');
        alias = name;
        name = nameTok.value;
      }

      const args = this.isPunct('(') ? this.parseArgs() : undefined;
      const selections = this.isPunct('{') ? this.parseSelectionSet() : undefined;
      out.push({ kind: 'field', alias, name, args, selections });
    }
    this.expectPunct('}');
    return out;
  }

  private parseArgs(): Record<string, unknown> {
    this.expectPunct('(');
    const args: Record<string, unknown> = {};
    while (!this.isPunct(')')) {
      const k = this.next();
      if (k.kind !== 'name') throw new Error('Expected argument name');
      this.expectPunct(':');
      args[k.value] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): unknown {
    const t = this.peek();
    if (!t) throw new Error('Unexpected end in value');
    if (t.kind === 'punct' && t.value === '$') {
      this.next();
      const nameTok = this.next();
      if (nameTok.kind !== 'name') throw new Error('Expected variable name');
      return this.variables[nameTok.value];
    }
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      const arr: unknown[] = [];
      while (!this.isPunct(']')) arr.push(this.parseValue());
      this.expectPunct(']');
      return arr;
    }
    if (t.kind === 'punct' && t.value === '{') {
      this.next();
      const obj: Record<string, unknown> = {};
      while (!this.isPunct('}')) {
        const k = this.next();
        if (k.kind !== 'name') throw new Error('Expected object key');
        this.expectPunct(':');
        obj[k.value] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    this.next();
    if (t.kind === 'string' || t.kind === 'number') return t.value;
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return t.value; // enum value
    }
    throw new Error('Unexpected token in value');
  }
}

const SCHEMA_TYPES: Readonly<Record<string, { fields: string[]; enumValues: string[] }>> = {
  Issue: {
    fields: ['id', 'number', 'title', 'state', 'body'],
    enumValues: [],
  },
  PullRequest: {
    fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
    enumValues: [],
  },
  Repository: {
    fields: [
      'id',
      'databaseId',
      'name',
      'nameWithOwner',
      'owner',
      'defaultBranchRef',
      'viewerPermission',
      'hasIssuesEnabled',
      'issue',
      'issues',
      'pullRequests',
      'pullRequest',
    ],
    enumValues: [],
  },
  SearchType: {
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  },
  User: {
    fields: ['login'],
    enumValues: [],
  },
};

interface GqlError {
  message: string;
  path?: Array<string | number>;
}

function projectObject(
  typeName: string,
  obj: Readonly<Record<string, (args: Record<string, unknown>) => unknown>>,
  selections: readonly GqlSelection[],
  errors: GqlError[],
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'inlineFragment') {
      if (sel.name === typeName && sel.selections) {
        Object.assign(out, projectObject(typeName, obj, sel.selections, errors, path));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    const resolver = obj[sel.name];
    if (!resolver) {
      errors.push({
        message: `Field '${sel.name}' doesn't exist on type '${typeName}'`,
        path: [...path, key],
      });
      continue;
    }
    const val = resolver(sel.args ?? {});
    if (val === null || val === undefined) {
      out[key] = null;
    } else if (sel.selections && typeof val === 'function') {
      out[key] = (val as (sels: readonly GqlSelection[], p: Array<string | number>) => unknown)(
        sel.selections,
        [...path, key],
      );
    } else if (sel.selections && Array.isArray(val)) {
      out[key] = val.map((item, idx) =>
        typeof item === 'function'
          ? (item as (sels: readonly GqlSelection[], p: Array<string | number>) => unknown)(
              sel.selections!,
              [...path, key, idx],
            )
          : item,
      );
    } else {
      out[key] = val;
    }
  }
  return out;
}

function makeIssueResolver(
  issue: IssueRecord,
  errors: GqlError[],
): (sels: readonly GqlSelection[], p: Array<string | number>) => Record<string, unknown> {
  return (sels, p) => {
    return projectObject(
      'Issue',
      {
        id: () => issue.nodeId,
        number: () => issue.number,
        title: () => issue.title,
        state: () => issue.state.toUpperCase(),
        body: () => issue.body,
      },
      sels,
      errors,
      p,
    );
  };
}

function makePullResolver(
  store: ForgeStore,
  repo: RepoRecord,
  pull: PullRecord,
  errors: GqlError[],
): (sels: readonly GqlSelection[], p: Array<string | number>) => Record<string, unknown> {
  return (sels, p) => {
    return projectObject(
      'PullRequest',
      {
        id: () => pull.nodeId,
        number: () => pull.number,
        state: () => (pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN'),
        merged: () => pull.merged,
        headRefName: () => pull.headRef,
        baseRefName: () => pull.baseRef,
        mergeable: () => 'MERGEABLE',
        files: (args) => (subSels: readonly GqlSelection[], subP: Array<string | number>) => {
          const first = typeof args.first === 'number' ? args.first : 100;
          const files = store.getPullFiles(repo, pull).slice(0, first);
          return projectObject(
            'PullRequestChangedFileConnection',
            {
              nodes: () =>
                files.map((f) => (fSels: readonly GqlSelection[], fP: Array<string | number>) =>
                  projectObject('PullRequestChangedFile', { path: () => f.filename }, fSels, errors, fP),
                ),
            },
            subSels,
            errors,
            subP,
          );
        },
      },
      sels,
      errors,
      p,
    );
  };
}

function makeRepoResolver(
  store: ForgeStore,
  repo: RepoRecord,
  errors: GqlError[],
): (sels: readonly GqlSelection[], p: Array<string | number>) => Record<string, unknown> {
  const ownerLogin = store.getViewerLogin();
  return (sels, p) =>
    projectObject(
      'Repository',
      {
        id: () => repo.nodeId,
        databaseId: () => repo.databaseId,
        name: () => repo.name,
        nameWithOwner: () => `${ownerLogin}/${repo.name}`,
        owner: () => (subSels: readonly GqlSelection[], subP: Array<string | number>) =>
          projectObject('User', { login: () => ownerLogin }, subSels, errors, subP),
        defaultBranchRef: () => (subSels: readonly GqlSelection[], subP: Array<string | number>) =>
          projectObject('Ref', { name: () => repo.defaultBranch }, subSels, errors, subP),
        viewerPermission: () => 'ADMIN',
        hasIssuesEnabled: () => true,
        issue: (args) => {
          const num = Number(args.number);
          const issue = repo.issuesByNumber.get(num);
          return issue ? makeIssueResolver(issue, errors) : null;
        },
        issues: (args) => (subSels: readonly GqlSelection[], subP: Array<string | number>) => {
          const states = Array.isArray(args.states)
            ? new Set(args.states.map((s) => String(s).toLowerCase()))
            : null;
          let list = repo.issues.filter((i) => !states || states.has(i.state));
          const orderBy = args.orderBy as { direction?: string } | undefined;
          const dir = orderBy?.direction === 'DESC' ? 'DESC' : 'ASC';
          list = [...list].sort((a, b) => (dir === 'DESC' ? b.number - a.number : a.number - b.number));

          const afterRaw = typeof args.after === 'string' ? args.after : null;
          let startIdx = 0;
          if (afterRaw && afterRaw.startsWith('cursor:')) {
            startIdx = parseInt(afterRaw.slice(7), 10) + 1;
          }
          const first = typeof args.first === 'number' ? args.first : list.length;
          const slice = list.slice(startIdx, startIdx + first);
          const hasNextPage = startIdx + first < list.length;
          const endCursor = slice.length > 0 ? `cursor:${startIdx + slice.length - 1}` : null;

          return projectObject(
            'IssueConnection',
            {
              nodes: () => slice.map((i) => makeIssueResolver(i, errors)),
              pageInfo: () => (pSels: readonly GqlSelection[], pPath: Array<string | number>) =>
                projectObject(
                  'PageInfo',
                  {
                    hasNextPage: () => hasNextPage,
                    endCursor: () => endCursor,
                  },
                  pSels,
                  errors,
                  pPath,
                ),
            },
            subSels,
            errors,
            subP,
          );
        },
        pullRequest: (args) => {
          const num = Number(args.number);
          const pull = repo.pullsByNumber.get(num);
          return pull ? makePullResolver(store, repo, pull, errors) : null;
        },
        pullRequests: (args) => (subSels: readonly GqlSelection[], subP: Array<string | number>) => {
          const first = typeof args.first === 'number' ? args.first : 100;
          const slice = repo.pulls.slice(0, first);
          return projectObject(
            'PullRequestConnection',
            {
              nodes: () => slice.map((pr) => makePullResolver(store, repo, pr, errors)),
            },
            subSels,
            errors,
            subP,
          );
        },
      },
      sels,
      errors,
      p,
    );
}

function executeSingle(
  store: ForgeStore,
  op: { query?: unknown; variables?: unknown },
): { data: Record<string, unknown> | null; errors?: GqlError[] } {
  const query = typeof op.query === 'string' ? op.query : '';
  const variables =
    op.variables && typeof op.variables === 'object' && !Array.isArray(op.variables)
      ? (op.variables as Record<string, unknown>)
      : {};

  let doc: GqlDocument;
  try {
    doc = new GqlParser(tokenize(query), variables).parseDocument();
  } catch (err) {
    return {
      data: null,
      errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }],
    };
  }

  const errors: GqlError[] = [];

  if (doc.opType === 'query') {
    const data = projectObject(
      'Query',
      {
        viewer: () => (sels: readonly GqlSelection[], p: Array<string | number>) =>
          projectObject('User', { login: () => store.getViewerLogin() }, sels, errors, p),
        repository: (args) => {
          const owner = String(args.owner ?? '');
          const name = String(args.name ?? '');
          const repo = store.resolveRepo(owner, name);
          return repo ? makeRepoResolver(store, repo, errors) : null;
        },
        node: (args) => {
          const id = String(args.id ?? '');
          const found = store.findByNodeId(id);
          if (!found) return null;
          if (found.kind === 'repo') return makeRepoResolver(store, found.repo, errors);
          if (found.kind === 'issue') return makeIssueResolver(found.issue, errors);
          return makePullResolver(store, found.repo, found.pull, errors);
        },
        __type: (args) => {
          const typeName = String(args.name ?? '');
          const schema = SCHEMA_TYPES[typeName];
          if (!schema) return null;
          return (sels: readonly GqlSelection[], p: Array<string | number>) =>
            projectObject(
              '__Type',
              {
                name: () => typeName,
                fields: () =>
                  schema.fields.map((f) => (fSels: readonly GqlSelection[], fP: Array<string | number>) =>
                    projectObject('__Field', { name: () => f }, fSels, errors, fP),
                  ),
                enumValues: () =>
                  schema.enumValues.map((e) => (eSels: readonly GqlSelection[], eP: Array<string | number>) =>
                    projectObject('__EnumValue', { name: () => e }, eSels, errors, eP),
                  ),
              },
              sels,
              errors,
              p,
            );
        },
      },
      doc.selections,
      errors,
      [],
    );
    return errors.length > 0 ? { data, errors } : { data };
  }

  // Mutation
  const data = projectObject(
    'Mutation',
    {
      createIssue: (args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repoId = String(input.repositoryId ?? '');
        const repo = store.getRepoByNodeId(repoId);
        if (!repo) {
          errors.push({ message: 'Repository not found' });
          return null;
        }
        const issue = store.createIssue(repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
        });
        return (sels: readonly GqlSelection[], p: Array<string | number>) =>
          projectObject('CreateIssuePayload', { issue: () => makeIssueResolver(issue, errors) }, sels, errors, p);
      },
      closeIssue: (args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const issueId = String(input.issueId ?? '');
        const found = store.findByNodeId(issueId);
        if (!found || found.kind !== 'issue') {
          errors.push({ message: 'Issue not found' });
          return null;
        }
        found.issue.state = 'closed';
        found.issue.cachedJson = undefined;
        return (sels: readonly GqlSelection[], p: Array<string | number>) =>
          projectObject('CloseIssuePayload', { issue: () => makeIssueResolver(found.issue, errors) }, sels, errors, p);
      },
      createPullRequest: (args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repoId = String(input.repositoryId ?? '');
        const repo = store.getRepoByNodeId(repoId);
        if (!repo) {
          errors.push({ message: 'Repository not found' });
          return null;
        }
        let pull: PullRecord;
        try {
          pull = store.createPull(repo, {
            title: String(input.title ?? ''),
            body: typeof input.body === 'string' ? input.body : '',
            head: String(input.headRefName ?? ''),
            base: String(input.baseRefName ?? repo.defaultBranch),
          });
        } catch (err) {
          errors.push({ message: err instanceof HttpError ? err.message : 'Failed to create pull request' });
          return null;
        }
        return (sels: readonly GqlSelection[], p: Array<string | number>) =>
          projectObject(
            'CreatePullRequestPayload',
            { pullRequest: () => makePullResolver(store, repo, pull, errors) },
            sels,
            errors,
            p,
          );
      },
      mergePullRequest: (args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const prId = String(input.pullRequestId ?? '');
        const found = store.findByNodeId(prId);
        if (!found || found.kind !== 'pull') {
          errors.push({ message: 'PullRequest not found' });
          return null;
        }
        try {
          store.mergePull(found.repo, found.pull);
        } catch (err) {
          errors.push({ message: err instanceof HttpError ? err.message : 'Merge failed' });
          return null;
        }
        return (sels: readonly GqlSelection[], p: Array<string | number>) =>
          projectObject(
            'MergePullRequestPayload',
            { pullRequest: () => makePullResolver(store, found.repo, found.pull, errors) },
            sels,
            errors,
            p,
          );
      },
      addComment: (args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const subjectId = String(input.subjectId ?? '');
        const body = String(input.body ?? '');
        const found = store.findByNodeId(subjectId);
        if (!found || found.kind !== 'issue') {
          errors.push({ message: 'Subject not found' });
          return null;
        }
        const comment = store.addIssueComment(found.repo, found.issue, body);
        return (sels: readonly GqlSelection[], p: Array<string | number>) =>
          projectObject(
            'AddCommentPayload',
            {
              commentEdge: () => (eSels: readonly GqlSelection[], eP: Array<string | number>) =>
                projectObject(
                  'IssueCommentEdge',
                  {
                    node: () => (nSels: readonly GqlSelection[], nP: Array<string | number>) =>
                      projectObject(
                        'IssueComment',
                        { id: () => comment.nodeId, body: () => comment.body },
                        nSels,
                        errors,
                        nP,
                      ),
                  },
                  eSels,
                  errors,
                  eP,
                ),
            },
            sels,
            errors,
            p,
          );
      },
    },
    doc.selections,
    errors,
    [],
  );

  return errors.length > 0 ? { data, errors } : { data };
}

export function handleGraphqlRequest(
  store: ForgeStore,
  rawBody: Buffer,
  res: ServerResponse,
  requestId: string,
): void {
  const headers = { 'x-github-request-id': requestId };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' }, headers);
    return;
  }

  if (Array.isArray(parsed)) {
    const results = parsed.map((op) =>
      executeSingle(store, typeof op === 'object' && op !== null ? (op as Record<string, unknown>) : {}),
    );
    sendJson(res, 200, results, headers);
    return;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    sendJson(res, 400, { message: 'Body should be a JSON object or array' }, headers);
    return;
  }

  const result = executeSingle(store, parsed as Record<string, unknown>);
  sendJson(res, 200, result, headers);
}
