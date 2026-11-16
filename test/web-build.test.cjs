const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const output = path.resolve(__dirname, '../dist/web');

test('Static deploy contains all HTML dependencies and offline precache files', { skip: !fs.existsSync(path.join(output, 'index.html')) }, t => {
    const dom = new JSDOM(fs.readFileSync(path.join(output, 'index.html'), 'utf8'));
    t.after(() => dom.window.close());
    for (const el of dom.window.document.querySelectorAll('script[src], link[href]')) {
        const ref = el.getAttribute('src') || el.getAttribute('href');
        if (/^https?:/.test(ref)) continue;
        assert.ok(fs.existsSync(path.join(output, ref.split('?')[0])), ref);
    }
    vm.runInNewContext(fs.readFileSync(path.join(output, 'sw.js'), 'utf8') + '\nfor (const asset of STATIC_ASSETS) check(asset);', {
        self: { addEventListener() {} },
        check: asset => assert.ok(fs.existsSync(path.join(output, asset.split('?')[0])), asset)
    });
    const files = fs.readdirSync(output, { recursive: true });
    assert.equal(files.some(name => /\.(apk|aab|ipa|AppImage|pem|key)$|(^|\/)(data.json|pin.txt|\.env|node_modules|android|ios)(\/|$)/.test(name)), false);
});

test('iOS deploy has standalone metadata and the dedicated 180px touch icon', { skip: !fs.existsSync(path.join(output, 'index.html')) }, t => {
    const dom = new JSDOM(fs.readFileSync(path.join(output, 'index.html'), 'utf8'));
    t.after(() => dom.window.close());
    const d = dom.window.document;
    for (const [name, value] of Object.entries({
        'apple-mobile-web-app-capable': 'yes',
        'apple-mobile-web-app-status-bar-style': 'black-translucent',
        'apple-mobile-web-app-title': 'NCD'
    })) assert.equal(d.querySelector(`meta[name="${name}"]`).content, value);
    assert.match(d.querySelector('meta[name="viewport"]').content, /viewport-fit=cover/);
    const png = fs.readFileSync(path.join(output, 'icon-180.png'));
    assert.equal(png.readUInt32BE(16), 180);
    assert.equal(png.readUInt32BE(20), 180);
});
