import { Fragment } from 'react';

/** Shows a text from en.ts/sv.ts with its `**bold**` parts in bold. */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}
