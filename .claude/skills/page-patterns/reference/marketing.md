# Marketing pages

Public marketing is **not** a product page pattern. Name a **route type**, then stack sections. Do not force Pattern 4 (Dashboard) onto a landing page.

Auth is **Pattern 3 — Form (auth)**. Do not compose marketing sections around login.

## Route types

| Route | Job | Typical stack |
| --- | --- | --- |
| Home / landing | Explain and convert | Nav → hero → logo cloud → features or bento → proof → pricing → FAQ → CTA → footer |
| About | Tell the story | Nav → story hero + stats → values → team → CTA → footer |
| Contact | Let people reach you | Nav → short form or info cards → optional FAQ → footer |
| Pricing | Pick a plan | Nav → plan cards + billing toggle → FAQ → CTA → footer |
| Blog index | Find an article | Nav → title → filters/search → card grid → pagination → footer |
| Blog post | Read one article | Nav → article column (65–75ch) → related → footer |
| Portfolio index | Browse work | Nav → filters → visual card grid → footer |
| Case study | Tell one project | Nav → metadata + gallery → story → related → footer |
| Product listing | Shop a category | Nav → title → filters → product cards → pagination → footer |
| Compare | Choose between options | Nav → comparison table → CTA → footer |
| Changelog | Read releases | Nav → vertical timeline → footer |

A single block (hero, FAQ, logo cloud) is a **section**, not a page. A real route is nav + one or more sections + footer.

## Section jobs

| Section | Job | Do not |
| --- | --- | --- |
| Navbar | Wayfinding + primary action | Cram every product link |
| Hero | One promise, one or two actions | App sidebars, KPI dashboards |
| Logo cloud | Familiar brands as proof | A second hero |
| Features / bento | What it does | Twelve equal cards with no hierarchy |
| Social proof / testimonials | Make the claim believable | Fake specificity, wall of quotes |
| Pricing | Make a plan choice | Dark-pattern toggles, hidden totals |
| FAQ | Handle objections | Dump the help center |
| CTA band | Repeat the next step | A new competing offer |
| Team | Show the people | Lead the About page with team before the story |
| Footer | Legal + leftover links | A third marketing pitch |
| Gallery / product grid | Visual browse | Long body copy on every card |

## Rules

- One story down the page: promise → proof → offer → objections → convert. Repeat the same CTA in the hero and near the bottom.
- Do not import app chrome (sidebar, KPI strip, data table) onto a marketing route.
- Blog and product indexes may reuse List ideas (search, filters, pagination) with a visual card skin. Case studies may reuse Detail ideas (metadata + sections). Still name the **route type**, not Pattern 1 or 2.
- Spacing and type follow `spacing` and `typography`. Line length on article and about copy stays 65–75ch.
- Banned visuals in `.ux-profile.md` still apply (rainbow CTAs, cartoon people, glass slop).
- **Narrow (`viewports`):** Nav collapses to a menu. Grids go one column. No app sidebar. Compare tables scroll inside their region.
