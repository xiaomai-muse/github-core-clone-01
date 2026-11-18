import type { ServerResponse } from 'node:http';
import { sendJson } from './rest.ts';
import { FIXED_ISO, HttpError, type ForgeStore } from './store.ts';

interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, { readonly type: string; readonly description: string }>>;
    readonly required: readonly string[];
  };
}

const MCP_TOOLS: readonly McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get repository metadata by owner and repository name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from head branch into base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolSuccess(data: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
  };
}

function callTool(store: ForgeStore, name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'create_repo') {
    const repoName = typeof args.name === 'string' ? args.name.trim() : '';
    if (!repoName) return toolError('Missing required argument: name');
    const repo = store.createRepo({
      name: repoName,
      description: typeof args.description === 'string' ? args.description : '',
      private: typeof args.private === 'boolean' ? args.private : false,
    });
    const owner = store.getViewerLogin();
    return toolSuccess({
      id: repo.databaseId,
      node_id: repo.nodeId,
      name: repo.name,
      full_name: `${owner}/${repo.name}`,
      private: repo.isPrivate,
      owner: { login: owner },
      description: repo.description,
      default_branch: repo.defaultBranch,
    });
  }

  if (name === 'get_repo') {
    const owner = typeof args.owner === 'string' ? args.owner.trim() : '';
    const repoName = typeof args.repo === 'string' ? args.repo.trim() : '';
    if (!owner || !repoName) return toolError('Missing required argument: owner or repo');
    const repo = store.requireRepo(owner, repoName);
    return toolSuccess({
      id: repo.databaseId,
      node_id: repo.nodeId,
      name: repo.name,
      full_name: `${owner}/${repo.name}`,
      private: repo.isPrivate,
      owner: { login: owner },
      description: repo.description,
      default_branch: repo.defaultBranch,
    });
  }

  if (name === 'create_issue') {
    const owner = typeof args.owner === 'string' ? args.owner.trim() : '';
    const repoName = typeof args.repo === 'string' ? args.repo.trim() : '';
    const title = typeof args.title === 'string' ? args.title : '';
    if (!owner || !repoName || !title) {
      return toolError('Missing required argument: owner, repo, or title');
    }
    const repo = store.requireRepo(owner, repoName);
    const issue = store.createIssue(repo, {
      title,
      body: typeof args.body === 'string' ? args.body : '',
    });
    return toolSuccess({
      id: issue.id,
      node_id: issue.nodeId,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      created_at: FIXED_ISO,
    });
  }

  if (name === 'list_issues') {
    const owner = typeof args.owner === 'string' ? args.owner.trim() : '';
    const repoName = typeof args.repo === 'string' ? args.repo.trim() : '';
    if (!owner || !repoName) return toolError('Missing required argument: owner or repo');
    const repo = store.requireRepo(owner, repoName);
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = repo.issues
      .filter((i) => state === 'all' || i.state === state)
      .map((i) => ({
        id: i.id,
        number: i.number,
        title: i.title,
        body: i.body,
        state: i.state,
      }));
    return toolSuccess(list);
  }

  if (name === 'create_pull_request') {
    const owner = typeof args.owner === 'string' ? args.owner.trim() : '';
    const repoName = typeof args.repo === 'string' ? args.repo.trim() : '';
    const title = typeof args.title === 'string' ? args.title : '';
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : '';
    if (!owner || !repoName || !title || !head || !base) {
      return toolError('Missing required argument: owner, repo, title, head, or base');
    }
    const repo = store.requireRepo(owner, repoName);
    const pull = store.createPull(repo, {
      title,
      body: typeof args.body === 'string' ? args.body : '',
      head,
      base,
    });
    return toolSuccess({
      id: pull.id,
      number: pull.number,
      state: pull.state,
      title: pull.title,
      head: { ref: pull.headRef, sha: pull.headSha },
      base: { ref: pull.baseRef, sha: pull.baseSha },
    });
  }

  if (name === 'merge_pull_request') {
    const owner = typeof args.owner === 'string' ? args.owner.trim() : '';
    const repoName = typeof args.repo === 'string' ? args.repo.trim() : '';
    const pullNumber = Number(args.pull_number);
    if (!owner || !repoName || !Number.isFinite(pullNumber)) {
      return toolError('Missing required argument: owner, repo, or pull_number');
    }
    const repo = store.requireRepo(owner, repoName);
    const pull = repo.pullsByNumber.get(pullNumber);
    if (!pull) return toolError(`Pull request #${pullNumber} not found`);
    const result = store.mergePull(repo, pull);
    return toolSuccess({ sha: result.sha, merged: true, message: result.message });
  }

  throw new HttpError(404, `Unknown tool: ${name}`);
}

export function handleMcpRequest(
  store: ForgeStore,
  method: string,
  rawBody: Buffer,
  res: ServerResponse,
  requestId: string,
): void {
  const headers: Record<string, string> = {
    'x-github-request-id': requestId,
    'mcp-session-id': 'session-1',
  };

  if (method === 'DELETE') {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' }, headers);
    return;
  }

  let rpc: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      sendJson(
        res,
        400,
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
        headers,
      );
      return;
    }
    rpc = parsed as Record<string, unknown>;
  } catch {
    sendJson(
      res,
      400,
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      headers,
    );
    return;
  }

  const id = rpc.id ?? null;
  const rpcMethod = typeof rpc.method === 'string' ? rpc.method : '';
  const params =
    rpc.params && typeof rpc.params === 'object' && !Array.isArray(rpc.params)
      ? (rpc.params as Record<string, unknown>)
      : {};

  // Notifications have no id
  if (rpc.id === undefined) {
    res.writeHead(202, headers);
    res.end();
    return;
  }

  if (rpcMethod === 'server/discover') {
    sendJson(
      res,
      200,
      {
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: ['2026-07-28', '2025-11-25'],
          protocolVersion: '2026-07-28',
          serverInfo: { name: 'makefun-forge-mcp', version: '1.0.0' },
          capabilities: { tools: { listChanged: false } },
          _meta: {
            'io.modelcontextprotocol/serverInfo': { name: 'makefun-forge-mcp', version: '1.0.0' },
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          },
        },
      },
      headers,
    );
    return;
  }

  if (rpcMethod === 'initialize') {
    sendJson(
      res,
      200,
      {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-11-25',
          serverInfo: { name: 'makefun-forge-mcp', version: '1.0.0' },
          capabilities: { tools: { listChanged: false } },
        },
      },
      headers,
    );
    return;
  }

  if (rpcMethod === 'tools/list') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } }, headers);
    return;
  }

  if (rpcMethod === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const toolArgs =
      params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    const known = MCP_TOOLS.some((t) => t.name === toolName);
    if (!known) {
      sendJson(
        res,
        200,
        { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } },
        headers,
      );
      return;
    }
    try {
      const result = callTool(store, toolName, toolArgs);
      sendJson(res, 200, { jsonrpc: '2.0', id, result }, headers);
    } catch (err) {
      sendJson(
        res,
        200,
        {
          jsonrpc: '2.0',
          id,
          result: toolError(err instanceof Error ? err.message : 'Tool execution error'),
        },
        headers,
      );
    }
    return;
  }

  sendJson(
    res,
    200,
    { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${rpcMethod}` } },
    headers,
  );
}
