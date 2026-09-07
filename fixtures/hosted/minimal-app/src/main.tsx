import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return <main className="app">Minimal app OK</main>;
}

const host = document.getElementById("root");
if (!host) throw new Error("index.html must contain <div id=\"root\"></div>.");

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>
);
