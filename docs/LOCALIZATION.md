# Better Workflows localization policy

[Language index](LANGUAGES.md) | [English README](../README.md)

## What is localized

Each of the 41 locales has one short README in `docs/locales/<code>.md`: what Core stops, how to try it, and how to install it for Claude Code. All 41 pages and the [language index](LANGUAGES.md) are generated from one catalog, `docs/locales/catalog.json`, by `docs/locales/build.mjs`. Edit the catalog, never a generated page.

```sh
node docs/locales/build.mjs
node docs/locales/build.mjs --check
```

The first command rewrites the pages from the catalog. The second is what CI runs: it fails if a page differs from the catalog.

The Core guides are written in English and Traditional Chinese (Taiwan) only, and every locale page links to those two.

## Review levels

| Locales | How the text is made | Who decides when it is wrong |
| --- | --- | --- |
| `en` | Written by hand | It is the reference for every other locale |
| `zh-Hant-TW` | Written and reviewed by hand | The English README |
| The other 39 | Machine-translated from `en`; the page says so | The English README |

A fix for a machine-translated locale is welcome as a pull request against `catalog.json`. A locale is marked as reviewed (its `machine` note removed) only after a fluent reader has checked the whole entry.

## What stays in English

Commands, file paths, JSON keys, evidence kinds, CLI output and code blocks stay exactly as in English in every locale, so a copied command always works. Terms that are identifiers in Core (`policy`, `provider`, `prompt`) may stay in English inside translated prose.

English is the reference for behavior and security: a translation must not promise more than the English text, and where they differ, the English README wins.

## V5

The V5.0.rc1 localization catalogs, generators and their checks are on the `frozen/v5` branch and tag `V5.0.rc1`.
