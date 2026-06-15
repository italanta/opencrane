# Angular / Frontend Guidelines

> Part of the OpenCrane agent guidance. See [`AGENTS.md`](../../AGENTS.md) for the index.
>
> **Scope note:** these rules target the WeOwnAI Angular frontend monorepo (a client of this
> platform), not the AGPL platform repo itself. Apply them when working in Angular frontend code.

## Integration Seam

The frontend is **just another client of the control-plane** ([API/CLI-first](./app-specific.md#api-first--cli-first-rule)) — never a privileged path:

- It consumes the same `/api/v1` surface the `oc` CLI uses, ideally through the generated typed client in `@opencrane/contracts` (`___CreateControlPlaneClient` + `paths`). Don't hand-roll request/response shapes that already exist there.
- It authenticates as a human via OIDC session, exactly like an operator using the CLI — it gets no capability the API doesn't grant every client.
- Any new UI feature must be backed by an API endpoint (and an `oc` command) first; the UI wires to that, it does not introduce control-plane behaviour of its own.

## PrimeNG Standard

For Angular frontend work, use PrimeNG as the default component library.

- Prefer PrimeNG form, table, navigation, and feedback components over custom implementations.
- Configure theme providers in `app.config.ts` using `providePrimeNG`.
- Keep global visual tokens in `styles.css`; avoid ad-hoc per-page color systems.

## Reusable Component Rule (Required)

Always create reusable UI components before writing repeated page-level markup.

- Shared visual wrappers must live under `src/app/shared/components/**`.
- Feature pages under `src/app/features/**` should compose shared components and services.
- If the same pattern appears in 2 or more places, refactor it into a shared component immediately.
- Page components should focus on orchestration and data flow; display logic belongs in shared components.
- Check these rules after every implementation cycle.

## Frontend Layering

- `core/`: API services, app-wide models, cross-cutting infrastructure
- `shared/`: reusable presentational components and UI primitives
- `features/`: route-level containers that compose `core` and `shared`

## Data Access

- All HTTP calls must go through dedicated `core/api` services.
- Do not issue HTTP requests directly from templates or shared presentational components.

## Angular Signals, Resources, and Forms

- Prefer `resource(...)` for async read/loading flows in components instead of imperative `ngOnInit` data-fetch logic.
- Prefer `rxResource(...)` / `httpResource(...)` over ad-hoc Promise orchestration when data originates from observables or HTTP.
- Prefer `computed(...)`/`effect(...)` orchestration over manual imperative state transitions when deriving UI state.
- For new or refactored standalone components, prefer `input()` / `output()` over decorator-based `@Input()` / `@Output()` unless Angular requires the decorator form.
- Use signal-driven forms only for new and refactored feature forms.

## Shared Component Size

- Keep shared component classes focused on presentation state and orchestration.
- Move standalone helpers, value parsers, and other pure utilities into sibling `*.utils.ts` files before a shared component grows into multiple concerns.

## Component Template Placement

- Component templates must be defined in separate `*.component.html` files.
- Do not use inline template literals in `@Component` metadata for feature or shared UI components.

## Modern Standalone Angular Imports

- Do not import `CommonModule` or `RouterModule` in standalone components.
- Use modern control flow syntax (`@if`, `@for`, `@switch`) instead of structural directives like `*ngIf` and `*ngFor`.
- Import standalone router directives directly (for example `RouterLink`, `RouterOutlet`) when templates need routing directives.

## Enum-First UI State

- Avoid magic strings in component decision logic.
- Use enums (for example lifecycle phases) and `switch`-based mapping helpers for status-to-UI conversions.

## Delivery Direction (Pre-Production)

- Do not preserve legacy compatibility paths by default while the platform is pre-production.
- Prefer optimal target architecture and delete superseded legacy branches when refactoring.

> The TypeScript coding rules in [`typescript.md`](./typescript.md) (naming, JSDoc, imports, bracket
> placement, etc.) also apply to Angular `.ts` files.
