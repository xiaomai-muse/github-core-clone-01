import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGitInfoRefs, handleGitReceivePack, handleGitUploadPack } from './git.ts';
import { handleGraphqlRequest } from './graphql.ts';
import { handleMcpRequest } from './mcp.ts';
import { handleRestRequest, sendJson } from './rest.ts';
import { ForgeStore } from './store.ts';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let first: Buffer | null = null;
    let chunks: Buffer[] | null = null;
    req.on('data', (chunk: Buffer) => {
      if (first === null) {
        first = chunk;
      } else if (chunks === null) {
        chunks = [first, chunk];
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (chunks !== null) resolve(Buffer.concat(chunks));
      else if (first !== null) resolve(first);
      else resolve(Buffer.alloc(0));
    });
    req.on('error', reject);
  });
}

function getQueryParam(rawUrl: string, qIdx: number, key: string): string | null {
  if (qIdx === -1) return null;
  return new URLSearchParams(rawUrl.slice(qIdx + 1)).get(key);
}

function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  if (!expectedToken) return true;
  const auth = req.headers['authorization'];
  if (typeof auth !== 'string') return false;
  return auth === `Bearer ${expectedToken}`;
}

export function createApp(): Server {
  const store = new ForgeStore();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    req.socket?.setNoDelay(true);
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const qIdx = rawUrl.indexOf('?');
    const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
    const requestId = store.nextRequestId();

    if (method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true }, { 'x-github-request-id': requestId });
      return;
    }

    if (!isAuthorized(req, expectedToken)) {
      sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': requestId });
      return;
    }

    let rawBody: Buffer;
    if (method === 'GET' || method === 'HEAD') {
      rawBody = Buffer.alloc(0);
    } else {
      try {
        rawBody = await readBody(req);
      } catch {
        sendJson(res, 400, { message: 'Failed to read request body' }, { 'x-github-request-id': requestId });
        return;
      }
    }

    if (pathname.startsWith('/api/v3/') || pathname === '/api/v3') {
      handleRestRequest(store, method, pathname, qIdx === -1 ? '' : rawUrl.slice(qIdx + 1), rawBody, req, res, requestId);
      return;
    }

    if (pathname === '/api/graphql' && method === 'POST') {
      handleGraphqlRequest(store, rawBody, res, requestId);
      return;
    }

    if (pathname === '/mcp') {
      handleMcpRequest(store, method, rawBody, res, requestId);
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/(info/refs|git-upload-pack|git-receive-pack)
    if (
      pathname.endsWith('/info/refs') ||
      pathname.endsWith('/git-upload-pack') ||
      pathname.endsWith('/git-receive-pack')
    ) {
      const gitMatch = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1]!);
        const repoName = decodeURIComponent(gitMatch[2]!);
        const action = gitMatch[3]!;
        if (action === 'info/refs' && method === 'GET') {
          handleGitInfoRefs(store, owner, repoName, getQueryParam(rawUrl, qIdx, 'service'), req, res, requestId);
          return;
        }
        if (action === 'git-upload-pack' && method === 'POST') {
          handleGitUploadPack(store, owner, repoName, req, rawBody, res, requestId);
          return;
        }
        if (action === 'git-receive-pack' && method === 'POST') {
          handleGitReceivePack(store, owner, repoName, rawBody, res, requestId);
          return;
        }
      }
    }

    sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
  });

  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  return server;
}
