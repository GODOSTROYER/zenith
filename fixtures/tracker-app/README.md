# Equipment requests

A small private tracker for the equipment a team asks for: who asked, what for,
how many, how urgent, and where the request has got to. One list, one form, one
detail drawer. No accounts to manage, no inbox to chase.

## What it talks to

The app is a plain React frontend. It holds no credentials and knows no
database. Everything it reads and writes goes through the reserved same-origin
paths its host reserves for it:

| Path | Use |
| --- | --- |
| `GET /_zenith/session` | who is signed in, their role, the running release |
| `GET /_zenith/data/v1/requests` | the list, filtered and paged with a cursor |
| `GET /_zenith/data/v1/requests/:id` | one request |
| `POST /_zenith/data/v1/requests` | create, with a `writeId` so a retry cannot duplicate |
| `PATCH /_zenith/data/v1/requests/:id` | update, with `expectedVersion` so a stale edit is refused |
| `POST /_zenith/auth/signout` | end the session |

The session is an HttpOnly cookie the browser attaches on its own; requests go
out with `credentials: "same-origin"` and nothing else. There are no third-party
requests, no CDN, no external fonts and no analytics. The record shape, its
limits and the conflict payload are the host's tracker data contract v1; the
client mirrors them in `src/api.ts`.

Roles come from the host, not from this code. A viewer sees everything and is
offered nothing to change; an owner or editor can create and update. The server
enforces that either way — hiding a button is a courtesy, not a control.

## How it is built

Zenith builds this package with its own pinned recipe (Vite 7 + React 19). That
is why there is no `vite.config.*`, no `tsconfig.json`, no lockfile, no
`scripts` block and no devDependencies here: nothing in this directory is
executed at build time, only compiled. The package is `index.html`,
`package.json`, `zenith.app.json`, this README, `src/` and `public/`.

## Layout

```
index.html          shell: #root and the module entry
public/favicon.svg  the only static asset
src/main.tsx        mounts the app
src/app.tsx         the screen: list, filters, form, drawer, footer
src/api.ts          the tracker v1 client (write ids, retries, typed errors)
src/state.ts        pure logic: drafts, validation, diffing, error -> state
src/use-tracker.ts  the React hook that owns loading, paging and saving
src/components/     presentational pieces
src/styles.css      tokens, light and dark, one stylesheet
```
