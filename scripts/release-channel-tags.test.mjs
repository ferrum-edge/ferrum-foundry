import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReleaseTag, releaseChannelPolicy } from './release-channel-tags.mjs';

test('release metadata accepts safe tags and rejects unsafe spellings', () => {
  assert.deepEqual(
    parseReleaseTag('v12.34.56-rc.2'),
    {
      tag: 'v12.34.56-rc.2',
      version: '12.34.56-rc.2',
      majorMinor: '12.34',
      stable: false,
      numeric: [12n, 34n, 56n],
    },
  );
  assert.throws(() => parseReleaseTag('v1.2.3;echo-owned'), /safe prerelease suffix/);
  assert.throws(() => parseReleaseTag('v01.2.3'), /safe prerelease suffix/);
});

test('a backport advances its release line without regressing latest', () => {
  assert.deepEqual(
    releaseChannelPolicy('v1.2.4', ['v1.2.3', 'v1.2.4', 'v1.3.0', 'not-a-release']),
    {
      tag: 'v1.2.4',
      version: '1.2.4',
      majorMinor: '1.2',
      stable: true,
      advanceLatest: false,
      advanceMajorMinor: true,
    },
  );
});

test('an older patch cannot regress either mutable channel', () => {
  const policy = releaseChannelPolicy('v1.2.3', ['v1.2.4', 'v1.3.0']);
  assert.equal(policy.advanceLatest, false);
  assert.equal(policy.advanceMajorMinor, false);
});

test('the newest stable release advances both channels while prereleases advance neither', () => {
  const stable = releaseChannelPolicy('v2.0.0', ['v1.9.9', 'v2.0.0-rc.1', 'v2.0.0']);
  assert.equal(stable.advanceLatest, true);
  assert.equal(stable.advanceMajorMinor, true);

  const prerelease = releaseChannelPolicy('v2.1.0-rc.1', ['v2.0.0', 'v2.1.0-rc.1']);
  assert.equal(prerelease.advanceLatest, false);
  assert.equal(prerelease.advanceMajorMinor, false);
});
