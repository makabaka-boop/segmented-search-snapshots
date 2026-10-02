import { tokenize } from './tokenize.js';

export function parseQuery(query) {
  if (typeof query !== 'string' || query.length === 0) {
    throw new TypeError('query must be a non-empty string');
  }

  const terms = [];
  const phrases = [];
  const termSet = new Set();
  let i = 0;

  while (i < query.length) {
    const ch = query[i];
    if (ch === '"') {
      const end = query.indexOf('"', i + 1);
      if (end === -1) {
        throw new SyntaxError('unterminated quoted phrase');
      }
      const phrase = tokenize(query.slice(i + 1, end));
      if (phrase.length > 0) phrases.push(Object.freeze(phrase));
      for (const term of phrase) {
        if (!termSet.has(term)) {
          termSet.add(term);
          terms.push(term);
        }
      }
      i = end + 1;
    } else {
      let end = i;
      while (end < query.length && query[end] !== '"') end++;
      for (const term of tokenize(query.slice(i, end))) {
        if (!termSet.has(term)) {
          termSet.add(term);
          terms.push(term);
        }
      }
      i = end;
    }
  }

  if (terms.length === 0) {
    throw new SyntaxError('query must contain at least one ASCII term');
  }

  return Object.freeze({
    terms: Object.freeze(terms),
    phrases: Object.freeze(phrases),
  });
}
