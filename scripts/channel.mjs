import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const release = "domios-teams-latest";
const archiveName = "domios-teams.tar.gz";
const receiptName = "domios-teams.source-commit";
const repository = "domios-dev/domios-teams";
const run = (bin, args, options = {}) => execFileSync(bin, args, { timeout: 120000, ...options });
const git = args => run("git", args).toString().trim();
const checksum = bytes => `${crypto.createHash("sha256").update(bytes).digest("hex")}  ${archiveName}\n`;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function validate(directory, validator) {
  const index = JSON.parse(fs.readFileSync(path.join(directory, "channel.json")));
  if (index.schemaVersion !== 1 || index.name !== "domios-teams" ||
      typeof index.displayName !== "string" || typeof index.description !== "string" ||
      !Array.isArray(index.teams) || index.teams.length === 0) throw new Error("Invalid channel index");
  const names = new Set();
  const paths = new Set();
  for (const team of index.teams) {
    if (typeof team.name !== "string" || !/^dev\.domios\/[a-z0-9-]+$/.test(team.name) ||
        typeof team.path !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(team.path) ||
        !semver.test(team.version ?? "") || !semver.test(team.minDomios ?? "") ||
        names.has(team.name) || paths.has(team.path)) throw new Error("Invalid or duplicate team entry");
    names.add(team.name);
    paths.add(team.path);
    const packagePath = path.join(directory, team.path);
    for (const entry of fs.readdirSync(packagePath, { recursive: true, withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`Package contains a symlink: ${team.path}/${entry.name}`);
    }
    const report = JSON.parse(run(validator, [packagePath, "--json"]));
    if (!report.valid || report.name !== team.name || report.version !== team.version) {
      throw new Error(`Index disagrees with ATP validator: ${team.name}`);
    }
    console.log(`Validated ${team.name}@${team.version}`);
  }
  const folders = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(directory, entry.name, "team.yaml")))
    .map(entry => entry.name);
  if (folders.some(folder => !paths.has(folder))) throw new Error("Unindexed ATP package");
  return index;
}

export function publicationDecision(previous, source, isAncestor) {
  if (!previous) return "publish";
  if (!/^[a-f0-9]{40}$/.test(previous)) throw new Error("Invalid published source receipt");
  if (previous === source) return "skip";
  if (isAncestor(previous, source)) return "publish";
  if (isAncestor(source, previous)) return "skip";
  throw new Error(`Published history ${previous} is unrelated to ${source}`);
}

function packageChannel(source, output, validator) {
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error("Expected a full source commit SHA");
  const index = JSON.parse(git(["show", `${source}:channel.json`]));
  const paths = ["channel.json", "LICENSE", ...index.teams.map(team => team.path)];
  if (paths.some(value => typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(value))) {
    throw new Error("Unsafe archive path");
  }
  fs.mkdirSync(output, { recursive: true });
  const archive = path.resolve(output, archiveName);
  run("git", ["archive", "--format=tar.gz", `--output=${archive}`, source, "--", ...paths]);
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "domios-teams-validate-"));
  try {
    run("tar", ["-xzf", archive, "-C", extracted]);
    validate(extracted, validator);
  } finally { fs.rmSync(extracted, { recursive: true, force: true }); }
  fs.writeFileSync(`${archive}.sha256`, checksum(fs.readFileSync(archive)));
  const receipt = path.resolve(output, receiptName);
  fs.writeFileSync(receipt, `${source}\n`);
  return [archive, `${archive}.sha256`, receipt];
}

async function publish(source, validator) {
  if (!/^[a-f0-9]{40}$/.test(source) || git(["rev-parse", "HEAD"]) !== source) {
    throw new Error("Publication must execute at the exact source commit");
  }
  if (git(["status", "--porcelain", "--untracked-files=no"])) throw new Error("Dirty publication source");
  run("git", ["merge-base", "--is-ancestor", source, "origin/master"]);
  const gh = args => run("gh", args).toString();
  const existing = spawnSync("gh", ["api", `repos/${repository}/releases/tags/${release}`], { encoding: "utf8", timeout: 120000 });
  if (existing.status !== 0 && !existing.stderr?.includes("HTTP 404")) {
    throw new Error(existing.stderr || "Release lookup failed");
  }
  const exists = existing.status === 0;
  const previous = exists ? gh(["release", "download", release, "--repo", repository,
    "--pattern", receiptName, "--output", "-"]).trim() : null;
  const ancestor = (older, newer) => {
    const result = spawnSync("git", ["merge-base", "--is-ancestor", older, newer], { timeout: 120000 });
    if (result.status !== 0 && result.status !== 1) throw new Error("Cannot establish publication ancestry");
    return result.status === 0;
  };
  if (publicationDecision(previous, source, ancestor) === "skip") {
    console.log(`Kept published source ${previous}; skipped ${source}`);
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "domios-teams-publish-"));
  try {
    const files = packageChannel(source, directory, validator);
    if (!exists) gh(["release", "create", release, "--repo", repository, "--target", source,
      "--latest=false", "--title", "Domios Teams channel", "--notes", "Official ATP teams, validated on master.", ...files]);
    else gh(["release", "upload", release, "--repo", repository, "--clobber", ...files]);
    const base = `https://github.com/${repository}/releases/download/${release}/`;
    const download = async name => {
      const response = await fetch(base + name, { cache: "no-store", signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`Anonymous download ${name}: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    };
    const served = await download(archiveName);
    const servedChecksum = (await download(`${archiveName}.sha256`)).toString();
    if (checksum(served) !== fs.readFileSync(files[1], "utf8") || checksum(served) !== servedChecksum ||
        (await download(receiptName)).toString() !== `${source}\n`) throw new Error("Published asset readback mismatch");
    console.log(`${base}${archiveName}\n${servedChecksum}Source: ${source}`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

const [command, source, output, validator] = process.argv.slice(2);
if (command === "validate" && source && output) validate(source, output);
else if (command === "package" && source && output && validator) packageChannel(source, output, validator);
else if (command === "publish" && source && output) await publish(source, output);
else throw new Error("Usage: channel.mjs validate FOLDER VALIDATOR | package SHA OUTPUT VALIDATOR | publish SHA VALIDATOR");
