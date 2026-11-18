import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FIXED_ISO,
  HttpError,
  flattenTree,
  parseCommit,
  parseTree,
  peelTag,
  type ForgeStore,
  type IssueRecord,
  type PullRecord,
  type RepoRecord,
} from './store.ts';

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_CONTENT_TYPE,
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function formatRepo(store: ForgeStore, repo: RepoRecord): Record<string, unknown> {
  const owner = store.getViewerLogin();
  return {
    id: repo.databaseId,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: owner },
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function formatIssue(store: ForgeStore, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: store.getViewerLogin() },
    labels: issue.labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function formatPull(store: ForgeStore, pull: PullRecord): Record<string, unknown> {
  const owner = store.getViewerLogin();
  return {
    id: pull.id,
    node_id: pull.nodeId,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: owner },
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
  };
}

function parseJsonBody(rawBody: Buffer): Record<string, unknown> {
  if (rawBody.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'Body should be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function paginate<T>(
  items: readonly T[],
  searchParams: URLSearchParams,
  basePath: string,
  hostHeader: string | undefined,
): { pageItems: T[]; headers: Record<string, string> } {
  const perPageRaw = parseInt(searchParams.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = parseInt(searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const origin = hostHeader ? `http://${hostHeader}` : 'http://127.0.0.1';
    const nextUrl = new URL(basePath, origin);
    for (const [k, v] of searchParams.entries()) {
      if (k !== 'page') nextUrl.searchParams.set(k, v);
    }
    nextUrl.searchParams.set('per_page', String(perPage));
    nextUrl.searchParams.set('page', String(page + 1));
    headers['link'] = `<${nextUrl.origin}${nextUrl.pathname}${nextUrl.search}>; rel="next"`;
  }
  return { pageItems, headers };
}

export function handleRestRequest(
  store: ForgeStore,
  method: string,
  pathname: string,
  query: string,
  rawBody: Buffer,
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
): void {
  const baseHeaders: Record<string, string> = { 'x-github-request-id': requestId };
  let cachedSearchParams: URLSearchParams | null = null;
  const getSearchParams = (): URLSearchParams => {
    if (cachedSearchParams === null) {
      cachedSearchParams = new URLSearchParams(query);
    }
    return cachedSearchParams;
  };

  try {
    if (method === 'GET' && (pathname === '/api/v3' || pathname === '/api/v3/')) {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          rate_limit_url: '/api/v3/rate_limit',
        },
        { ...baseHeaders, 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }

    if (method === 'GET' && pathname === '/api/v3/meta') {
      sendJson(
        res,
        200,
        { installed_version: '1.0.0', verifiable_password_authentication: false },
        baseHeaders,
      );
      return;
    }

    if (method === 'GET' && pathname === '/api/v3/user') {
      sendJson(res, 200, { login: store.getViewerLogin() }, baseHeaders);
      return;
    }

    if (pathname === '/api/v3/user/repos') {
      if (method === 'GET') {
        const allRepos = store.listViewerRepos().map((r) => formatRepo(store, r));
        const { pageItems, headers } = paginate(allRepos, getSearchParams(), '/api/v3/user/repos', req.headers.host);
        sendJson(res, 200, pageItems, { ...baseHeaders, ...headers });
        return;
      }
      if (method === 'POST') {
        const body = parseJsonBody(rawBody);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) throw new HttpError(422, 'Repository name is required');
        const repo = store.createRepo({
          name,
          description: typeof body.description === 'string' ? body.description : '',
          private: typeof body.private === 'boolean' ? body.private : false,
          auto_init: typeof body.auto_init === 'boolean' ? body.auto_init : false,
        });
        sendJson(res, 201, formatRepo(store, repo), baseHeaders);
        return;
      }
    }

    // /api/v3/repos/{owner}/{repo}...
    if (!pathname.startsWith('/api/v3/repos/')) {
      sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
      return;
    }
    const restPath = pathname.slice('/api/v3/repos/'.length);
    const slash1 = restPath.indexOf('/');
    if (slash1 <= 0) {
      sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
      return;
    }
    const rawOwner = restPath.slice(0, slash1);
    const afterOwner = restPath.slice(slash1 + 1);
    const slash2 = afterOwner.indexOf('/');
    const rawRepo = slash2 === -1 ? afterOwner : afterOwner.slice(0, slash2);
    if (!rawRepo) {
      sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
      return;
    }
    const owner = rawOwner.includes('%') ? decodeURIComponent(rawOwner) : rawOwner;
    const repoName = rawRepo.includes('%') ? decodeURIComponent(rawRepo) : rawRepo;
    const sub = slash2 === -1 ? '' : afterOwner.slice(slash2);

    if (sub === '' || sub === '/') {
      if (method === 'GET') {
        const repo = store.requireRepo(owner, repoName);
        sendJson(res, 200, formatRepo(store, repo), baseHeaders);
        return;
      }
      if (method === 'PATCH') {
        const repo = store.requireRepo(owner, repoName);
        const body = parseJsonBody(rawBody);
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        if (typeof body.default_branch === 'string' && body.default_branch.length > 0) {
          repo.defaultBranch = body.default_branch;
        }
        sendJson(res, 200, formatRepo(store, repo), baseHeaders);
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        res.writeHead(204, { ...baseHeaders, 'content-type': JSON_CONTENT_TYPE });
        res.end();
        return;
      }
    }

    const repo = store.requireRepo(owner, repoName);

    // /branches
    if (method === 'GET' && sub === '/branches') {
      const branches: Array<Record<string, unknown>> = [];
      for (const [refName, sha] of [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (!refName.startsWith('refs/heads/')) continue;
        branches.push({
          name: refName.slice('refs/heads/'.length),
          commit: { sha },
          protected: false,
        });
      }
      sendJson(res, 200, branches, baseHeaders);
      return;
    }

    // /commits
    if (method === 'GET' && sub === '/commits') {
      const shaParam = query ? (getSearchParams().get('sha') ?? undefined) : undefined;
      let startOid = store.resolveRefOid(repo, shaParam);
      if (startOid) startOid = peelTag(repo.objects, startOid) ?? startOid;
      if (!startOid) {
        sendJson(res, 200, [], baseHeaders);
        return;
      }
      const commits: Array<Record<string, unknown>> = [];
      const visited = new Set<string>();
      const queue: string[] = [startOid];
      while (queue.length > 0 && commits.length < 200) {
        const cur = queue.shift()!;
        if (visited.has(cur)) continue;
        visited.add(cur);
        const obj = repo.objects.get(cur);
        if (!obj || obj.type !== 'commit') continue;
        const parsed = parseCommit(obj.data);
        commits.push({
          sha: cur,
          commit: {
            message: parsed.message,
            author: { name: store.getViewerLogin(), email: 'bot@forge.local', date: FIXED_ISO },
          },
        });
        for (const p of parsed.parents) queue.push(p);
      }
      sendJson(res, 200, commits, baseHeaders);
      return;
    }

    // /git/refs
    if (method === 'POST' && sub === '/git/refs') {
      const body = parseJsonBody(rawBody);
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref || !sha || !repo.objects.has(sha)) {
        throw new HttpError(422, 'Invalid ref or sha');
      }
      if (repo.refs.has(ref)) {
        throw new HttpError(422, 'Reference already exists');
      }
      repo.refs.set(ref, sha);
      repo.lsRefsCache.clear();
      sendJson(res, 201, { ref, node_id: `REF_${sha.slice(0, 8)}`, object: { sha, type: 'commit' } }, baseHeaders);
      return;
    }

    // /contents/{path}
    if (sub.startsWith('/contents/')) {
      const filePath = decodeURIComponent(sub.slice('/contents/'.length)).replace(/^\/+|\/+$/g, '');
      if (!filePath) throw new HttpError(404, 'Not Found');

      if (method === 'GET') {
        const refParam = query ? (getSearchParams().get('ref') ?? undefined) : undefined;
        let tipOid = store.resolveRefOid(repo, refParam);
        if (tipOid) tipOid = peelTag(repo.objects, tipOid) ?? tipOid;
        if (!tipOid) throw new HttpError(404, 'Not Found');
        const commitObj = repo.objects.get(tipOid);
        if (!commitObj || commitObj.type !== 'commit') throw new HttpError(404, 'Not Found');

        const rootTreeOid = parseCommit(commitObj.data).tree;
        const parts = filePath.split('/');
        let currentTreeOid = rootTreeOid;
        for (let i = 0; i < parts.length; i += 1) {
          const part = parts[i]!;
          const treeObj = repo.objects.get(currentTreeOid);
          if (!treeObj || treeObj.type !== 'tree') throw new HttpError(404, 'Not Found');
          const entries = parseTree(treeObj.data);
          const match = entries.find((e) => e.name === part);
          if (!match) throw new HttpError(404, 'Not Found');

          const isLast = i === parts.length - 1;
          const isDir = match.mode === '40000' || match.mode === '040000';
          if (!isLast) {
            if (!isDir) throw new HttpError(404, 'Not Found');
            currentTreeOid = match.oid;
            continue;
          }

          if (isDir) {
            const subTreeObj = repo.objects.get(match.oid);
            if (!subTreeObj || subTreeObj.type !== 'tree') throw new HttpError(404, 'Not Found');
            const dirEntries = parseTree(subTreeObj.data).map((e) => {
              const eIsDir = e.mode === '40000' || e.mode === '040000';
              const eSize = eIsDir ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0);
              return {
                type: eIsDir ? 'dir' : 'file',
                name: e.name,
                path: `${filePath}/${e.name}`,
                sha: e.oid,
                size: eSize,
              };
            });
            sendJson(res, 200, dirEntries, baseHeaders);
            return;
          }

          const blobObj = repo.objects.get(match.oid);
          if (!blobObj || blobObj.type !== 'blob') throw new HttpError(404, 'Not Found');
          sendJson(
            res,
            200,
            {
              type: 'file',
              encoding: 'base64',
              size: blobObj.data.length,
              name: match.name,
              path: filePath,
              sha: match.oid,
              content: blobObj.data.toString('base64'),
            },
            baseHeaders,
          );
          return;
        }
      }

      if (method === 'PUT') {
        const body = parseJsonBody(rawBody);
        if (typeof body.message !== 'string' || body.message.trim() === '') {
          throw new HttpError(422, 'Validation Failed: message is required');
        }
        if (typeof body.content !== 'string') {
          throw new HttpError(422, 'Validation Failed: content is required');
        }
        const message = body.message;
        const content = body.content;
        const sha = typeof body.sha === 'string' ? body.sha : undefined;
        const branch = typeof body.branch === 'string' ? body.branch : undefined;
        const result = store.putFileContent(repo, filePath, { message, content, sha, branch });
        const size = Buffer.from(content, 'base64').length;
        sendJson(
          res,
          result.created ? 201 : 200,
          {
            content: {
              name: filePath.split('/').pop() ?? filePath,
              path: filePath,
              sha: result.contentSha,
              size,
              type: 'file',
              encoding: 'base64',
            },
            commit: {
              sha: result.commitSha,
              message,
            },
          },
          baseHeaders,
        );
        return;
      }

      if (method === 'DELETE') {
        const body = parseJsonBody(rawBody);
        const message = typeof body.message === 'string' ? body.message : 'delete file';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        const branch = typeof body.branch === 'string' ? body.branch : undefined;
        const result = store.deleteFileContent(repo, filePath, { message, sha, branch });
        sendJson(
          res,
          200,
          {
            content: null,
            commit: { sha: result.commitSha, message },
          },
          baseHeaders,
        );
        return;
      }
    }

    // /labels
    if (sub === '/labels') {
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()], baseHeaders);
        return;
      }
      if (method === 'POST') {
        const body = parseJsonBody(rawBody);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) throw new HttpError(422, 'Label name is required');
        const color = typeof body.color === 'string' ? body.color : 'ededed';
        const label = store.createLabel(repo, name, color);
        sendJson(res, 201, label, baseHeaders);
        return;
      }
    }

    // /issues
    if (sub === '/issues') {
      if (method === 'GET') {
        const sp = getSearchParams();
        const stateFilter = sp.get('state') ?? 'open';
        const direction = sp.get('direction') ?? 'desc';
        let filtered = repo.issues.filter((i) => stateFilter === 'all' || i.state === stateFilter);
        filtered = [...filtered].sort((a, b) =>
          direction === 'asc' ? a.number - b.number : b.number - a.number,
        );
        const { pageItems, headers } = paginate(
          filtered.map((i) => formatIssue(store, i)),
          sp,
          pathname,
          req.headers.host,
        );
        sendJson(res, 200, pageItems, { ...baseHeaders, ...headers });
        return;
      }
      if (method === 'POST') {
        const body = parseJsonBody(rawBody);
        const title = typeof body.title === 'string' ? body.title : '';
        if (!title) throw new HttpError(422, 'Title is required');
        const issueBody = typeof body.body === 'string' ? body.body : '';
        const labels = Array.isArray(body.labels)
          ? body.labels.filter((l): l is string => typeof l === 'string')
          : undefined;
        const issue = store.createIssue(repo, { title, body: issueBody, labels });
        sendJson(res, 201, formatIssue(store, issue), baseHeaders);
        return;
      }
    }

    if (sub.startsWith('/issues/')) {
      const restIssue = sub.slice('/issues/'.length);
      const commentSlash = restIssue.indexOf('/');
      const numStr = commentSlash === -1 ? restIssue : restIssue.slice(0, commentSlash);
      const isComments = commentSlash !== -1 && restIssue.slice(commentSlash) === '/comments';
      if ((commentSlash === -1 || isComments) && /^\d+$/.test(numStr)) {
        const issueNum = parseInt(numStr, 10);
        const issue = repo.issuesByNumber.get(issueNum);
        if (!issue) throw new HttpError(404, 'Not Found');

        if (!isComments) {
          if (method === 'GET') {
            let cached = issue.cachedJson;
            if (!cached) {
              cached = Buffer.from(JSON.stringify(formatIssue(store, issue)), 'utf8');
              issue.cachedJson = cached;
            }
            res.writeHead(200, {
              'content-type': JSON_CONTENT_TYPE,
              'content-length': cached.length,
              'x-github-request-id': requestId,
            });
            res.end(cached);
            return;
          }
          if (method === 'PATCH') {
            const body = parseJsonBody(rawBody);
            if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
            if (typeof body.title === 'string') issue.title = body.title;
            if (typeof body.body === 'string') issue.body = body.body;
            issue.cachedJson = undefined;
            sendJson(res, 200, formatIssue(store, issue), baseHeaders);
            return;
          }
        } else {
        if (method === 'GET') {
          const comments = issue.comments.map((c) => ({
            id: c.id,
            node_id: c.nodeId,
            body: c.body,
            user: { login: c.userLogin },
            created_at: c.createdAt,
          }));
          sendJson(res, 200, comments, baseHeaders);
          return;
        }
        if (method === 'POST') {
          const body = parseJsonBody(rawBody);
          const commentBody = typeof body.body === 'string' ? body.body : '';
          const comment = store.addIssueComment(repo, issue, commentBody);
          sendJson(
            res,
            201,
            {
              id: comment.id,
              node_id: comment.nodeId,
              body: comment.body,
              user: { login: comment.userLogin },
              created_at: comment.createdAt,
            },
            baseHeaders,
          );
          return;
        }
      }
    }
    }

    // /pulls
    if (sub === '/pulls') {
      if (method === 'GET') {
        const sp = getSearchParams();
        const stateFilter = sp.get('state') ?? 'open';
        const filtered = repo.pulls
          .filter((p) => stateFilter === 'all' || p.state === stateFilter)
          .sort((a, b) => b.number - a.number);
        const { pageItems, headers } = paginate(
          filtered.map((p) => formatPull(store, p)),
          sp,
          pathname,
          req.headers.host,
        );
        sendJson(res, 200, pageItems, { ...baseHeaders, ...headers });
        return;
      }
      if (method === 'POST') {
        const body = parseJsonBody(rawBody);
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        const head = typeof body.head === 'string' ? body.head.trim() : '';
        if (!title) throw new HttpError(422, 'Validation Failed: title is required');
        if (!head) throw new HttpError(422, 'Validation Failed: head is required');
        const base = typeof body.base === 'string' && body.base.trim() ? body.base : repo.defaultBranch;
        const prBody = typeof body.body === 'string' ? body.body : '';
        const pull = store.createPull(repo, { title, body: prBody, head, base });
        sendJson(res, 201, formatPull(store, pull), baseHeaders);
        return;
      }
    }

    const pullMatch = sub.match(/^\/pulls\/(\d+)(\/files|\/merge)?$/);
    if (pullMatch) {
      const pullNum = parseInt(pullMatch[1]!, 10);
      const pull = repo.pullsByNumber.get(pullNum);
      if (!pull) throw new HttpError(404, 'Not Found');
      const action = pullMatch[2] ?? '';

      if (action === '' && method === 'GET') {
        sendJson(res, 200, formatPull(store, pull), baseHeaders);
        return;
      }
      if (action === '/files' && method === 'GET') {
        sendJson(res, 200, store.getPullFiles(repo, pull), baseHeaders);
        return;
      }
      if (action === '/merge' && method === 'PUT') {
        const body = parseJsonBody(rawBody);
        const msg = typeof body.commit_message === 'string' ? body.commit_message : undefined;
        const result = store.mergePull(repo, pull, msg);
        sendJson(res, 200, { sha: result.sha, merged: true, message: result.message }, baseHeaders);
        return;
      }
    }

    sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { message: err.message }, baseHeaders);
      return;
    }
    sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' }, baseHeaders);
  }
}
