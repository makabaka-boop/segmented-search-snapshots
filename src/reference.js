import { parseQuery } from './query.js';
import { buildSnapshot, searchSnapshot } from './search.js';
import { postingsFromText } from './tokenize.js';

export function latestFromDocuments(documents) {
  const entries = new Map();
  const iterable = documents instanceof Map ? documents : Object.entries(documents);
  for (const [id, doc] of iterable) {
    entries.set(id, {
      id,
      rev: doc.rev,
      deleted: doc.deleted === true,
      ...(doc.deleted === true ? {} : { text: String(doc.text) }),
    });
  }
  return entries;
}

export function referenceSearch(latestDocuments, query) {
  const docs = latestFromDocuments(latestDocuments);
  const source = {
    *entries() {
      yield* docs;
    },
    get(id) {
      return docs.get(id);
    },
    getPositions(id) {
      const doc = docs.get(id);
      return doc && !doc.deleted ? postingsFromText(doc.text) : new Map();
    },
  };
  const snapshot = buildSnapshot([source]);
  return searchSnapshot(snapshot, parseQuery(query));
}
