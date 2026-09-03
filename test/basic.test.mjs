import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Nexus, isNode, platformName } from '../dist/index.js';

test('init, remote-config defaults, typed getters, flags, dispose', () => {
  const n = Nexus.init({
    apiKey: 'nxs_test',
    autoTrackSessions: false,
    autoCaptureErrors: false,
    logLevel: 'silent',
    remoteConfigDefaults: { welcome: 'Hi', max: 10, on: true, theme: { color: 'blue' } },
  });
  assert.equal(Nexus.isInitialized, true);
  assert.equal(isNode, true);
  assert.equal(platformName(), 'node');

  assert.equal(n.remoteConfig.getString('welcome'), 'Hi');
  assert.equal(n.remoteConfig.getNumber('max'), 10);
  assert.equal(n.remoteConfig.getBool('on'), true);
  assert.deepEqual(n.remoteConfig.getJSON('theme'), { color: 'blue' });
  assert.equal(n.remoteConfig.getString('missing', 'fallback'), 'fallback');
  assert.equal(n.remoteConfig.sourceOf('welcome'), null);

  assert.equal(n.flags.isEnabled('x'), false);
  assert.equal(n.flags.variant('x'), null);

  n.dispose();
  assert.equal(Nexus.isInitialized, false);
});

test('custom attributes + defaults precedence', () => {
  const n = Nexus.init({ apiKey: 'nxs_test', autoTrackSessions: false, autoCaptureErrors: false, logLevel: 'silent' });
  n.remoteConfig.setDefaults({ a: 1 });
  n.remoteConfig.setAttribute('plan', 'pro');
  n.remoteConfig.setAttributes({ segment: 'beta' });
  assert.equal(n.remoteConfig.getNumber('a'), 1);
  n.remoteConfig.setAttribute('plan', null); // remove
  n.dispose();
});
