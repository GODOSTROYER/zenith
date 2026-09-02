# components/landing — the marketing surface

`landing.tsx` is the page body, `hero-canvas.tsx` the one authored moment,
`cta.tsx` the closers. Rendered only by `src/app/page.tsx`.

This is the one place allowed to depart from the product type scale — see the
landing scale in `docs/DESIGN.md`. It deliberately does not use the product
kit everywhere (its copy button and pill tabs are its own), so do not "unify"
those into `ui/` without a visual review. Nothing in the product may import
from here.
