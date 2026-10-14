/** Where command output goes. Tests capture it; the binary writes to the terminal. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Ask the user a question (interactive confirmations). */
  prompt?(question: string): Promise<string>;
  color: boolean;
}

export const EXIT = { ok: 0, failed: 1, usage: 2, unreachable: 3 } as const;

/** Exit with a code and message. */
export class CliExit extends Error {
  constructor(
    readonly code: number,
    message = "",
  ) {
    super(message);
  }
}

export function processIo(): Io {
  return {
    out: (t) => process.stdout.write(t.endsWith("\n") ? t : `${t}\n`),
    err: (t) => process.stderr.write(t.endsWith("\n") ? t : `${t}\n`),
    env: process.env,
    cwd: process.cwd(),
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    prompt: async (q) => {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(q);
      } finally {
        rl.close();
      }
    },
  };
}
