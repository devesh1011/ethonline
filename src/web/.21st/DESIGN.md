# ReceivableX design context

## Direction

Graphite workbench, mint document sheets, raised controls and an asset-led workspace.
The user supplied [Aave Pro](https://pro.aave.com) as a reference. Its compact
type scale and grouped market data informed the dashboard; no Aave branding,
logos, market data or source code are copied.

The landing page communicates the product; the dashboard serves a task.
Existing Manrope is retained for both, with fixed 28px dashboard headings and
a larger fluid scale only on the landing page. JetBrains Mono is reserved for
actual identifiers and code. Display-serif operational typography is removed.

The second direction changes the structure, not just the palette: a horizontal
command dock replaces the persistent sidebar. Actual receivables appear as a
layered CSS-3D folio, beside a compact accounting surface. A contextual record
sheet provides read-only inspection without leaving the task. Material shading
and short, defined shadows establish depth; no decorative SVG animation is used.
The exposed rear sheets are selectable by pointer or keyboard: selection brings
that record forward while keeping the other visible sheets in the deck. The
arrows continue to browse records in their original order.

GSAP controls folio transitions, the active navigation indicator, sheet movement
and press feedback. React-scoped cleanup and reduced-motion media queries are
required. Motion must never change signing, navigation or financial handlers.

## Routes and reusable components

- `/`: public introduction, recorded/live pool preview, participant tabs.
- `/dashboard`: portfolio, real exposure composition, searchable receivables.
- Existing `/pools`, `/servicing`, `/investors`, `/audit`, `/proof` remain intact.
- Reuse `WalletButton`, `WorkspaceProvider` and all financial action components.
- New shared `Brand` mark is a native vector, not an external asset dependency.
- `CommandShell`, `AssetFolio` and `ReceivableInspectorProvider` share material
  tokens from `app/globals.css`; no permanent sidebar is rendered.

## Constraints

- No invented adoption, APY, balance history, user names or charts.
- Financial data comes from the existing API or labelled historical fallback.
- Preserve wallet signing, authorization, amount precision and operation handlers.
- Maintain visible testnet/synthetic-data context without repeating large banners.
- Native dialogs, visible focus, keyboard tabs, reduced motion and mobile layouts.
- No financial writes during visual review of the public read model.

## 21st usage

Local design-context initialization and local component review were used.
Catalog search was attempted but unavailable without authentication. No hosted
generation was called and no catalog components were imported. GSAP 3.15.0 and
@gsap/react 2.1.2 were installed separately for the requested motion work.

Implementation remains local for user review before public deployment.
