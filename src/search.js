import { randomUUID } from 'node:crypto';
import { postingsFromText } from './tokenize.js';
import { parseQuery } from './query.js';

function memPositions(entry) {
  return entry.deleted ? null : postingsFromText(entry.text);
}

export function buildSnapshot(sources) {
  const winners = new Map();
  const docs = new Map();
  const termIndex = new Map();

  for (const source of sources) {
    for (const [id, entry] of source.entries()) {
      winners.set(id, source);
    }
  }

  for (const id of [...winners.keys()].sort()) {
    const source = winners.get(id);
    const entry = source.get(id);
    if (entry.deleted) continue;

    const positions = source.getPositions
      ? source.getPositions(id)
      : memPositions(entry);
    const immutablePositions = new Map(
      [...positions].map(([term, values]) => [term, Object.freeze([...values])]),
    );
    docs.set(id, { ...entry, positions: immutablePositions });

    for (const term of immutablePositions.keys()) {
      let set = termIndex.get(term);
      if (!set) {
        set = new Set();
        termIndex.set(term, set);
      }
      set.add(id);
    }
  }

  return {
    id: randomUUID(),
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    docs,
    termIndex,
  };
}

function findPhraseStarts(positionMap, phrase) {
  const first = positionMap.get(phrase[0]);
  if (!first) return [];
  const starts = [];

  outer: for (const start of first) {
    for (let i = 1; i < phrase.length; i++) {
      const positions = positionMap.get(phrase[i]);
      if (!positions || !positions.includes(start + i)) continue outer;
    }
    starts.push({ position: start, end: start + phrase.length - 1 });
  }
  return starts;
}

export function searchSnapshot(snapshot, parsedQuery) {
  let candidateIds = null;

  for (const term of parsedQuery.terms) {
    const docs = snapshot.termIndex.get(term);
    if (!docs) return [];
    if (candidateIds === null) {
      candidateIds = new Set(docs);
    } else {
      for (const id of candidateIds) {
        if (!docs.has(id)) candidateIds.delete(id);
      }
    }
  }

  if (candidateIds === null) return [];

  const matches = [];
  for (const id of [...candidateIds].sort()) {
    const doc = snapshot.docs.get(id);
    const positionMap = doc.positions;
    const matchedTerms = parsedQuery.terms.map((term) => ({
      term,
      positions: [...(positionMap.get(term) || [])],
    }));

    const phrases = [];
    let matchesPhrase = true;
    for (const phrase of parsedQuery.phrases) {
      const starts = findPhraseStarts(positionMap, phrase);
      if (starts.length === 0) {
        matchesPhrase = false;
        break;
      }
      phrases.push({ terms: [...phrase], starts });
    }
    if (!matchesPhrase) continue;

    matches.push({
      docId: id,
      revision: doc.rev,
      text: doc.text,
      evidence: {
        matchedTerms,
        phrases,
      },
    });
  }

  return matches;
}

export function runQuery(snapshot, query) {
  return searchSnapshot(snapshot, parseQuery(query));
}
