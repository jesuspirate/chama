import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { androidVersionCode, MAX_RC } from './android-version-code.mjs';

// The 6.4.25 incident: rc.14 and the release shared 60425.
assert.equal(androidVersionCode('6.4.26-rc.1'), 6042601);
assert.equal(androidVersionCode('6.4.26-rc.14'), 6042614);
assert.equal(androidVersionCode('6.4.26'), 6042699);
assert.ok(androidVersionCode('6.4.26-rc.14') < androidVersionCode('6.4.26'), 'an rc sorts below its release');
assert.ok(androidVersionCode(`6.4.26-rc.${MAX_RC}`) < androidVersionCode('6.4.26'), 'the last allowed rc sorts below its release');
assert.ok(androidVersionCode('6.4.26') < androidVersionCode('6.4.27-rc.1'), 'a release sorts below the next version\'s rcs');
assert.ok(androidVersionCode('6.4.99') < androidVersionCode('6.5.0-rc.1'));
assert.ok(androidVersionCode('6.5.0-rc.1') > 60425, 'every new code is above the last old-scheme code (6.4.25 = 60425)');
assert.ok(androidVersionCode('99.99.99') < 2100000000, 'stays under Android\'s versionCode ceiling');

for (const bad of ['6.4.26-rc.0', `6.4.26-rc.${MAX_RC + 1}`, '6.4.26-beta.1', '6.4', '6.4.26-rc', '6.100.0', 'v6.4.26']) {
  assert.throws(() => androidVersionCode(bad), /Unsupported Android version/, bad);
}

// The CLI the release script calls prints the code, and fails on a bad version.
const cli = new URL('./android-version-code.mjs', import.meta.url).pathname;
assert.equal(execFileSync('node', [cli, '6.4.26-rc.3']).toString().trim(), '6042603');
assert.throws(() => execFileSync('node', [cli, '6.4.26-beta'], { stdio: 'pipe' }));

// build.gradle carries the same formula (it can't import this module); keep them in step.
const gradle = readFileSync(new URL('../android/app/build.gradle', import.meta.url), 'utf8');
assert.match(gradle, /-rc\\\.\(\\d\+\)/, 'build.gradle parses the -rc.N suffix');
assert.match(gradle, /appVersionBase \* 100 \+ 99/, 'build.gradle gives a release the top slot');
assert.match(gradle, /appVersionBase \* 100 \+ appVersionRc/, 'build.gradle numbers an rc below its release');
assert.match(gradle, /appVersionRc > 98/, 'build.gradle refuses rc numbers past 98');

// Both release lanes enforce it: the APK's versionCode is checked, and --rc is capped.
const release = readFileSync(new URL('./android-release.sh', import.meta.url), 'utf8');
assert.match(release, /android-version-code\.mjs/);
assert.match(release, /versionCode='\$EXPECTED_VERSION_CODE'/);
const prerelease = readFileSync(new URL('./prerelease-apk.sh', import.meta.url), 'utf8');
assert.match(prerelease, /RC" -gt 98/);

console.log('android-version-code: ok');
