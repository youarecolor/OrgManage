'use strict';
// Trusted Electron-main module. Never accept evaluator code/selectors from a candidate.
// Isolated JavaScript world protects observer intrinsics, not the shared DOM or OS.
const assert = require('node:assert/strict');
const WORLD = 1004; // Distinct from main world (0) and Electron preload (999).
const HOME = 'orgmanage://home/';
const LIMIT = 65536;
const stateCode = `(() => {
  const list = (selector, limit) => {const nodes = [...document.querySelectorAll(selector)]; if (nodes.length > limit) throw Error('Observation node limit'); return nodes;};
  const text = node => {const value = node.textContent ?? ''; if (value.length > 1000) throw Error('Observation text limit'); return value;};
  return JSON.stringify({
    filters: list('.filters button', 4).map(node => ({text:text(node), pressed:node.getAttribute('aria-pressed')})),
    titles: list('.task-link', 100).map(text),
    revisions: list('.task-table tbody tr', 100).map(row => text(row.cells[2])),
    detail: document.querySelector('.mission-title') ? text(document.querySelector('.mission-title')) : null,
    empty: !!document.querySelector('.table-empty'),
    requireType: typeof require, processType: typeof process,
    width: innerWidth, height: innerHeight
  });
})()`;
function createHomeObserver(contents, {timeoutMs = 2000} = {}) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 5000);
  let unavailable = false, busy = false;
  function identity() {
    assert.equal(unavailable, false, 'Observer invalidated; do not reuse after unknown observation');
    assert.equal(contents.isDestroyed(), false);
    assert.equal(contents.getURL(), HOME, 'Unexpected evaluation page');
    const p = contents.getLastWebPreferences();
    assert.equal(p.sandbox, true); assert.equal(p.contextIsolation, true);
    assert.equal(p.nodeIntegration, false); assert.equal(p.webSecurity, true); assert.equal(p.webviewTag, false);
  }
  async function execute(code) {
    identity(); assert.equal(busy, false, 'Concurrent observations refused'); busy = true;
    let navigated = false, timer;
    const changed = () => {navigated = true; unavailable = true;};
    contents.on('did-start-navigation', changed);
    try {
      const value = await Promise.race([
        contents.executeJavaScriptInIsolatedWorld(WORLD, [{code}], false),
        new Promise((_, reject) => {timer = setTimeout(() => {unavailable = true; reject(Error('Observer timeout; execution status unknown'));}, timeoutMs);}),
      ]);
      assert.equal(navigated, false, 'Navigation during observation'); identity();
      assert.equal(typeof value, 'string'); assert.ok(Buffer.byteLength(value, 'utf8') <= LIMIT);
      return JSON.parse(value);
    } catch (error) {unavailable = true; throw error;}
    finally {clearTimeout(timer); contents.off('did-start-navigation', changed); busy = false;}
  }
  return Object.freeze({
    read: () => execute(stateCode),
    clickFilter: index => {assert.ok(Number.isInteger(index) && index >= 0 && index <= 3); return execute(`(() => {const nodes=document.querySelectorAll('.filters button');if(nodes.length!==4)throw Error('Filter count');nodes[${index}].click();return JSON.stringify({clicked:${index}});})()`);},
    selectTask: index => {assert.ok(Number.isInteger(index) && index >= 0 && index < 100); return execute(`(() => {const nodes=document.querySelectorAll('.task-link');if(nodes.length>100||!nodes[${index}])throw Error('Task count');nodes[${index}].click();return JSON.stringify({selected:${index}});})()`);},
    dispose: () => {unavailable = true;},
  });
}
module.exports = {createHomeObserver};
