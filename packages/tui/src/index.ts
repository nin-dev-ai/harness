import fs from "node:fs";
import path from "node:path";
import { render } from "ink";
import { createElement } from "react";
import { App, type UiExit } from "./App.js";
import { TuiStore, type TuiApi } from "./store.js";
import { withAlternateScreen } from "./terminal.js";
import { Wizard, type WizardResult, type WizardTool } from "./Wizard.js";

export { App, type UiExit } from "./App.js";
export { TuiStore, type TuiApi } from "./store.js";
export { Wizard, suggestScope, type WizardResult, type WizardTool } from "./Wizard.js";
export * from "./format.js";
export * from "./commands.js";
export * from "./theme.js";

export interface RunTuiOptions {
  welcome?: string;
  /** Where to remember the chosen theme. */
  prefsFile?: string;
  version?: string;
  openWindows?(agents: string[]): Promise<{ opened: string[]; manual: string[] }>;
}

function readPrefs(file?: string): { theme?: string } {
  try {
    return file ? (JSON.parse(fs.readFileSync(file, "utf8")) as { theme?: string }) : {};
  } catch {
    return {};
  }
}

/** Render the management panel until the user quits, stops, or attaches. */
export async function runTui(api: TuiApi, o: RunTuiOptions = {}): Promise<UiExit> {
  const store = new TuiStore(api);
  await store.start();
  let result: UiExit = { action: "quit" };
  const prefs = readPrefs(o.prefsFile);
  return withAlternateScreen(process.stdout, async () => {
    try {
      const app = render(
        createElement(App, {
          store,
          onExit: (r: UiExit) => (result = r),
          ...(prefs.theme ? { theme: prefs.theme } : {}),
          ...(o.welcome ? { welcome: o.welcome } : {}),
          ...(o.version ? { version: o.version } : {}),
          ...(o.openWindows ? { openWindows: o.openWindows } : {}),
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
      return result;
    } finally {
      store.stop();
    }
  });
}

/** Run the first-run setup wizard. Resolves with the chosen agents, or null if cancelled. */
export async function runWizard(o: { project: string; tools: WizardTool[]; folders: string[] }): Promise<WizardResult[] | null> {
  let result: WizardResult[] | null = null;
  return withAlternateScreen(process.stdout, async () => {
    const app = render(createElement(Wizard, { ...o, onDone: (a: WizardResult[]) => (result = a), onCancel: () => (result = null) }), { exitOnCtrlC: false });
    await app.waitUntilExit();
    return result;
  });
}
