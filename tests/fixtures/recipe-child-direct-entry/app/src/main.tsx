import React from "react";
import { createRoot } from "react-dom/client";

function App() {
  return <main>Direct worker entry fixture</main>;
}

createRoot(document.getElementById("root")!).render(<App />);
