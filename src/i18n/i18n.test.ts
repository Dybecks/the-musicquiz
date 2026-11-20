import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { en } from './en';
import { sv } from './sv';

/**
 * Keeps the site in two languages: every text a player can see must come
 * from en.ts/sv.ts (through useT() or msg()), never be written straight into
 * a component or an error message. When this fails, move the text into
 * en.ts and sv.ts.
 */

const SRC = join(__dirname, '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'i18n' ? [] : files(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Has words in it: two letters in a row. Codes like "ABCD" are fine. */
const wordy = (text: string) => /[a-zåäö]{2}/i.test(text) && /[a-zåäö]/.test(text);

/** Attributes people see or hear. */
const SHOWN_ATTRIBUTES = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label', 'detail', 'tag']);

function findHardcodedText(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const where = (node: ts.Node) => `${relative(SRC, path)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  // Only the written parts of a template count, not the code in ${…}.
  const literalText = (node: ts.Node | undefined): string | null => {
    if (!node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
    return null;
  };

  const visit = (node: ts.Node) => {
    // <p>Some text</p>
    if (ts.isJsxText(node) && wordy(node.getText())) found.push(`${where(node)} ${node.getText().trim()}`);
    // title="Some text", or {cond ? 'Some text' : …} directly inside JSX
    if (ts.isJsxAttribute(node) && SHOWN_ATTRIBUTES.has(node.name.getText())) {
      const init = node.initializer;
      const text = init && ts.isJsxExpression(init) ? literalText(init.expression) : literalText(init);
      if (text && wordy(text)) found.push(`${where(node)} ${node.getText()}`);
    }
    if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      const parts = ts.isConditionalExpression(node.expression) ? [node.expression.whenTrue, node.expression.whenFalse] : [node.expression];
      for (const part of parts) {
        const text = literalText(part);
        if (text && wordy(text)) found.push(`${where(part)} ${text}`);
      }
    }
    // new Error('Some text'), confirm('Some text'), alert('Some text'), prompt('Some text')
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && node.arguments?.length) {
      const callee = node.expression.getText();
      if (/(^|\.)(\w*Error|confirm|alert|prompt)$/.test(callee)) {
        const text = literalText(node.arguments[0]);
        if (text && wordy(text)) found.push(`${where(node)} ${node.getText()}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function shape(value: unknown): unknown {
  if (typeof value === 'function') return `function(${value.length})`;
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]));
  return typeof value;
}

describe('languages', () => {
  it('has no text written straight into components or error messages', () => {
    const found = files(SRC).flatMap(findHardcodedText);
    expect(found, 'Move these texts into src/i18n/en.ts and sv.ts').toEqual([]);
  });

  it('has the same texts in Swedish as in English', () => {
    expect(shape(sv)).toEqual(shape(en));
  });

  it('has no empty texts', () => {
    const empty: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (typeof v === 'string' && !v.trim()) empty.push(path);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    walk(en, 'en');
    walk(sv, 'sv');
    expect(empty).toEqual([]);
  });
});
