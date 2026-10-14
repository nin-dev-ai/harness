import { render } from "ink";
import { createElement } from "react";
import { App, type UiExit } from "./App.js";
import { TuiStore, type TuiApi } from "./store.js";
import { Wizard, type WizardResult, type WizardTool } from "./Wizard.js";

export { App, type UiExit } from "./App.js";
export { TuiStore, type TuiApi } from "./store.js";
export { Wizard, suggestScope, type WizardResult, type WizardTool } from "./Wizard.js";
export * from "./format.js";
export * from "./commands.js";
export * from "./theme.js";

export interface RunTuiOptions {
  welcome?: string;
}

/** Render the management panel until the user quits, stops, or attaches. */
export async function runTui(api: TuiApi, o: RunTuiOptions = {}): Promise<UiExit> {
  const store = new TuiStore(api);
  await store.start();
  let result: UiExit = { action: "quit" };
  const app = render(createElement(App, { store, onExit: (r: UiExit) => (result = r), ...(o.welcome ? { welcome: o.welcome } : {}) }), { exitOnCtrlC: false });
  await app.waitUntilExit();
  store.stop();
  return result;
}

/** Run the first-run setup wizard. Resolves with the chosen agents, or null if cancelled. */
export async function runWizard(o: { project: string; tools: WizardTool[]; folders: string[] }): Promise<WizardResult[] | null> {
  let result: WizardResult[] | null = null;
  const app = render(createElement(Wizard, { ...o, onDone: (a: WizardResult[]) => (result = a), onCancel: () => (result = null) }), { exitOnCtrlC: false });
  await app.waitUntilExit();
  return result;
}
