import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  isAncestor,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  peelTag,
  type ForgeStore,
  type GitObject,
  type GitObjectType,
  type RepoRecord,
} from './store.ts';

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
const SHALLOW_PACK_CACHE = new Map<string, Buffer>();
const V2_INFO_REFS_BODY = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('agent=makefun-entry/1.0\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow wait-for-done\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);
const TYPE_NAMES: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};
const TYPE_CODES: Record<GitObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  if (len > 65520) throw new Error('pkt-line exceeds 65520 bytes');
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export interface PktPacket {
  readonly kind: 'flush' | 'delim' | 'end' | 'data';
  readonly data?: Buffer;
}

export function parsePktStream(buf: Buffer): { packets: PktPacket[]; restOffset: number } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) {
      throw new Error('truncated pkt-line header');
    }
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      throw new Error(`invalid pkt-line header: ${hex}`);
    }
    const len = parseInt(hex, 16);
    offset += 4;
    if (len === 0) {
      packets.push({ kind: 'flush' });
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end' });
      continue;
    }
    if (len < 4 || len > 65520) {
      throw new Error(`invalid pkt-line length: ${len}`);
    }
    const payloadLen = len - 4;
    if (offset + payloadLen > buf.length) {
      throw new Error('truncated pkt-line payload');
    }
    packets.push({ kind: 'data', data: buf.subarray(offset, offset + payloadLen) });
    offset += payloadLen;
  }
  return { packets, restOffset: offset };
}

export function parseReceivePackStream(buf: Buffer): { commands: string[]; pack: Buffer } {
  const commands: string[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`invalid pkt-line header: ${hex}`);
    const len = parseInt(hex, 16);
    offset += 4;
    if (len === 0) {
      return { commands, pack: buf.subarray(offset) };
    }
    if (len < 4 || len > 65520 || offset + (len - 4) > buf.length) {
      throw new Error('invalid pkt-line in receive-pack');
    }
    commands.push(buf.subarray(offset, offset + len - 4).toString('utf8'));
    offset += len - 4;
  }
  throw new Error('truncated receive-pack stream: missing flush');
}

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++]!;
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: pos };
    shift += 7;
  }
  throw new Error('truncated varint');
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const src = readVarint(delta, pos);
  pos = src.next;
  if (src.value !== base.length) {
    throw new Error(`delta source size mismatch: expected ${src.value}, got ${base.length}`);
  }
  const dst = readVarint(delta, pos);
  pos = dst.next;
  const out = Buffer.allocUnsafe(dst.value);
  let outPos = 0;

  while (pos < delta.length) {
    const op = delta[pos++]!;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset |= delta[pos++]!;
      if (op & 0x02) copyOffset |= delta[pos++]! << 8;
      if (op & 0x04) copyOffset |= delta[pos++]! << 16;
      if (op & 0x08) copyOffset |= delta[pos++]! << 24;
      if (op & 0x10) copySize |= delta[pos++]!;
      if (op & 0x20) copySize |= delta[pos++]! << 8;
      if (op & 0x40) copySize |= delta[pos++]! << 16;
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, outPos, copyOffset, copyOffset + copySize);
      outPos += copySize;
    } else if (op > 0) {
      delta.copy(out, outPos, pos, pos + op);
      pos += op;
      outPos += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  if (outPos !== dst.value) {
    throw new Error(`delta output size mismatch: expected ${dst.value}, got ${outPos}`);
  }
  return out;
}

export function readPack(
  pack: Buffer,
  existing: ReadonlyMap<string, GitObject>,
): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('packfile too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('invalid pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);

  const expectedChecksum = pack.subarray(pack.length - 20);
  const actualChecksum = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!expectedChecksum.equals(actualChecksum)) throw new Error('pack checksum mismatch');

  const unpacked = new Map<string, GitObject>();
  const byOffset = new Map<number, { oid: string; obj: GitObject }>();
  interface PendingDelta {
    entryOffset: number;
    kind: 6 | 7;
    baseOffset?: number;
    baseOid?: string;
    delta: Buffer;
  }
  const pending: PendingDelta[] = [];

  let offset = 12;
  const endLimit = pack.length - 20;

  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    if (offset >= endLimit) throw new Error('unexpected end of pack');
    let b = pack[offset++]!;
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while ((b & 0x80) !== 0) {
      if (offset >= endLimit) throw new Error('truncated entry header');
      b = pack[offset++]!;
      size += (b & 0x7f) * Math.pow(2, shift);
      shift += 7;
    }

    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      let rel = 0;
      let c = pack[offset++]!;
      rel = c & 0x7f;
      while ((c & 0x80) !== 0) {
        c = pack[offset++]!;
        rel = (rel + 1) * 128 + (c & 0x7f);
      }
      baseOffset = entryOffset - rel;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }

    const inflated = inflateSync(pack.subarray(offset, endLimit), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    offset += inflated.engine.bytesWritten;
    if (inflated.buffer.length !== size) {
      throw new Error(`pack entry size mismatch: expected ${size}, got ${inflated.buffer.length}`);
    }

    if (typeCode >= 1 && typeCode <= 4) {
      const objType = TYPE_NAMES[typeCode]!;
      const oid = hashObject(objType, inflated.buffer);
      const obj: GitObject = { type: objType, data: inflated.buffer };
      unpacked.set(oid, obj);
      byOffset.set(entryOffset, { oid, obj });
    } else if (typeCode === 6 || typeCode === 7) {
      pending.push({
        entryOffset,
        kind: typeCode,
        baseOffset,
        baseOid,
        delta: inflated.buffer,
      });
    } else {
      throw new Error(`unsupported pack object type ${typeCode}`);
    }
  }

  let remaining = pending;
  while (remaining.length > 0) {
    const nextRemaining: PendingDelta[] = [];
    let progressed = false;
    for (const item of remaining) {
      let base: GitObject | undefined;
      if (item.kind === 6 && item.baseOffset !== undefined) {
        base = byOffset.get(item.baseOffset)?.obj;
      } else if (item.kind === 7 && item.baseOid !== undefined) {
        base = unpacked.get(item.baseOid) ?? existing.get(item.baseOid);
      }
      if (!base) {
        nextRemaining.push(item);
        continue;
      }
      const resolvedData = applyDelta(base.data, item.delta);
      const oid = hashObject(base.type, resolvedData);
      const obj: GitObject = { type: base.type, data: resolvedData };
      unpacked.set(oid, obj);
      byOffset.set(item.entryOffset, { oid, obj });
      progressed = true;
    }
    if (!progressed) throw new Error('unresolved delta base in packfile');
    remaining = nextRemaining;
  }

  return unpacked;
}

export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);

  const chunks: Buffer[] = [header];
  for (const obj of objects) {
    const typeCode = TYPE_CODES[obj.type];
    let size = obj.data.length;
    const hdrBytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    size = Math.floor(size / 16);
    if (size > 0) first |= 0x80;
    hdrBytes.push(first);
    while (size > 0) {
      let next = size & 0x7f;
      size = Math.floor(size / 128);
      if (size > 0) next |= 0x80;
      hdrBytes.push(next);
    }
    chunks.push(Buffer.from(hdrBytes));
    chunks.push(deflateSync(obj.data));
  }

  const body = Buffer.concat(chunks);
  const checksum = createHash('sha1').update(body).digest();
  return Buffer.concat([body, checksum]);
}

function sendSidebandPack(pack: Buffer, useSideband: boolean): Buffer {
  if (!useSideband) return pack;
  const chunks: Buffer[] = [];
  const maxChunk = 65514;
  for (let i = 0; i < pack.length; i += maxChunk) {
    const slice = pack.subarray(i, Math.min(i + maxChunk, pack.length));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(chunks);
}

function collectObjectsForFetch(
  repo: RepoRecord,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | undefined,
  deepenRelative = false,
): { objects: GitObject[]; newShallow: string[]; unshallow: string[] } {
  const clientShallowSet = new Set(clientShallow);
  const haveSet = new Set(haves);

  // Mark all objects reachable from non-shallow haves as already held.
  const heldObjects = new Set<string>();
  const markHeldCommitSubtree = (oid: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || heldObjects.has(oid)) return;
    heldObjects.add(oid);
    if (obj.type === 'commit') {
      markHeldTree(parseCommit(obj.data).tree);
    } else if (obj.type === 'tag') {
      markHeldCommitSubtree(parseTag(obj.data).object);
    }
  };
  const markHeldTree = (treeOid: string): void => {
    if (heldObjects.has(treeOid)) return;
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    heldObjects.add(treeOid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000' || entry.mode === '040000') {
        markHeldTree(entry.oid);
      } else {
        heldObjects.add(entry.oid);
      }
    }
  };

  if (depth === undefined) {
    const q = [...haves];
    const seenHaveCommits = new Set<string>();
    while (q.length > 0) {
      const oid = q.pop()!;
      if (seenHaveCommits.has(oid)) continue;
      seenHaveCommits.add(oid);
      markHeldCommitSubtree(oid);
      if (clientShallowSet.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj?.type === 'commit') {
        for (const p of parseCommit(obj.data).parents) {
          if (!seenHaveCommits.has(p)) q.push(p);
        }
      }
    }
  } else {
    for (const h of haves) {
      markHeldCommitSubtree(h);
    }
  }

  // BFS from wants, respecting depth if given.
  const collected = new Map<string, GitObject>();
  const newShallowSet = new Set<string>();
  const visitedCommits = new Set<string>();

  const addObject = (oid: string): void => {
    if (heldObjects.has(oid) || collected.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj) collected.set(oid, obj);
  };

  const addTreeRecursive = (treeOid: string): void => {
    if (heldObjects.has(treeOid) || collected.has(treeOid)) return;
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    collected.set(treeOid, obj);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000' || entry.mode === '040000') {
        addTreeRecursive(entry.oid);
      } else {
        addObject(entry.oid);
      }
    }
  };

  const queue: Array<{ oid: string; dist: number; pastShallow: boolean }> = [];
  for (const w of wants) {
    let cur = w;
    while (true) {
      const obj = repo.objects.get(cur);
      if (!obj) break;
      if (obj.type === 'tag') {
        addObject(cur);
        cur = parseTag(obj.data).object;
        continue;
      }
      if (obj.type === 'commit') {
        const isShallow = deepenRelative && clientShallowSet.has(cur);
        queue.push({ oid: cur, dist: isShallow ? 0 : 1, pastShallow: isShallow });
      }
      break;
    }
  }

  while (queue.length > 0) {
    const { oid, dist, pastShallow } = queue.shift()!;
    if (visitedCommits.has(oid)) continue;
    visitedCommits.add(oid);

    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;

    if (!haveSet.has(oid)) {
      addObject(oid);
      addTreeRecursive(parseCommit(obj.data).tree);
    }

    const commit = parseCommit(obj.data);
    const inShallow = pastShallow || (deepenRelative && clientShallowSet.has(oid));
    const curDist = deepenRelative && !pastShallow && inShallow ? 0 : dist;
    if (depth !== undefined && (!deepenRelative || inShallow || clientShallowSet.size === 0) && curDist >= depth) {
      if (commit.parents.length > 0) {
        newShallowSet.add(oid);
      }
      continue;
    }

    for (const p of commit.parents) {
      if (depth === undefined && heldObjects.has(p)) continue;
      if (!visitedCommits.has(p)) {
        const nextPast = inShallow;
        const nextDist = deepenRelative && !nextPast ? 0 : curDist + 1;
        queue.push({ oid: p, dist: nextDist, pastShallow: nextPast });
      }
    }
  }

  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const s of clientShallowSet) {
      if (visitedCommits.has(s) && !newShallowSet.has(s)) {
        unshallow.push(s);
      }
    }
  }

  return {
    objects: [...collected.values()],
    newShallow: [...newShallowSet],
    unshallow,
  };
}

export function handleGitInfoRefs(
  store: ForgeStore,
  owner: string,
  repoName: string,
  service: string | null,
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId });
    res.end(JSON.stringify({ message: 'Not Found' }));
    return;
  }

  const repo = store.resolveRepo(owner, repoName);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId });
    res.end(JSON.stringify({ message: 'Not Found' }));
    return;
  }

  const gitProto = String(req.headers['git-protocol'] ?? '');
  const isV2 = service === 'git-upload-pack' && gitProto.includes('version=2');

  if (isV2) {
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-advertisement',
      'content-length': V2_INFO_REFS_BODY.length,
      'x-github-request-id': requestId,
    });
    res.end(V2_INFO_REFS_BODY);
    return;
  }

  const chunks: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const sortedRefs = [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  if (service === 'git-upload-pack') {
    const caps = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress include-tag symref=HEAD:refs/heads/${repo.defaultBranch} agent=makefun-entry/1.0`;
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (!headOid && sortedRefs.length === 0) {
      chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      let sentCaps = false;
      if (headOid) {
        chunks.push(pktLine(`${headOid} HEAD\0${caps}\n`));
        sentCaps = true;
      }
      for (const [refName, oid] of sortedRefs) {
        if (!sentCaps) {
          chunks.push(pktLine(`${oid} ${refName}\0${caps}\n`));
          sentCaps = true;
        } else {
          chunks.push(pktLine(`${oid} ${refName}\n`));
        }
        const obj = repo.objects.get(oid);
        if (obj?.type === 'tag') {
          const peeled = peelTag(repo.objects, oid);
          if (peeled) chunks.push(pktLine(`${peeled} ${refName}^{}\n`));
        }
      }
    }
    chunks.push(PKT_FLUSH);
    const body = Buffer.concat(chunks);
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-advertisement',
      'content-length': body.length,
      'x-github-request-id': requestId,
    });
    res.end(body);
    return;
  }

  // git-receive-pack (v0)
  const caps = 'report-status delete-refs side-band-64k ofs-delta atomic agent=makefun-entry/1.0';
  if (sortedRefs.length === 0) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const [refName, oid] of sortedRefs) {
      if (first) {
        chunks.push(pktLine(`${oid} ${refName}\0${caps}\n`));
        first = false;
      } else {
        chunks.push(pktLine(`${oid} ${refName}\n`));
      }
    }
  }
  chunks.push(PKT_FLUSH);
  const body = Buffer.concat(chunks);
  res.writeHead(200, {
    'content-type': 'application/x-git-receive-pack-advertisement',
    'content-length': body.length,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

export function handleGitUploadPack(
  store: ForgeStore,
  owner: string,
  repoName: string,
  req: IncomingMessage,
  rawBody: Buffer,
  res: ServerResponse,
  requestId: string,
): void {
  const repo = store.resolveRepo(owner, repoName);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId });
    res.end(JSON.stringify({ message: 'Not Found' }));
    return;
  }

  let parsed: { packets: PktPacket[] };
  try {
    parsed = parsePktStream(rawBody);
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId });
    res.end(JSON.stringify({ message: err instanceof Error ? err.message : 'Bad pkt-line' }));
    return;
  }

  const gitProto = String(req.headers['git-protocol'] ?? '');
  const isV2 = gitProto.includes('version=2');

  if (isV2) {
    let command = '';
    const args: string[] = [];
    let afterDelim = false;
    for (const pkt of parsed.packets) {
      if (pkt.kind === 'delim') {
        afterDelim = true;
        continue;
      }
      if (pkt.kind !== 'data' || !pkt.data) continue;
      const line = pkt.data.toString('utf8').replace(/\n$/, '');
      if (!afterDelim) {
        if (line.startsWith('command=')) command = line.slice(8);
      } else {
        args.push(line);
      }
    }

    if (command === 'ls-refs') {
      const peel = args.includes('peel');
      const symrefs = args.includes('symrefs');
      const unborn = args.includes('unborn');
      const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice(11));
      const cacheKey = `${peel ? 1 : 0}:${symrefs ? 1 : 0}:${unborn ? 1 : 0}:${prefixes.join('\0')}`;
      const cached = repo.lsRefsCache.get(cacheKey);
      if (cached) {
        res.writeHead(200, {
          'content-type': 'application/x-git-upload-pack-result',
          'content-length': cached.length,
          'x-github-request-id': requestId,
        });
        res.end(cached);
        return;
      }

      const matchesPrefix = (refName: string): boolean =>
        prefixes.length === 0 || prefixes.some((p) => refName.startsWith(p));

      const out: Buffer[] = [];
      const headRef = `refs/heads/${repo.defaultBranch}`;
      const headOid = repo.refs.get(headRef);
      if (matchesPrefix('HEAD')) {
        if (headOid) {
          const sym = symrefs ? ` symref-target:${headRef}` : '';
          out.push(pktLine(`${headOid} HEAD${sym}\n`));
        } else if (unborn) {
          const sym = symrefs ? ` symref-target:${headRef}` : '';
          out.push(pktLine(`unborn HEAD${sym}\n`));
        }
      }
      const sortedRefs = [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      for (const [refName, oid] of sortedRefs) {
        if (!matchesPrefix(refName)) continue;
        let line = `${oid} ${refName}`;
        if (peel) {
          const obj = repo.objects.get(oid);
          if (obj?.type === 'tag') {
            const peeled = peelTag(repo.objects, oid);
            if (peeled) line += ` peeled:${peeled}`;
          }
        }
        out.push(pktLine(`${line}\n`));
      }
      out.push(PKT_FLUSH);
      const body = Buffer.concat(out);
      if (repo.lsRefsCache.size >= 64) repo.lsRefsCache.clear();
      repo.lsRefsCache.set(cacheKey, body);
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-result',
        'content-length': body.length,
        'x-github-request-id': requestId,
      });
      res.end(body);
      return;
    }

    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const clientShallow: string[] = [];
      let depth: number | undefined;
      let deepenRelative = false;
      let done = false;
      let waitForDone = false;

      for (const arg of args) {
        if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) depth = parseInt(arg.slice(7).trim(), 10);
        else if (arg === 'deepen-relative') deepenRelative = true;
        else if (arg === 'done') done = true;
        else if (arg === 'wait-for-done') waitForDone = true;
      }

      let ackPrefix: Buffer[] = [];
      if (!done) {
        const acks = haves.filter((h) => repo.objects.has(h));
        const ackOut: Buffer[] = [pktLine('acknowledgments\n')];
        if (acks.length === 0) {
          ackOut.push(pktLine('NAK\n'));
        } else {
          for (const a of acks) ackOut.push(pktLine(`ACK ${a}\n`));
        }
        const canSendPackNow =
          !waitForDone &&
          (acks.length > 0 || haves.length === 0) &&
          depth === undefined &&
          clientShallow.length === 0;
        if (!canSendPackNow) {
          ackOut.push(PKT_FLUSH);
          const ackBody = Buffer.concat(ackOut);
          res.writeHead(200, {
            'content-type': 'application/x-git-upload-pack-result',
            'content-length': ackBody.length,
            'x-github-request-id': requestId,
          });
          res.end(ackBody);
          return;
        }
        ackOut.push(pktLine('ready\n'));
        ackOut.push(PKT_DELIM);
        ackPrefix = ackOut;
      }

      const useShallowCache =
        ackPrefix.length === 0 &&
        depth === 1 &&
        haves.length === 0 &&
        clientShallow.length === 0 &&
        wants.length === 1;
      const shallowCacheKey = useShallowCache ? `${repo.databaseId}:${wants[0]!}` : '';
      if (useShallowCache) {
        const cached = SHALLOW_PACK_CACHE.get(shallowCacheKey);
        if (cached) {
          res.writeHead(200, {
            'content-type': 'application/x-git-upload-pack-result',
            'content-length': cached.length,
            'x-github-request-id': requestId,
          });
          res.end(cached);
          return;
        }
      }

      const { objects, newShallow, unshallow } = collectObjectsForFetch(
        repo,
        wants,
        haves,
        clientShallow,
        depth,
        deepenRelative,
      );
      const pack = writePack(objects);
      const out: Buffer[] = [...ackPrefix];

      if (depth !== undefined || newShallow.length > 0 || unshallow.length > 0) {
        out.push(pktLine('shallow-info\n'));
        for (const s of newShallow) out.push(pktLine(`shallow ${s}\n`));
        for (const u of unshallow) out.push(pktLine(`unshallow ${u}\n`));
        out.push(PKT_DELIM);
      }
      out.push(pktLine('packfile\n'));
      out.push(sendSidebandPack(pack, true));
      out.push(PKT_FLUSH);

      const body = Buffer.concat(out);
      if (useShallowCache) {
        if (SHALLOW_PACK_CACHE.size >= 64) SHALLOW_PACK_CACHE.clear();
        SHALLOW_PACK_CACHE.set(shallowCacheKey, body);
      }
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-result',
        'content-length': body.length,
        'x-github-request-id': requestId,
      });
      res.end(body);
      return;
    }

    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId });
    res.end(JSON.stringify({ message: `Unsupported upload-pack v2 command: ${command}` }));
    return;
  }

  // Protocol v0 upload-pack
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | undefined;
  let useSideband = false;

  for (const pkt of parsed.packets) {
    if (pkt.kind !== 'data' || !pkt.data) continue;
    const line = pkt.data.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const parts = line.slice(5).trim().split(' ');
      wants.push(parts[0]!);
      if (parts.includes('side-band-64k') || parts.includes('side-band')) {
        useSideband = true;
      }
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      clientShallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      depth = parseInt(line.slice(7).trim(), 10);
    }
  }

  const { objects, newShallow, unshallow } = collectObjectsForFetch(
    repo,
    wants,
    haves,
    clientShallow,
    depth,
  );
  const pack = writePack(objects);
  const out: Buffer[] = [];
  for (const s of newShallow) out.push(pktLine(`shallow ${s}\n`));
  for (const u of unshallow) out.push(pktLine(`unshallow ${u}\n`));
  if (newShallow.length > 0 || unshallow.length > 0) {
    out.push(PKT_FLUSH);
  }
  out.push(pktLine('NAK\n'));
  out.push(sendSidebandPack(pack, useSideband));
  if (useSideband) {
    out.push(PKT_FLUSH);
  }

  const body = Buffer.concat(out);
  res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'content-length': body.length,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

export function handleGitReceivePack(
  store: ForgeStore,
  owner: string,
  repoName: string,
  rawBody: Buffer,
  res: ServerResponse,
  requestId: string,
): void {
  const repo = store.resolveRepo(owner, repoName);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId });
    res.end(JSON.stringify({ message: 'Not Found' }));
    return;
  }

  let commands: string[];
  let pack: Buffer;
  try {
    ({ commands, pack } = parseReceivePackStream(rawBody));
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId });
    res.end(JSON.stringify({ message: err instanceof Error ? err.message : 'Bad receive-pack stream' }));
    return;
  }

  let useSideband = false;
  let isAtomic = false;
  const parsedCmds: Array<{ oldOid: string; newOid: string; refName: string }> = [];
  for (let i = 0; i < commands.length; i += 1) {
    let line = commands[i]!.replace(/\n$/, '');
    if (i === 0) {
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        const caps = line.slice(nul + 1).split(' ');
        if (caps.includes('side-band-64k') || caps.includes('side-band')) {
          useSideband = true;
        }
        if (caps.includes('atomic')) {
          isAtomic = true;
        }
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length >= 3) {
      parsedCmds.push({ oldOid: parts[0]!, newOid: parts[1]!, refName: parts[2]! });
    }
  }

  let unpackLine = 'unpack ok\n';
  let newObjects = new Map<string, GitObject>();
  if (pack.length > 0) {
    try {
      newObjects = readPack(pack, repo.objects);
    } catch (err) {
      unpackLine = `unpack ${err instanceof Error ? err.message : 'error'}\n`;
    }
  }

  const combinedObjects: ReadonlyMap<string, GitObject> =
    newObjects.size === 0
      ? repo.objects
      : ({
          get: (k: string) => newObjects.get(k) ?? repo.objects.get(k),
          has: (k: string) => newObjects.has(k) || repo.objects.has(k),
        } as ReadonlyMap<string, GitObject>);

  const reportLines: Buffer[] = [pktLine(unpackLine)];
  const unpackOk = unpackLine === 'unpack ok\n';

  const cmdResults: Array<{ cmd: { oldOid: string; newOid: string; refName: string }; ok: boolean; reason?: string }> =
    [];
  for (const cmd of parsedCmds) {
    if (!unpackOk) {
      cmdResults.push({ cmd, ok: false, reason: 'unpack failed' });
      continue;
    }
    const currentOid = repo.refs.get(cmd.refName) ?? ZERO_OID;
    if (cmd.newOid === ZERO_OID) {
      if (cmd.oldOid !== ZERO_OID && currentOid !== cmd.oldOid) {
        cmdResults.push({ cmd, ok: false, reason: 'non-fast-forward' });
      } else {
        cmdResults.push({ cmd, ok: true });
      }
      continue;
    }

    if (cmd.oldOid !== currentOid) {
      cmdResults.push({ cmd, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!combinedObjects.has(cmd.newOid)) {
      cmdResults.push({ cmd, ok: false, reason: 'missing object' });
      continue;
    }
    if (currentOid !== ZERO_OID && !isAncestor(combinedObjects, currentOid, cmd.newOid)) {
      cmdResults.push({ cmd, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    cmdResults.push({ cmd, ok: true });
  }

  const atomicAbort = isAtomic && cmdResults.some((r) => !r.ok);
  if (!atomicAbort) {
    if (cmdResults.some((r) => r.ok && r.cmd.newOid !== ZERO_OID)) {
      for (const [oid, obj] of newObjects) {
        repo.objects.set(oid, obj);
      }
    }
    for (const r of cmdResults) {
      if (r.ok) {
        if (r.cmd.newOid === ZERO_OID) {
          repo.refs.delete(r.cmd.refName);
        } else {
          repo.refs.set(r.cmd.refName, r.cmd.newOid);
        }
        repo.lsRefsCache.clear();
        reportLines.push(pktLine(`ok ${r.cmd.refName}\n`));
      } else {
        reportLines.push(pktLine(`ng ${r.cmd.refName} ${r.reason}\n`));
      }
    }
  } else {
    for (const r of cmdResults) {
      const reason = r.ok ? 'atomic push failed' : r.reason;
      reportLines.push(pktLine(`ng ${r.cmd.refName} ${reason}\n`));
    }
  }
  reportLines.push(PKT_FLUSH);

  const reportBuf = Buffer.concat(reportLines);
  const body = useSideband
    ? Buffer.concat([sendSidebandPack(reportBuf, true), PKT_FLUSH])
    : reportBuf;

  res.writeHead(200, {
    'content-type': 'application/x-git-receive-pack-result',
    'content-length': body.length,
    'x-github-request-id': requestId,
  });
  res.end(body);
}
