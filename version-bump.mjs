// Run by `npm version <x.y.z>`: copies the new version into manifest.json, and
// records it in versions.json when the minimum Obsidian version has changed.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.env.npm_package_version;
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  throw new Error(`version must be x.y.z, got ${version}`);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = version;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
if (!Object.values(versions).includes(manifest.minAppVersion)) {
  versions[version] = manifest.minAppVersion;
  writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
}
