import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installCspNonce } from "./lib/cspNonce";
import "./styles/globals.css";

// Before the first render, so the first injected <style> already carries it.
installCspNonce();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
