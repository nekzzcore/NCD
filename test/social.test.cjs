const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('Social screens, scripts and Player Tag UI are absent from all web bundles', () => {
 for (const folder of ['.', 'public', 'www']) {
  const root = path.join(__dirname, '..', folder);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /data-view="social"|id="view-social"|settingsPlayerTag|src="(?:social|chat)\.js"/);
  for (const script of ['social.js', 'chat.js']) assert.equal(fs.existsSync(path.join(root, script)), false);
 }
});
