# Primary language

**TypeScript is the language used most to develop this project**, by a wide margin.

Counting tracked files in the repository:

| Language                   | Files          | Lines  |
| -------------------------- | -------------- | ------ |
| TypeScript (`.ts` + `.tsx`) | 186 (175 + 11) | 14,564 |
| JSON                       | 31             | —      |
| Markdown                   | 17             | —      |
| JSONL (recorded fixtures)  | 10             | —      |
| SQL / Shell / JS / YAML    | ~12            | —      |

Of roughly 20,500 total lines across all tracked text files, about 14,600 (~71%)
are TypeScript — and that excludes JSON config, Markdown docs, and recorded
vendor fixtures, which are not really development languages.

This matches `AGENTS.md` rule 5 ("TypeScript strict. Zod at every external
boundary. No `any` across package boundaries"): the whole system
(`packages/*/src`, `apps/cli`, `tests/e2e`) is written in TypeScript.
