/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import "./styles.css";
import "./lib/scroll-fade.css";
import "./lib/settings.css";

render(() => <App />, document.getElementById("root")!);
