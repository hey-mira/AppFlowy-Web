# Rust formula integration

This Web fork uses the pinned `@notion-formula/sdk` for saved formulas and editor
language services. [Prepare the package](DEVELOPMENT_GUIDE.md#prepare-the-formula-package)
before installing dependencies. The pin in `scripts/notion-formula-source.json`
identifies the implementation used by that build.

## Storage and upgrade behavior

Yjs continues to store formula text and field options. `prop("field-id")` remains
the canonical reference; renaming a field changes its label, not its identity.
There is no per-formula engine-version field or rewrite of stored expressions.
Opening a database uses the pinned Rust engine for every formula, including
formulas in historical snapshots. Other AppFlowy clients may use different
formula semantics; this change does not migrate those clients.

The host retains field decoding, related-data loading, collaboration, and display.
Rust owns the language, dependencies, types, evaluation, and editor analysis. A
formula rejected by Rust is shown as invalid; it is not evaluated by a second
language implementation.

## Editor behavior

The editor recognizes complete `prop(String)` calls in the current native token
snapshot and passes the complete `String` token text to the SDK's synchronous
`decodeFormulaString`. Host-created literals use `encodeFormulaString`. Tokens
carry only `kind`, raw source `text`, and `span`.

| Action                                   | Behavior                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Insert a property or formula             | Completion inserts its stable field ID; the chip displays the current name.                                                                                        |
| Type or paste `prop("Name")`             | An existing ID wins; otherwise a unique matching name is bound to its ID. Ambiguous or missing names remain diagnosable.                                           |
| Paste bare text such as `Price * 2`      | Preserve the source. Use property completion or `prop("Price")`; bare names are no longer rewritten by a JavaScript parser.                                        |
| Complete `prop("id")` beside a syntax error | Display the complete reference as a chip; retain the syntax diagnostic and keep saving disabled. Ordinary string literals remain text.                        |
| Rename, delete, or reuse a property name | Keep already-bound IDs. Deletion produces a missing-reference diagnostic instead of rebinding to another field.                                                    |
| Receive schema changes while editing     | Reanalyze without replacing local text, selection, or undo history.                                                                                                |
| Preview                                  | Evaluate the candidate in a separate Engine. An ordinary row failure does not prohibit saving a statically valid formula.                                          |
| Save after a concurrent formula edit     | Local Done replaces that formula's text after validation against the latest schema; unrelated field options are preserved. Deletion or retyping prevents the save. |
| Cancel or close                          | Discard the candidate and release its Draft/Workers. Historical views remain read-only.                                                                            |

## Values and compatibility

The native [language](https://github.com/JoverZhang/notion-formula-rs/blob/master/docs/specs/formula-language.md),
[builtin](https://github.com/JoverZhang/notion-formula-rs/blob/master/docs/specs/builtin-functions.md),
and [Engine](https://github.com/JoverZhang/notion-formula-rs/blob/master/docs/specs/formula-engine.md)
contracts define exact semantics. In particular:

- Preserve NaN, Infinity, signed zero, nested nulls, and the evaluation-time output
  type. Unknown/Union types stay conservative in host filtering and calculation
  controls; a single row's value does not redefine a column's static type.
- Numeric sorting orders `-Infinity < finite values < Infinity < NaN`, reversing
  that order for descending sorts; ordinary null and errors stay last. NaNs and
  signed zeros retain stable ties. Numeric comparisons reject NaN, while
  `IsNotEmpty` includes it; finite decimal comparisons retain host precision.
- Pending, ordinary null, invalid formulas, and row errors are distinct. Keep
  originating Formula IDs when dependency errors propagate. Filters, sorting,
  and column calculations include the offscreen rows they need.
- Date inputs and results retain both endpoints and the time-display flag. A
  batch uses one caller-provided time and fixed UTC offset. Regional daylight
  saving rules are not inferred separately for each date.
- Field conversion waits for complete, current results and commits synchronously
  only after checking the schema and row revisions. Failed evaluation or host
  projection leaves the formula field unchanged; ordinary null remains a valid
  empty value.

Existing formulas switch together with the build's SDK pin. Compared with the
former Web evaluator, missing numeric operands remain null in arithmetic instead
of becoming zero, and non-finite Numbers remain values instead of becoming empty.
Native Union results can represent branches of different types; host controls
use their declared output type rather than inferring a new type from one row.
Date arithmetic uses the batch's fixed offset, so it does not apply different
regional daylight-saving offsets to dates within the same request.

The compatibility fixtures retain the existing function examples, both long
issue-9039 formulas, and authored business input products. Their expected values
are independent of the engine. Language-specific parser/checker/cache unit suites
were replaced by the native repository's public API tests and the browser cases;
the Web suite retains tests for its own field decoding, schema snapshots and UI.
The [value coverage record](../playwright/fixtures/native-formula-values.coverage.json)
keeps the original dataset fingerprint and explicitly lists the null, NaN and
negative-zero differences.

## Reproduce browser verification

These integration fixtures use production Yjs/database/editor components and the
real packaged Worker/WASM; they do not require a Cloud login. Backend deployment
and authenticated application tests still use the development guide's Cloud setup.

```sh
pnpm exec playwright install chromium
pnpm exec tsc --project playwright/tsconfig.integrations.json
pnpm exec playwright test native-formula --config=playwright.integrations.config.ts --project=chromium
FORMULA_FIXTURE_PRODUCTION=1 pnpm exec playwright test native-formula --config=playwright.integrations.config.ts --project=chromium
```

The runtime, editor, consumer, and compatibility suites write JSON evidence and screenshots to
`test-results/`; Playwright attaches them to its report. The production run builds
the fixtures with Vite and loads emitted Worker and WASM assets.

`pnpm test` runs the Slate suite in a separate ESM process that imports the public
SDK. Other unit suites keep their CommonJS runner. Coverage reports stay in
`coverage/jest/`, with Slate coverage in `coverage/jest/formula-slate/`.
