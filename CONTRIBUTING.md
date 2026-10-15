# Contributing

## Language

Code, comments, identifiers, documentation and commit messages are in **English**.

The originating project ([pmu-sismo-prod](https://github.com/Zenda-Holos-Produccion/pmu-sismo-prod))
is written in Spanish and keeps that convention; this package does not inherit it. A library has
consumers beyond the project that produced it, and its public API is read by people who do not read
the project's own code.

## Commit messages

[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).

```
<type>[optional scope][!]: <description>

[optional body]

[optional footer(s)]
```

Types used here:

| type | meaning |
|---|---|
| `feat` | a new capability in the public API |
| `fix` | a defect corrected |
| `refactor` | internal change with no behavioural difference |
| `docs` | documentation only |
| `test` | tests only |
| `build` | packaging, tsconfig, dependencies |
| `chore` | anything else that does not reach the published package |

Scopes match the module: `whatsapp`, `conversation`, `template`, `react`, `types`.

A breaking change is marked **both** with `!` after the type and with a `BREAKING CHANGE:` footer
stating what consumers must change. The redundancy is intentional: the `!` is what a reader scanning
`git log --oneline` sees, and the footer is what tooling reads.

```
feat(conversation)!: require a closing confirmation before closeCase

BREAKING CHANGE: `Repository.closeCase` now receives a second argument with
the counts at closing time. Implementations must accept it.
```

Rationale for the standard, rather than a convention invented here: `feat`/`fix`/`!` map directly
onto minor/patch/major, so the version bump is derivable from the log instead of being decided by
whoever publishes.

## Before pushing

```bash
npm run typecheck && npm test
```

Both must pass. There is no CI on this repository yet; these are the only gates.

## Versioning

[Semantic Versioning](https://semver.org/). While on `0.x`, a breaking change bumps the minor —
`0.3.0 → 0.4.0` — as SemVer permits for initial development.

The version is bumped in the same commit as the change that justifies it, not in a separate release
commit: a tag that does not point at the code it describes is worse than no tag.
