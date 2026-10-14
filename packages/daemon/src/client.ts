import net from "node:net";
import { createInterface } from "node:readline";
import { HarnessError, RpcMessageSchema, type HarnessEvent } from "@harness/core";

/** Thrown when the daemon cannot be reached (CLI exit code 3). */
export class DaemonUnreachableError extends HarnessError {
  constructor(sock: string, cause?: string) {
    super("DAEMON_UNREACHABLE", `daemon not reachable at ${sock}${cause ? `: ${cause}` : ""}`);
  }
}

/** An error the daemon returned for a request. */
export class RpcCallError extends HarnessError {}

/** Client for the daemon socket. Used by the CLI and the terminal UI; holds no state. */
export class DaemonClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(e: HarnessEvent) => void>();
  private closed = false;

  private constructor(private sock: net.Socket) {
    const rl = createInterface({ input: sock, crlfDelay: Infinity });
    rl.on("line", (line) => this.onLine(line));
    sock.on("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new DaemonUnreachableError("socket", "connection closed"));
      this.pending.clear();
    });
    sock.on("error", () => undefined);
  }

  static connect(sockPath: string, timeoutMs = 2000): Promise<DaemonClient> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(sockPath);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new DaemonUnreachableError(sockPath, "timeout"));
      }, timeoutMs);
      sock.once("connect", () => {
        clearTimeout(timer);
        resolve(new DaemonClient(sock));
      });
      sock.once("error", (e) => {
        clearTimeout(timer);
        reject(new DaemonUnreachableError(sockPath, (e as NodeJS.ErrnoException).code));
      });
    });
  }

  private onLine(line: string): void {
    let msg;
    try {
      msg = RpcMessageSchema.parse(JSON.parse(line));
    } catch {
      return;
    }
    if ("notify" in msg) {
      for (const l of this.listeners) l(msg.event as HarnessEvent);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else {
      const err = new RpcCallError("INTERNAL", msg.error.message, msg.error.details as Record<string, unknown> | undefined);
      (err as { code: string }).code = msg.error.code;
      p.reject(err);
    }
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new DaemonUnreachableError("socket", "closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.sock.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  /** Receive pushed events (after calling a subscribe method). */
  onEvent(listener: (e: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.sock.end();
    this.sock.destroy();
  }
}
