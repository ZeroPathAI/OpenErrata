import { mount } from "svelte";
import { ensurePageStylesheet, requireMountTarget } from "../lib/page-bootstrap";
import App from "./App.svelte";

ensurePageStylesheet({
  pageLabel: "options",
  stylesheetAsset: "index2.css",
});
const optionsRoot = requireMountTarget({
  pageLabel: "options",
});

const app = mount(App, { target: optionsRoot });

export default app;
