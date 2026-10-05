/**
 * A minimal Chrome DevTools Protocol client, shared by the tools that need a
 * real browser: `screenshots.ts` and `contrast.ts`.
 *
 * No new dependency. Node 24 has a global `WebSocket`, and CDP is a JSON
 * protocol over it. A `puppeteer` install is not worth it in a repo whose whole
 * point is a small reproducible build, and the brief is explicit about not
 * adding dependencies casually.
 *
 * Extracted from `screenshots.ts` when the contrast probe needed the same
 * client. Two copies of this would be one copy too many.
 */

export const CDP_URL = process.env.CLUB_CDP ?? 'http://127.0.0.1:9222';

interface CdpTarget {
  webSocketDebuggerUrl: string;
  type: string;
  url: string;
}

export class Cdp {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String((event as MessageEvent).data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      if (waiter === undefined) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  static async connect(wsUrl: string): Promise<Cdp> {
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`cannot connect to ${wsUrl}`)), {
        once: true,
      });
    });
    return new Cdp(socket);
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<T> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      // CDP has no timeout of its own, and a hung call here would hang the
      // whole script with no indication of which step stalled. Callers that
      // mean to retry pass a shorter one: waiting the full 30 s before the
      // first retry of a stalled `Page.captureScreenshot` is its own hang.
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
    });
  }

  /** Evaluate in the page and return the JSON-serialised result. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send<{
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    }
    return result.result.value as T;
  }

  close(): void {
    this.socket.close();
  }
}

/** The debugger URL of the first page target, for `Cdp.connect`. */
export async function pageTarget(debugUrl: string = CDP_URL): Promise<string> {
  const response = await fetch(`${debugUrl}/json/list`);
  const targets = (await response.json()) as CdpTarget[];
  const page = targets.find((t) => t.type === 'page');
  if (page === undefined) {
    throw new Error('no page target; is Chrome running with --remote-debugging-port?');
  }
  return page.webSocketDebuggerUrl;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The sentinel `navigate` stamps on the outgoing document. */
const NAV_AWAY = '__clubNavAway';

/**
 * Navigate, and do not return until the **new** document is the one answering.
 *
 * `Page.navigate` resolves when the navigation has been *started*, not when the
 * old document has gone. Anything polled in the gap is answered by the page we
 * are leaving, and a readiness predicate like `window.__club !== undefined` is
 * perfectly happy to be satisfied by the previous scene's booted game. The
 * driving script then runs against a document that is about to be destroyed,
 * and the measurement that follows lands on a page that was never set up —
 * which is how DUB-54's contrast run clipped the row below the badge and
 * reported 1.00:1 on an 11.68:1 probe.
 *
 * So stamp the outgoing document first. A new document gets a new `window`,
 * so the absence of the stamp is proof the swap has happened — no event
 * subscription, no guessed sleep.
 */
export async function navigate(cdp: Cdp, url: string, timeoutMs = 15_000): Promise<void> {
  // A fresh target has no document worth stamping yet; that is not an error.
  await cdp.evaluate(`window[${JSON.stringify(NAV_AWAY)}] = true; return true;`).catch(() => null);

  const result = await cdp.send<{ errorText?: string }>('Page.navigate', { url });
  if (result.errorText !== undefined) {
    throw new Error(`navigation to ${url} failed: ${result.errorText}`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // During the swap the execution context is gone and this throws. That is
    // the barrier doing its job, so keep waiting rather than reporting ready.
    const fresh = await cdp
      .evaluate<boolean>(`return window[${JSON.stringify(NAV_AWAY)}] !== true;`)
      .catch(() => false);
    if (fresh) return;
    await sleep(50);
  }
  throw new Error(`navigation to ${url} did not replace the document within ${timeoutMs} ms`);
}

/**
 * Retry a CDP call that can stall rather than fail.
 *
 * `Page.captureScreenshot` on a page with a live WebGL canvas occasionally
 * never answers: the compositor is waiting on a frame that the canvas has not
 * produced. There is nothing to fix on our side and nothing wrong with the
 * page — the next request goes through. Without this the whole run dies on one
 * stalled frame, which is the second half of DUB-54.
 */
export async function retry<T>(
  what: string,
  attempt: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await attempt();
    } catch (error) {
      last = error;
      if (i < attempts) {
        console.warn(`  ${what} attempt ${i}/${attempts} failed (${String(error)}), retrying`);
        await sleep(250 * i);
      }
    }
  }
  throw last instanceof Error ? last : new Error(`${what} failed: ${String(last)}`);
}
