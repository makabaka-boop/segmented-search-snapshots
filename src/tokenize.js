const ASCII_TOKEN_RE = /[A-Za-z0-9]+/g;

export function tokenize(text) {
  if (text === undefined || text === null) return [];
  if (typeof text !== 'string') {
    throw new TypeError('text must be a string');
  }
  return Array.from(text.matchAll(ASCII_TOKEN_RE), (match) => match[0].toLowerCase());
}

export function termPositions(text) {
  const positions = new Map();
  let position = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isToken =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57);
    if (!isToken) continue;
    const start = i;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      const token =
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        (c >= 48 && c <= 57);
      if (!token) break;
      i++;
    }
    const value = text.slice(start, i).toLowerCase();
    let list = positions.get(value);
    if (!list) {
      list = [];
      positions.set(value, list);
    }
    list.push(position++);
    i--;
  }
  return positions;
}

export function postingsFromText(text) {
  const result = new Map();
  for (const [term, positions] of termPositions(text)) {
    result.set(term, Object.freeze([...positions]));
  }
  return result;
}
