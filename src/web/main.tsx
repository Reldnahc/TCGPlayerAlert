import { render } from "preact";
import { App } from "./App.js";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/components.css";
import "./styles/pages.css";

const root = document.querySelector("#app");
if (root === null) throw new Error("The application mount point is missing.");
render(<App />, root);
