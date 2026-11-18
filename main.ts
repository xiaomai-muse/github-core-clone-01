import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl.length === 0) {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is unset; exiting.\n');
  process.exit(1);
}

const REQ_TIMEOUT_MS = 30_000;
const MIN_DELAY_MS = 100;
const MAX_DELAY_MS = 1_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(MAX_DELAY_MS, MIN_DELAY_MS * Math.pow(2, Math.min(attempt, 8)));
}

async function registerPort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) {
        return;
      }
      if (response.status === 400 || response.status === 405) {
        const body = await response.text();
        throw new Error(`register rejected with ${response.status}: ${body}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register rejected with ')) {
        throw err;
      }
    }
    await pause(backoffMs(attempt));
  }
}

async function pollUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/done`, {
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      });
      if (response.ok) {
        const data = (await response.json()) as { done?: unknown };
        if (data.done === true) {
          return;
        }
      }
    } catch {
      // Retry on transient error or timeout.
    }
    await pause(backoffMs(attempt));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('Failed to obtain TCP port from server.address()');
  }

  process.stdout.write(`[entry] bound port ${addr.port}\n`);
  await registerPort(addr.port);
  process.stdout.write('[entry] registered with env\n');

  await pollUntilDone();
  server.close();
  process.stdout.write('[entry] env signalled done, exiting\n');
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`[entry] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
