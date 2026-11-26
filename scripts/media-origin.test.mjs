/** Media URLs carry a query token, but the service also requires the browser Origin header. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'vue/compiler-sfc';
import ts from 'typescript';

for (const component of ['MediaLibrary', 'Timeline', 'PreviewPlayer']) {
  test(`${component}: every native media element uses anonymous CORS`, () => {
    const file = new URL(`../src/editor/${component}.vue`, import.meta.url);
    const { descriptor, errors } = parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(errors, []);
    let count = 0;
    function visit(node) {
      if (node.type === 1 && ['img', 'video', 'audio'].includes(node.tag)) {
        count++;
        const cors = node.props.find((prop) => prop.type === 6 && prop.name === 'crossorigin');
        assert.equal(cors?.value?.content, 'anonymous', `${component} <${node.tag}> must send Origin without cookies`);
      }
      for (const child of node.children ?? []) visit(child);
    }
    visit(descriptor.template.ast);
    assert.ok(count > 0, 'test must inspect actual media elements');
  });
}

test('programmatic audio pool enables anonymous CORS before assigning its source', () => {
  const { descriptor } = parse(fs.readFileSync(new URL('../src/editor/PreviewPlayer.vue', import.meta.url), 'utf8'));
  const source = ts.createSourceFile('PreviewPlayer.ts', descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true);
  const fn = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'audioClipElements');
  assert.ok(fn?.body);
  const assignments = [];
  function visit(node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) && node.left.expression.getText(source) === 'element') {
      assignments.push({ key: node.left.name.text, value: node.right.getText(source) });
    }
    ts.forEachChild(node, visit);
  }
  visit(fn.body);
  const cors = assignments.findIndex((entry) => entry.key === 'crossOrigin' && /^['"]anonymous['"]$/.test(entry.value));
  const src = assignments.findIndex((entry) => entry.key === 'src');
  assert.ok(cors >= 0 && src > cors, 'audio must set crossOrigin=anonymous before src starts its request');
});
