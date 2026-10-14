import type { Ctx } from "./ctx.js";
import { formatStatus } from "./format.js";
import { openProject } from "./commands/_client.js";
import type { StatusSnapshot } from "@harness/daemon";

/** Open the terminal UI. Until M13 lands this prints the status once. */
export async function openUi(ctx: Ctx): Promise<void> {
  const sess = await openProject(ctx.io, ctx.dir());
  try {
    ctx.print(formatStatus(await sess.call<StatusSnapshot>("status"), ctx.s()));
  } finally {
    sess.close();
  }
}
