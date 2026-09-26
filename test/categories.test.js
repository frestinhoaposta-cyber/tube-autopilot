const test = require('node:test');
const assert = require('node:assert/strict');
const { categoriesConfig, generateTitle, generateShortTitle, buildYoutubeSnippet } = require('../server/categories');

test('tags são cortadas antes do limite de 500 caracteres do YouTube', () => {
  const tags = Array.from({ length: 60 }, (_, index) => `tag bem comprida numero ${index}`);
  const snippet = buildYoutubeSnippet({ title: 'Título', description: 'Descrição', tags, youtubeCategoryId: '20' });
  const total = snippet.tags.join(',').length;
  assert.ok(total <= 480, `esperado no máximo 480 caracteres, veio ${total}`);
  assert.ok(snippet.tags.length > 0);
  const adjusted = buildYoutubeSnippet({ title: 'Título', description: 'Descrição', tags, youtubeCategoryId: '20' }, { maxTagsChars: 300 });
  assert.ok(adjusted.tags.join(',').length <= 300);
  assert.ok(adjusted.tags.length < snippet.tags.length);
});

test('nenhuma categoria do config passa do limite de tags', () => {
  for (const category of Object.values(categoriesConfig)) {
    const snippet = buildYoutubeSnippet({ title: 'T', description: 'D', tags: category.tags, youtubeCategoryId: category.youtubeCategoryId });
    assert.ok(snippet.tags.join(',').length <= 480, `${category.id} excedeu o limite de tags`);
    assert.ok(snippet.title.length <= 100);
    assert.ok(snippet.description.length <= 5000);
  }
});

test('categoriaId inválida cai para Jogos (20) e título é limitado', () => {
  const snippet = buildYoutubeSnippet({ title: 'x'.repeat(180), description: 'd', tags: ['a'], youtubeCategoryId: 'abc' });
  assert.equal(snippet.categoryId, '20');
  assert.equal(snippet.title.length, 100);
});

test('títulos gerados terminam com as hashtags e respeitam 100 caracteres', () => {
  for (const id of Object.keys(categoriesConfig)) {
    const title = generateTitle(id, `seed-${id}`);
    assert.ok(title.length <= 100, `${id}: título com ${title.length} caracteres`);
    assert.match(title.toLowerCase(), /#roblox/);
    assert.match(title.toLowerCase(), /#script/);
    const short = generateShortTitle(id, `seed-${id}`);
    assert.ok(short.length <= 100, `${id}: short com ${short.length} caracteres`);
    assert.match(short.toLowerCase(), /#roblox/);
  }
});
