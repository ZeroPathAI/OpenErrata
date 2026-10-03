import { mount } from "svelte";
import { requireMountTarget } from "../lib/page-bootstrap";
import App from "./App.svelte";

// The page stylesheet link is verified at build time (vite.config.ts).
const root = requireMountTarget({ pageLabel: "options" });

const app = mount(App, { target: root });

export default app;
