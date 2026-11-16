/** A static single-page app built with Vite: no server, no datastore. */
export const viteSpa: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "marketing-site",
      version: "0.1.0",
      scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
      dependencies: { react: "18.3.0", "react-dom": "18.3.0" },
      devDependencies: { vite: "5.2.0", "@vitejs/plugin-react": "4.2.0" },
    },
    null,
    2
  ),
  "package-lock.json": "{}",
  "index.html": '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n',
  "vite.config.ts": 'import { defineConfig } from "vite";\nexport default defineConfig({});\n',
  "src/main.tsx": "const api = import.meta.env.VITE_API_URL;\nconsole.log(api);\n",
};
