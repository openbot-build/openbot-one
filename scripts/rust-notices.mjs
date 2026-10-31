import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)
const root = fileURLToPath(new URL("../", import.meta.url))
const version = "0.9.3"
const inputs = ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "dev/notices/rust-about.toml", "dev/notices/rust-upstream.json", "scripts/rust-notices.mjs"]
const output = "vendor/third-party"
const htmlName = "rust.html"
const manifestName = "rust.json"
/** @param {string | Buffer} value */
const hash = value => createHash("sha256").update(value).digest("hex")
/** @param {string} value */
const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

/** @typedef {{name:string, version:string, id:string, license:string, authors:string[], manifest_path:string, repository:string|null}} Package */
/** @typedef {{licenses:Array<{id:string, name:string, text:string, source_path:string|null, used_by:Array<{crate:Package}>}>, crates:Array<{package:Package}>}} AboutData */

/** @typedef {{crate:string, repository:string, sourceRepository?:string, commit:string, files:Array<{path:string, source:string, file:string, sha256:string}>}} UpstreamPackage */

/** Read pinned original files without contacting an upstream server.
 * @param {string} sourceRoot
 * @returns {Promise<UpstreamPackage[]>}
 */
async function upstreamNotices(sourceRoot) {
  const data = JSON.parse(await readFile(join(sourceRoot, "dev/notices/rust-upstream.json"), "utf8"))
  if (data.schema !== 1 || !Array.isArray(data.packages)) throw new Error("The upstream notice index is invalid.")
  const seen = new Set()
  for (const pkg of data.packages) {
    if (typeof pkg.crate !== "string" || seen.has(pkg.crate) || !/^[a-f0-9]{40}$/.test(pkg.commit)
      || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pkg.repository)
      || !Array.isArray(pkg.files) || !pkg.files.length)
      throw new Error("The upstream notice package record is invalid.")
    seen.add(pkg.crate)
    const repository = pkg.sourceRepository ?? pkg.repository
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
      throw new Error("The upstream notice repository is invalid.")
    for (const file of pkg.files) {
      if (!/^[a-f0-9]{64}$/.test(file.sha256) || file.file !== "vendor/third-party/upstream/" + file.sha256 + ".txt"
        || !/^[A-Za-z0-9_./-]+$/.test(file.path) || file.path.startsWith("/")
        || file.path.split("/").some((/** @type {string} */ part) => !part || part === "." || part === "..")
        || file.source !== repository.replace("github.com", "raw.githubusercontent.com") + "/" + pkg.commit + "/" + file.path)
        throw new Error("The upstream notice file must have a fixed source commit and local hash.")
      if (hash(await readFile(join(sourceRoot, file.file))) !== file.sha256)
        throw new Error("An original upstream notice changed: " + file.file)
    }
  }
  return data.packages
}

/** @param {string} sourceRoot */
async function noticeInputs(sourceRoot) {
  const upstream = await upstreamNotices(sourceRoot)
  return [...inputs, ...[...new Set(upstream.flatMap(pkg => pkg.files.map(file => file.file)))].sort()]
}

/** Reject stale generated notices before making an app. No scanner is needed to build.
 * @param {string} [sourceRoot]
 */
export async function verifyRustNotices(sourceRoot = root) {
  const required = await noticeInputs(sourceRoot)
  const manifest = JSON.parse(await readFile(join(sourceRoot, output, manifestName), "utf8"))
  if (manifest.generator !== "cargo-about " + version || manifest.schema !== 1
    || !Array.isArray(manifest.inputs) || manifest.inputs.length !== required.length)
    throw new Error("The Rust notice record is invalid. Run pnpm notices:generate.")
  for (const path of required) {
    const records = manifest.inputs.filter((/** @type {{path:string}} */ item) => item.path === path)
    if (records.length !== 1 || hash(await readFile(join(sourceRoot, path))) !== records[0].sha256)
      throw new Error("Rust notices are stale for " + path + ". Run pnpm notices:generate.")
  }
  const html = join(sourceRoot, output, htmlName)
  if (manifest.html?.file !== htmlName || hash(await readFile(html)) !== manifest.html.sha256)
    throw new Error("The generated Rust notices changed. Run pnpm notices:generate.")
  return html
}

/** Preserve original notices too: generic SPDX fallback can omit copyright text.
 * @param {Package[]} packages
 */
async function originalNotices(packages) {
  /** @type {Map<string,{text:string, files:Array<{crate:string,path:string,source?:string}>}>} */
  const texts = new Map()
  /** @type {string[]} */
  const localMissing = []
  const noticeName = (/** @type {string} */ name) => /^(licen[cs]es?|copying|notice|copyright|authors?)([._-].*)?$/i.test(name)
  /** @param {string} crate @param {string} path @param {Buffer} bytes @param {string} [source] */
  function add(crate, path, bytes, source) {
    const sha256 = hash(bytes)
    const text = new TextDecoder("utf-8", {fatal:true}).decode(bytes)
    const record = texts.get(sha256) ?? {text, files:[]}
    record.files.push({crate, path, ...(source ? {source} : {})})
    texts.set(sha256, record)
  }
  for (const pkg of packages) {
    const crate = pkg.name + "@" + pkg.version
    const directory = dirname(pkg.manifest_path)
    let count = 0
    /** @param {string} directory @param {string} prefix @param {boolean} [insideNotice] */
    async function walk(directory, prefix, insideNotice = false) {
      for (const entry of (await readdir(directory, {withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name, "en"))) {
        const relative = prefix + entry.name
        const path = join(directory, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) await walk(path, relative + "/", insideNotice || noticeName(entry.name))
        else if (entry.isFile() && (insideNotice || noticeName(entry.name))) {
          add(crate, relative, await readFile(path))
          count++
        }
      }
    }
    await walk(directory, "")
    // Older crates can retain their original terms only in source headers.
    if (!count) {
      for (const name of ["src/lib.rs", "lib.rs"]) {
        let source
        try { source = await readFile(join(directory, name), "utf8") }
        catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue; throw error }
        const header = source.startsWith("/*")
          ? source.slice(0, source.indexOf("*/") + 2)
          : source.match(/^(?:\/\/[^\n]*(?:\n|$))+/)?.[0]
        if (header && header.length <= 8192 && /copyright|licen[cs]e|spdx/i.test(header)) {
          add(crate, name + " (original license header)", Buffer.from(header))
          count++
          break
        }
      }
    }
    if (!count) localMissing.push(crate)
  }
  const upstream = await upstreamNotices(root)
  for (const record of upstream) {
    const pkg = packages.find(pkg => pkg.name + "@" + pkg.version === record.crate)
    if (!pkg || pkg.repository !== record.repository) throw new Error("An upstream notice no longer matches the locked dependency: " + record.crate)
    const vcs = JSON.parse(await readFile(join(dirname(pkg.manifest_path), ".cargo_vcs_info.json"), "utf8"))
    if (vcs.git?.sha1 !== record.commit) throw new Error("An upstream notice source commit changed: " + record.crate)
    for (const file of record.files) add(record.crate, "upstream/" + record.commit + "/" + file.path,
      await readFile(join(root, file.file)), file.source)
  }
  const missing = localMissing.filter(crate => !upstream.some(record => record.crate === crate))
  if (missing.length) throw new Error("Original dependency notices are missing: " + missing.join(", "))
  return {texts, localMissing, upstream, missing}
}

async function generate() {
  const tool = process.env.CARGO_ABOUT ?? "cargo-about"
  const controller = new AbortController()
  const stop = () => controller.abort()
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop)
  try {
    const actual = (await run(tool, ["--version"], {maxBuffer:4096, signal:controller.signal})).stdout.trim()
    if (actual !== "cargo-about " + version) throw new Error("Install cargo-about " + version + " with --locked --features cli.")
    const result = await run(tool, [
      "generate", "--locked", "--manifest-path", "src-tauri/Cargo.toml",
      "--config", "dev/notices/rust-about.toml", "--format", "json", "--fail",
    ], {cwd:root, maxBuffer:32 * 1024 * 1024, signal:controller.signal})
    if (result.stderr) process.stderr.write(result.stderr)
    /** @type {AboutData} */
    const data = JSON.parse(result.stdout)
    if (!data.crates?.length || !data.licenses?.length) throw new Error("The Rust dependency notice report is empty.")
    const packages = data.crates.map(item => item.package).sort((a,b) => a.id.localeCompare(b.id, "en"))
    const original = await originalNotices(packages)
    const html = [
      '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Rust dependency notices</title>',
      "<h1>Rust dependency notices</h1>",
      "<p>This file contains third-party notices. The application license is separate.</p>",
      "<p>The dependency graph includes build dependencies and all target platforms. It is a superset of any one packaged app.</p>",
      "<h2>Packages</h2><ul>",
      ...packages.map(pkg => "<li>" + escape(pkg.name + " " + pkg.version + " — " + pkg.license)
        + "<br>" + escape(pkg.authors.join(", ")) + (pkg.repository ? "<br>" + escape(pkg.repository) : "") + "</li>"),
      "</ul><h2>Collected license texts</h2>",
      ...data.licenses.map(license => {
        if (!license.text?.trim() || !license.used_by?.length) throw new Error("A dependency license has no text or attribution.")
        return "<section><h3>" + escape(license.name + " (" + license.id + ")")
          + "</h3><p>" + escape(license.used_by.map(item => item.crate.name + " " + item.crate.version).join(", "))
          + "</p><pre>" + escape(license.text) + "</pre></section>"
      }),
      "<h2>Original copyright and notice files</h2>",
      ...[...original.texts].sort(([a],[b]) => a.localeCompare(b, "en")).map(([sha256, record]) =>
        "<section><h3>" + escape(sha256) + "</h3><ul>" + record.files.map(file =>
          "<li>" + escape(file.crate + " / " + file.path) + (file.source ? "<br>" + escape(file.source) : "") + "</li>").join("")
        + "</ul><pre>" + escape(record.text) + "</pre></section>"),
      "</html>\n",
    ].join("\n").replace(/\r\n?/g, "\n")
    const manifest = {
      schema:1, generator:actual,
      scope:"Default-feature dependency graph, build dependencies and all target platforms; application excluded.",
      inputs:await Promise.all((await noticeInputs(root)).map(async path => ({path, sha256:hash(await readFile(join(root, path)))}))),
      html:{file:htmlName, sha256:hash(html)},
      packages:packages.map(pkg => ({name:pkg.name, version:pkg.version, license:pkg.license})),
      collectedLicenseTexts:data.licenses.length,
      originalNoticeFiles:[...original.texts.values()].reduce((n,item) => n + item.files.length, 0),
      originalNoticeTexts:original.texts.size,
      packagesWithoutLocalNoticeFiles:original.localMissing,
      packagesWithoutOriginalNoticeFiles:original.missing,
      upstreamNotices:original.upstream,
      genericLicenseFallback:[...new Set(data.licenses.filter(item => !item.source_path).flatMap(item =>
        item.used_by.map(item => item.crate.name + "@" + item.crate.version)))].sort(),
      review:"Original files and source headers are collected. Review license choices and platform runtime notices before a release.",
    }
    const directory = join(root, output)
    await mkdir(directory, {recursive:true})
    // Commit the record last. An interrupted generation cannot pass verification.
    for (const [name, content] of [[htmlName, html], [manifestName, JSON.stringify(manifest, null, 2) + "\n"]]) {
      const temporary = join(directory, name + "." + randomUUID() + ".tmp")
      await writeFile(temporary, content)
      await rename(temporary, join(directory, name))
    }
    await verifyRustNotices()
    console.log(JSON.stringify({packages:packages.length, texts:data.licenses.length,
      originalFiles:manifest.originalNoticeFiles, upstreamPackages:original.upstream.length, reviewMissing:original.missing.length}))
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, stop)
  }
}

async function main() {
  if (process.argv[2] === "generate" && process.argv.length === 3) await generate()
  else if (process.argv[2] === "check" && process.argv.length === 3) {
    await verifyRustNotices()
    console.log("Rust notices match the locked source.")
  } else throw new Error("Use generate or check.")
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
