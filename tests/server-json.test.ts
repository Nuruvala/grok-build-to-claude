import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * `server.json` is the MCP Registry entry, and every field in it duplicates something
 * `package.json` already says. The registry only notices a mismatch at publish time,
 * where the error names neither file — so the drift is caught here instead.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path.join(repoRoot, name), 'utf8'));
  assert.ok(parsed !== null && typeof parsed === 'object', `${name} is not an object`);
  return parsed as Record<string, unknown>;
}

const pkg = readJson('package.json');
const server = readJson('server.json');

/** The one npm entry in `server.json`; the registry supports several package types. */
function npmPackage(): Record<string, unknown> {
  const packages = server['packages'];
  assert.ok(Array.isArray(packages), 'server.json has no packages array');
  const entries = packages.filter(
    (entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry),
  );
  const npm = entries.filter((entry) => entry['registryType'] === 'npm');
  assert.equal(npm.length, 1, 'expected exactly one npm package entry');
  const [entry] = npm;
  assert.ok(entry);
  return entry;
}

describe('server.json agrees with package.json', () => {
  it('declares the version being released', () => {
    assert.equal(server['version'], pkg['version']);
    assert.equal(npmPackage()['version'], pkg['version']);
  });

  it('points at this npm package', () => {
    assert.equal(npmPackage()['identifier'], pkg['name']);
    assert.equal(npmPackage()['registryBaseUrl'], 'https://registry.npmjs.org');
  });

  it('carries the mcpName the registry reads to verify npm ownership', () => {
    // The registry fetches package.json from the published tarball and requires
    // mcpName to equal the server name. A tarball without it fails verification,
    // so the field has to ship in the release, not just live in the repo.
    assert.equal(pkg['mcpName'], server['name']);
  });
});

describe('server.json satisfies the registry schema rules', () => {
  it('names the server in reverse-DNS form with exactly one slash', () => {
    const name = server['name'];
    assert.equal(typeof name, 'string');
    assert.match(name as string, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  });

  it('claims a namespace the release workflow can authenticate', () => {
    // `mcp-publisher login github-oidc` grants io.github.<owner>/* and nothing else,
    // with the owner's case preserved. The registry compares namespaces exactly and
    // answers a mismatch with a 403 at publish time — io.github.nuruvala cost a
    // release to learn, because the npm tarball carries mcpName and cannot be
    // corrected after the fact.
    assert.match(server['name'] as string, /^io\.github\.Nuruvala\//);
  });

  it('keeps title and description inside the schema length caps', () => {
    // Both are silently generous-looking and both are capped. Over the limit the
    // publish fails on a schema error that names a JSON pointer, not a file.
    assert.ok((server['description'] as string).length <= 100);
    assert.ok((server['title'] as string).length <= 100);
    assert.ok((server['name'] as string).length <= 200);
  });

  it('pins the schema and a stdio transport', () => {
    assert.match(
      server['$schema'] as string,
      /^https:\/\/static\.modelcontextprotocol\.io\/schemas\//,
    );
    assert.deepEqual(npmPackage()['transport'], { type: 'stdio' });
  });

  it('only names environment variables the server actually reads', () => {
    // A typo here is invisible: the registry accepts any string, and a client that
    // renders the misspelled name sends a variable config.ts will never look at.
    const source = readFileSync(path.join(repoRoot, 'src', 'config.ts'), 'utf8');
    const vars = npmPackage()['environmentVariables'];
    assert.ok(Array.isArray(vars));
    for (const entry of vars as Record<string, unknown>[]) {
      const name = String(entry['name']);
      assert.ok(source.includes(`'${name}'`), `${name} is not read by src/config.ts`);
    }
  });

  it('declares no environment variable as required or secret', () => {
    // Every knob has a documented default, and the xAI credential belongs to the
    // grok CLI rather than to this server — nothing here should prompt for a secret.
    const vars = npmPackage()['environmentVariables'];
    assert.ok(Array.isArray(vars));
    for (const entry of vars as Record<string, unknown>[]) {
      assert.equal(entry['isRequired'], false, `${String(entry['name'])} is marked required`);
      assert.equal(entry['isSecret'], false, `${String(entry['name'])} is marked secret`);
    }
  });
});
