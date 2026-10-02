import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { postingsFromText } from './tokenize.js';

export const SEGMENT_PREFIX = 'segment-';
export const SEGMENT_SUFFIX = '.json';

export function segmentFileName(id) {
  return `${SEGMENT_PREFIX}${String(id).padStart(12, '0')}${SEGMENT_SUFFIX}`;
}

export function parseSegmentFileName(name) {
  if (!name.startsWith(SEGMENT_PREFIX) || !name.endsWith(SEGMENT_SUFFIX)) return null;
  const number = name.slice(SEGMENT_PREFIX.length, -SEGMENT_SUFFIX.length);
  if (!/^\d{12}$/.test(number)) return null;
  return Number(number);
}

export function encodeEntry(entry) {
  return {
    id: entry.id,
    rev: entry.rev,
    deleted: entry.deleted === true,
    ...(entry.deleted ? {} : { text: entry.text }),
  };
}

export function decodeEntry(raw) {
  const entry = {
    id: raw.id,
    rev: raw.rev,
    deleted: raw.deleted === true,
  };
  if (!entry.deleted) entry.text = raw.text;
  return entry;
}

export class Segment {
  constructor(id, entries, map, postings) {
    this.id = id;
    this.entries = entries;
    this.map = map;
    this.postings = postings;
  }

  get(id) {
    return this.map.get(id);
  }

  getPositions(id) {
    return this.postings.get(id);
  }
}

export function buildSegment(id, latestEntries) {
  const sorted = [...latestEntries.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const map = new Map();
  const postings = new Map();

  for (const entry of sorted) {
    map.set(entry.id, entry);
    if (!entry.deleted) {
      postings.set(entry.id, postingsFromText(entry.text));
    }
  }

  return new Segment(id, Object.freeze(sorted), map, postings);
}

export function segmentPayload(segment) {
  const docs = {};
  const postings = {};
  for (const entry of segment.entries) {
    docs[entry.id] = encodeEntry(entry);
    if (!entry.deleted) {
      postings[entry.id] = Object.fromEntries(
        [...segment.postings.get(entry.id)].map(([term, values]) => [term, [...values]]),
      );
    }
  }
  return {
    format: 1,
    id: segment.id,
    docs,
    postings,
  };
}

export async function loadSegment(directory, id) {
  const raw = JSON.parse(await readFile(join(directory, segmentFileName(id)), 'utf8'));
  if (!raw || raw.format !== 1 || raw.id !== id || typeof raw.docs !== 'object') {
    throw new Error(`invalid segment ${id}`);
  }

  const entries = [];
  const map = new Map();
  const postings = new Map();

  for (const [docId, doc] of Object.entries(raw.docs)) {
    const entry = decodeEntry({ ...doc, id: docId });
    entries.push(entry);
    map.set(docId, entry);
    if (!entry.deleted) {
      const terms = new Map();
      const rawPostings = raw.postings?.[docId] || {};
      for (const [term, positions] of Object.entries(rawPostings)) {
        terms.set(term, Object.freeze([...positions]));
      }
      postings.set(docId, terms);
    }
  }

  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Segment(id, Object.freeze(entries), map, postings);
}
