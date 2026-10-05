import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = resolve(projectRoot, "extension");
const manifest = JSON.parse(await readFile(resolve(extensionRoot, "manifest.json"), "utf8"));
const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, packageJson.version);
assert.deepEqual(manifest.permissions, ["storage"]);
assert.deepEqual(manifest.host_permissions, ["https://discord.com/*", "https://ptb.discord.com/*", "https://canary.discord.com/*"]);
assert.ok(!manifest.externally_connectable);
assert.ok(!manifest.content_security_policy.extension_pages.includes("unsafe-"));
assert.ok(manifest.content_security_policy.extension_pages.includes("connect-src https://discord.com;"));

async function allFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await allFiles(path));
    else paths.push(path);
  }
  return paths;
}

const files = await allFiles(extensionRoot);
const extensionPaths = new Set(files.map(path => relative(extensionRoot, path).replaceAll("\\", "/")));
const namedResources = [manifest.background.service_worker, ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon), ...manifest.content_scripts.flatMap(script => script.js), "panel.html", "panel.css", "panel.js"];
for (const resource of namedResources) assert.ok(extensionPaths.has(resource), `Missing resource: ${resource}`);
for (const script of files.filter(path => path.endsWith(".js"))) {
  const syntax = spawnSync(process.execPath, ["--check", script], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const source = await readFile(script, "utf8");
  assert.ok(!/\beval\s*\(|new\s+Function\s*\(|\.innerHTML\s*=/.test(source), `Unsafe script execution or DOM sink: ${script}`);
  for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    const imported = resolve(dirname(script), match[1]);
    assert.ok(files.includes(imported), `Missing import: ${match[1]}`);
    const webAccessible = manifest.web_accessible_resources[0].resources;
    if (script.endsWith("panel.js") || script.includes("/core/")) {
      const importPath = relative(extensionRoot, imported).replaceAll("\\", "/");
      assert.ok(webAccessible.includes(importPath) || (importPath.startsWith("core/") && webAccessible.includes("core/*.js")));
    }
  }
}
const html = await readFile(resolve(extensionRoot, "panel.html"), "utf8");
for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
  if (!match[1].startsWith("https://")) assert.ok(extensionPaths.has(match[1]), `Missing HTML resource: ${match[1]}`);
}
assert.ok(html.includes("account termination"));
assert.ok(html.includes('id="confirmationInput"'));
assert.ok(html.includes('id="rememberTokenInput"'));
assert.ok(html.includes('id="forgetTokenButton"'));
assert.ok(html.includes('id="speedPresetInput"'));
for (const id of ["dateFilterInput", "dateModeInput", "dateFromInput", "dateToInput", "wordFilterInput", "wordModeInput", "wordQueryInput", "confirmFilters"]) {
  assert.ok(html.includes(`id="${id}"`), `Missing filter UI: ${id}`);
}
for (const id of ["dateFilterInput", "wordFilterInput"]) {
  const input = new RegExp(`<input\\b[^>]*id="${id}"[^>]*>`).exec(html)?.[0];
  assert.ok(input && !/\bchecked\b/.test(input), `${id} must be off by default`);
}
assert.ok(html.includes(`v${manifest.version}`));
console.log(`Validated Manifest V3, ${files.length} extension resources, JavaScript syntax, local imports, and permission/CSP constraints.`);
