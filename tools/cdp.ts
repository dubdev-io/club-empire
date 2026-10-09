/**
 * A minimal Chrome DevTools Protocol client, shared by the tools that need a
 * real browser: `screenshots.ts`, `contrast.ts` and `boot-progress.ts`.
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

/**
 * How long a single CDP call may take before it is treated as hung.
 *
 * Raised by `boot-progress.ts`, which drives the page at up to 20x CPU
 * throttling: a `Page.navigate` there can outlast a budget that is generous for
 * an unthrottled tool.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

export class Cdp {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly timeoutMs: number;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  private constructor(socket: WebSocket, timeoutMs: number) {
    this.timeoutMs = timeoutMs;
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

  static async connect(wsUrl: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<Cdp> {
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`cannot connect to ${wsUrl}`)), {
        once: true,
      });
    });
    return new Cdp(socket, timeoutMs);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      // CDP has no timeout of its own, and a hung call here would hang the
      // whole script with no indication of which step stalled.
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, this.timeoutMs);
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
