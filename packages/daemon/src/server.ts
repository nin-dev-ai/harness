import fs from "node:fs";
import net from "node:net";
import { createInterface } from "node:readline";
import { HarnessError, RpcRequestSchema, type HarnessEvent } from "@harness/core";

export type RpcHandler = (params: unknown, ctx: RpcContext) => Promise<unknown> | unknown;

export interface RpcContext {
  /** Push events to this connection until it closes. Returns an unsubscribe function. */
  subscribe(filter: (e: HarnessEvent) => boolean, backlog: HarnessEvent[]): () => void;
  /** True if the client says a person is attached (UI open or command run by hand). */
  attended: boolean;
}

export type EventSource = (listener: (e: HarnessEvent) => void) => () => void;

/**
 * JSON-RPC over a Unix socket: one JSON object per line. Requests carry an id
 * and get exactly one response. Subscriptions push `{notify:"event"}` lines.
 */
export class RpcServer {
  private server: net.Server;
  private conns = new Set<net.Socket>();

  constructor(
    private handlers: Record<string, RpcHandler>,
    private events: EventSource,
  ) {
    this.server = net.createServer((sock) => this.onConnection(sock));
  }

  listen(sockPath: string): Promise<void> {
    if (fs.existsSync(sockPath)) fs.rmSync(sockPath, { force: true });
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(sockPath, () => {
        fs.chmodSync(sockPath, 0o600);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    for (const c of this.conns) c.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  connectionCount(): number {
    return this.conns.size;
  }

  private onConnection(sock: net.Socket): void {
    this.conns.add(sock);
    const unsubs: (() => void)[] = [];
    const send = (obj: unknown) => {
      if (!sock.destroyed) sock.write(JSON.stringify(obj) + "\n");
    };
    sock.on("close", () => {
      this.conns.delete(sock);
      for (const u of unsubs.splice(0)) u();
    });
    sock.on("error", () => sock.destroy());
    const rl = createInterface({ input: sock, crlfDelay: Infinity });
    rl.on("line", async (line) => {
      let id = -1;
      try {
        const req = RpcRequestSchema.parse(JSON.parse(line));
        id = req.id;
        const handler = this.handlers[req.method];
        if (!handler) throw new HarnessError("NOT_FOUND", `unknown method ${req.method}`);
        const attended = Boolean((req.params as { attended?: boolean } | undefined)?.attended);
        const ctx: RpcContext = {
          attended,
          subscribe: (filter, backlog) => {
            for (const e of backlog) if (filter(e)) send({ notify: "event", event: e });
            const off = this.events((e) => {
              if (filter(e)) send({ notify: "event", event: e });
            });
            unsubs.push(off);
            return off;
          },
        };
        const result = await handler(req.params, ctx);
        send({ id, ok: true, result: result ?? null });
      } catch (e) {
        const err = e as Error & { code?: string; details?: unknown };
        send({ id, ok: false, error: { code: err.code ?? "INTERNAL", message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } });
      }
    });
  }
}
