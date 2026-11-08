const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizedQuery, literalQuery, flexibleQuery, relevance } = require('../src/searchQuery');
const { searchPublic } = require('../src/publicSources');

test('apostrophe styles, missing apostrophes, case and accents share one search identity', () => {
  const queries = ["You're Joking", 'You’re Joking', 'YOURE JOKING', 'youre-joking'];
  assert.equal(new Set(queries.map(normalizedQuery)).size, 1);
  assert.equal(literalQuery('youre joking'), "you're joking");
  assert.equal(normalizedQuery('García Márquez'), 'garcia marquez');
});
test('partial words and one-character typos rank the intended title above weaker matches', () => {
  const book = 'Harry Potter and the Goblet of Fire';
  assert.ok(relevance('harry pott', book) > relevance('harry pott', 'Harry and the Hendersons'));
  assert.ok(relevance('harry pottr', book) > relevance('harry pottr', 'Harry and the Hendersons'));
  assert.ok(relevance('dune', 'Dune') > relevance('dune', 'Children of Dune'));
  assert.equal(relevance('', book), 0);
});
test('user punctuation cannot inject wildcard or Boolean operators into generated queries', () => {
  const query = flexibleQuery('Harry + Pottr* | -secret (file):"x"');
  assert.ok(!query.includes('-secret')); assert.ok(!query.includes(':'));
  assert.ok(!flexibleQuery('*** () + | -').length);
  assert.equal(flexibleQuery('7'), '7');
});
test('punctuation variants reuse the same source page and generate a usable contraction alternative', async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async (_url, init) => {
    calls++;
    const request = JSON.parse(init.body);
    assert.match(request.query, /"you re"/);
    assert.match(request.query, /joking\*/);
    assert.ok(!('order_by' in request), 'Let source relevance rank results before popularity');
    return { ok: true, json: async () => ({ total: { value: 1 }, hits: [{ title: "Surely You're Joking", hash: 'a'.repeat(40), categoryId: [1003000] }] }) };
  };
  try {
    const a = await searchPublic('knaben', 'youre joking punctuation-fixture');
    const b = await searchPublic('knaben', 'you’re joking punctuation fixture');
    assert.equal(a.length, 1); assert.equal(b[0].infohash, a[0].infohash); assert.equal(calls, 1);
  } finally { global.fetch = original; }
});
