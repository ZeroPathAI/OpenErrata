import { mount } from "svelte";
import { ensurePageStylesheet, requireMountTarget } from "../lib/page-bootstrap";
import App from "./App.svelte";

ensurePageStylesheet({
  pageLabel: "popup",
  stylesheetAsset: "index.css",
});
const popupRoot = requireMountTarget({
  pageLabel: "popup",
});

const app = mount(App, { target: popupRoot });

export default app;
