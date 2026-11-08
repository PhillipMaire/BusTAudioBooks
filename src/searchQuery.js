// Keep user punctuation out of the provider's query language; only generated
// prefix/fuzzy operators are permitted. No LLM or extra search service needed.
const CONTRACTIONS = {
  youre: "you're", theyre: "they're", weve: "we've", youve: "you've", ive: "I've",
  dont: "don't", doesnt: "doesn't", didnt: "didn't", cant: "can't", wont: "won't",
  isnt: "isn't", arent: "aren't", wasnt: "wasn't", werent: "weren't", couldnt: "couldn't",
  shouldnt: "shouldn't", wouldnt: "wouldn't", havent: "haven't", hasnt: "hasn't", hadnt: "hadn't",
  youll: "you'll", theyll: "they'll", thats: "that's", theres: "there's", whats: "what's",
};
function words(text) {
  return String(text || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/['’‘ʼ`]/g, '').match(/[\p{L}\p{N}]+/gu)?.slice(0, 20) || [];
}
function normalizedQuery(text) { return words(text).join(' '); }
function literalQuery(text) { return words(text).map(w => CONTRACTIONS[w] || w).join(' '); }
function flexibleQuery(text) {
  return words(text).map(w => {
    const expanded = CONTRACTIONS[w];
    if (expanded) return `(${w}|"${expanded.toLowerCase().replace("'", ' ')}")`;
    if (/^\d+$/.test(w) || w.length < 3) return w;
    return w.length >= 4 ? `(${w}*|${w}~1)` : `${w}*`;
  }).join(' ');
}
function oneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length <= b.length) j++;
    if (a.length >= b.length) i++;
  }
  return edits + (i < a.length || j < b.length ? 1 : 0) <= 1;
}
function relevance(query, title) {
  const want = words(query), have = words(title);
  if (!want.length) return 0;
  const phrase = want.join(' '), text = have.join(' ');
  let score = text === phrase ? 1000 : text.startsWith(phrase) ? 600 : text.includes(phrase) ? 400 : 0;
  for (const w of want) {
    if (have.includes(w)) score += 30;
    else if (w.length >= 3 && have.some(t => t.startsWith(w))) score += 20;
    else if (w.length >= 4 && have.some(t => oneEdit(w, t))) score += 10;
  }
  return score / want.length;
}
module.exports = { words, normalizedQuery, literalQuery, flexibleQuery, relevance };
