import fs from "node:fs";
import path from "node:path";
import { render } from "ink";
import { createElement } from "react";
import { App, type UiExit } from "./App.js";
import { TuiStore, type TuiApi } from "./store.js";

export { App, type UiExit } from "./App.js";
export { TuiStore, type TuiApi } from "./store.js";
export * from "./format.js";
export * from "./commands.js";
export * from "./theme.js";

export interface RunTuiOptions {
  /** Where to remember UI preferences (the theme). */
  prefsFile?: string;
  welcome?: string;
}

function readPrefs(file?: string): { theme?: string } {
  try {
    return file ? (JSON.parse(fs.readFileSync(file, "utf8")) as { theme?: string }) : {};
  } catch {
    return {};
  }
}

/** Render the full-screen UI until the user quits, stops, or attaches. */
export async function runTui(api: TuiApi, o: RunTuiOptions = {}): Promise<UiExit> {
  const store = new TuiStore(api);
  await store.start();
  let result: UiExit = { action: "quit" };
  const prefs = readPrefs(o.prefsFile);
  const app = render(
    createElement(App, {
      store,
      onExit: (r: UiExit) => (result = r),
      ...(prefs.theme ? { theme: prefs.theme } : {}),
      ...(o.welcome ? { welcome: o.welcome } : {}),
      onTheme: (name: string) => {
        if (!o.prefsFile) return;
        try {
          fs.mkdirSync(path.dirname(o.prefsFile), { recursive: true });
          fs.writeFileSync(o.prefsFile, JSON.stringify({ ...readPrefs(o.prefsFile), theme: name }));
        } catch {
          // preferences are a convenience
        }
      },
    }),
    { exitOnCtrlC: false },
  );
  await app.waitUntilExit();
  store.stop();
  return result;
}
