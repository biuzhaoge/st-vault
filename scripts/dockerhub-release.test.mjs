import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSourceTag, releaseNotes, renderOverview } from './dockerhub-release.mjs';

test('allows a new tag or a retry on the same commit and rejects replacing a released tag', () => {
  assert.doesNotThrow(() => assertSourceTag('0.1.0', '', 'new'));
  assert.doesNotThrow(() => assertSourceTag('0.1.0', 'new', 'new'));
  assert.throws(() => assertSourceTag('0.1.0', 'old', 'new'), /v0\.1\.0 already points to/);
});

const overviewInput = {
  version: '0.2.1',
  chinese: '# 标题\n\n---\n\n中文简介。\n\n其他文字。',
  english: '# Title\n\n---\n\nEnglish introduction.\n\nOther text.',
  compose: 'services:\n  app:\n    image: biuzhaoge/st-vault:latest',
  changelog:
    '# Changelog\n\n## 0.2.2\n\nFuture\n\n## 0.2.1\n\n### 简体中文\n\n新版\n\n### English\n\nNew\n\n## 0.2.0\n\nOld',
};

test('renders the actual Docker Hub version, bilingual information and the current Compose template', () => {
  const result = renderOverview(overviewInput);
  assert.match(result, /中文简介/);
  assert.match(result, /English introduction/);
  assert.match(result, /```yaml\nservices:/);
  assert.match(result, /biuzhaoge\/st-vault:0\.2\.1/);
  assert.match(result, /\/releases\/tag\/v0\.2\.1/);
  assert.doesNotMatch(result, /Future|Old|其他文字/);
});

test('requires nonempty notes for the exact requested version', () => {
  assert.equal(
    releaseNotes(overviewInput.changelog, '0.2.1'),
    '### 简体中文\n\n新版\n\n### English\n\nNew',
  );
  assert.throws(() => releaseNotes(overviewInput.changelog, '0.3.0'), /No release notes/);
  assert.throws(() => releaseNotes('## 0.3.0\n\n## 0.2.0\nNotes', '0.3.0'), /No release notes/);
  assert.throws(() => releaseNotes(overviewInput.changelog, '0.2.01'), /Invalid release version/);
});

test('rejects oversized descriptions', () => {
  assert.throws(
    () => renderOverview({ ...overviewInput, chinese: `---\n\n${'中'.repeat(9000)}` }),
    /exceeds 25000 bytes/,
  );
});
