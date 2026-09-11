/**
 * Entry point. Mounts the app into the shell served by index.html and nothing
 * else: no service worker, no analytics, no third-party script.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import "./styles.css";

const host = document.getElementById("root");

if (host) {
  createRoot(host).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
