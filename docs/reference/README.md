# Reference

Generated from the code, never written by hand, so it is always current.

| Reference | Source | How to get it |
|---|---|---|
| [Settings](config.md) | zod config schema (`packages/core/src/config.ts` + each module's `configSchema`): plain descriptions and technical notes | `bun docs/reference/generate.ts` |
| [Admin actions](actions.md) | action registry of a fully loaded kernel (every module) | `bun docs/reference/generate.ts` |
| [Plugin SDK](plugin-sdk.md) | the SDK's exported types and TSDoc (TypeScript compiler API), the zod manifest schema, and a built-in plugin with its tests as the worked example | `bun docs/reference/generate.ts` |
| Admin API | OpenAPI 3.1 generated from the same registry | `GET /api/v1/openapi.json` on any running server |
| [CLI](cli.md) | built-in commands and the same registry | `beamhop --help`, `beamhop <group> --help`, `beamhop actions` |
| In-app help | the same schema descriptions | the ⓘ next to every setting |

`bun docs/reference/generate.ts --check` fails when the committed pages are out of date.
