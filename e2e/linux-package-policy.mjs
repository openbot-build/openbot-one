import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { promisify } from "node:util"

// Dependency policy only: the old-version fixture contains metadata, not a
// WebKit library. The normal install check runs the actual installed engine.
const exec=promisify(execFile)
const directory=await mkdtemp(join(tmpdir(),"openbot-dependency-policy-"))
try {
  const dependencies=(await exec("dpkg-deb",["-f","/packages/openbot.deb","Depends"])).stdout.trim()
  assert.match(dependencies,/libwebkit2gtk-4\.1-0\s*\(>=\s*2\.40\)/)
  const admin=join(directory,"var/lib/dpkg")
  await Promise.all(["info","updates","triggers"].map(name=>mkdir(join(admin,name),{recursive:true})))
  const status=["libwebkit2gtk-4.1-0","libgtk-3-0"].map(name=>[
    "Package: "+name,
    "Status: install ok installed",
    "Priority: optional",
    "Section: libs",
    "Installed-Size: 0",
    "Maintainer: Test <test@example.invalid>",
    "Architecture: amd64",
    "Version: "+(name==="libwebkit2gtk-4.1-0"?"2.38.6":"3.24.33"),
    "Description: Dependency version fixture",
    "",
  ].join("\n")).join("\n")
  await writeFile(join(admin,"status"),status+"\n")
  let failure
  try { await exec("dpkg",["--root",directory,"--install","/packages/openbot.deb"],{env:{...process.env,LC_ALL:"C"}}) }
  catch(error) { failure=error }
  assert.equal(failure?.code,1,"The actual package must refuse the old dependency metadata.")
  assert.match(failure.stderr,/libwebkit2gtk-4\.1-0\s*\(>=\s*2\.40\)/)
  assert.match(failure.stderr,/2\.38\.6/)
  const result={passed:true,dependencies,oldVersion:"2.38.6",minimum:"2.40",
    rejected:true,scope:"Actual Deb dependency check in an isolated dpkg root with version fixtures; no old runtime was executed."}
  await writeFile("/results/dependency-policy.json",JSON.stringify(result,null,2)+"\n")
  console.log("PASS: the actual Deb refuses old WebKit dependency metadata.")
} finally {
  await rm(directory,{recursive:true,force:true})
}
