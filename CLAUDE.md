# The Music Quiz

Vite + React + TypeScript party game. `npm test`, `npm run build` (type check + build).

## Every text in two languages

The site is in English and Swedish. Never write player-visible text straight into a
component, an attribute (`title`, `aria-label`, `placeholder`, `alt`), an error message
or a `confirm()`. Instead:

1. Add the text to `src/i18n/en.ts` (a function when it has numbers or names in it).
2. Add the Swedish version to `src/i18n/sv.ts` — natural Swedish, not word for word.
3. Read it with `useT()` in components or `msg()` elsewhere; `<Rich>` shows `**bold**`.

`src/i18n/i18n.test.ts` and the type check fail when a text is missing in Swedish or
written straight into the code. A new written fun fact in `src/data/facts.ts` needs its
Swedish version in `src/data/facts.sv.ts` too. See "Languages" in README.md.
