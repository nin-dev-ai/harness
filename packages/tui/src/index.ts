import { render } from "ink";
import { createElement } from "react";
import { App, type UiExit } from "./App.js";
import { TuiStore, type TuiApi } from "./store.js";

export { App, type UiExit } from "./App.js";
export { TuiStore, type TuiApi } from "./store.js";
export * from "./format.js";
export { UsageBar } from "./components/UsageBar.js";
export { Workers } from "./components/Workers.js";
export { Tasks } from "./components/Tasks.js";
export { Output } from "./components/Output.js";
export { Footer } from "./components/Footer.js";
export { ReviewView } from "./components/ReviewView.js";
export { LimitsEditor } from "./components/LimitsEditor.js";
export { Help } from "./components/Help.js";

/** Render the full-screen UI until the user quits, stops, or attaches. */
export async function runTui(api: TuiApi): Promise<UiExit> {
  const store = new TuiStore(api);
  await store.start();
  let result: UiExit = { action: "quit" };
  const app = render(createElement(App, { store, onExit: (r: UiExit) => (result = r) }), { exitOnCtrlC: true });
  await app.waitUntilExit();
  store.stop();
  return result;
}
