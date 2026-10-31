import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"

/** Check the real shared composer, API, object storage, and native byte stream. */
export async function fileChecks({ call, execute, element, waitFor, output, screenshot }) {
  const filename = `native-upload-${Date.now()}.png`
  const line = "Native file 世界" + String.fromCharCode(10)
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=", "base64")
  const path = `${output}/${filename}`
  await writeFile(path, png)
  const picker = await element("css selector", "input[type=file]")
  await call(picker + "/value", { text: path })
  await waitFor(() => execute(`return !!document.querySelector('button[aria-label=Send]') && !document.querySelector('button[aria-label=Send]').disabled && !!document.querySelector(${JSON.stringify(`button[aria-label="Take out ${filename}"]`)})`), "The native composer file did not become ready.")
  await waitFor(() => execute(`return [...document.images].some(image => image.alt === ${JSON.stringify(filename)} && image.complete && image.naturalWidth === 1)`), "The uploaded draft image did not render.")
  await screenshot("file-draft")
  const result = await call("/execute/async", { script: `
    const done = arguments[0];
    let uploadedId, directId;
    (async () => {
      const native = globalThis.__OPENBOT_RUNTIME__;
      const organization = localStorage.getItem(native.storageNamespace + '.openbot.organization');
      if (!organization) throw new Error('No selected organization for the file check.');
      const api = (path, init = {}) => native.fetch(native.apiOrigin + path, {
        ...init, headers:{'OpenBot-Organization':organization, ...init.headers}
      });
      const page = await api('/v1/files?limit=100').then(response => response.json());
      const uploaded = page.items.find(file => file.filename === ${JSON.stringify(filename)});
      if (!uploaded || uploaded.status !== 'ready') throw new Error('The composer upload is not ready in the API.');
      uploadedId = uploaded.id;
      const read = await api('/v1/files/' + uploaded.id + '/content');
      if (!read.ok) throw new Error('The composer file could not be read.');
      const image = [...new Uint8Array(await read.arrayBuffer())];
      const bytes = new TextEncoder().encode(${JSON.stringify(line)}.repeat(10000));
      const start = await api('/v1/files/uploads', {method:'POST', headers:{'content-type':'application/json'},
        body:JSON.stringify({filename:'native-direct-check.txt', mediaType:'text/plain', bytes:bytes.length})});
      if (start.status !== 201) {
        const failure = await start.json().catch(() => ({}));
        throw new Error('The signed upload could not be made: ' + start.status + ' ' + (failure._tag || '') + ' ' + (failure.message || ''));
      }
      const target = await start.json();
      directId = target.file.id;
      const rejected = async (url, init) => {
        try { const response = await native.fetch(url, init); await response.body?.cancel(); return false; }
        catch { return true; }
      };
      const changedUrl = new URL(target.url); changedUrl.pathname += '-wrong';
      const changedHeaders = {...target.headers}; delete changedHeaders['content-length'];
      const blocked = [
        await rejected(target.url, {method:'GET'}),
        await rejected(changedUrl.href, {method:'PUT',headers:target.headers,body:new Blob([bytes])}),
        await rejected(target.url, {method:'PUT',headers:changedHeaders,body:new Blob([bytes,new Uint8Array([1])])})
      ];
      const put = await native.fetch(target.url, {method:target.method, headers:target.headers, body:new Blob([bytes])});
      await put.body?.cancel();
      if (!put.ok) throw new Error('Object storage rejected the signed upload.');
      const complete = await api('/v1/files/' + target.file.id + '/complete', {method:'POST'}).then(response => response.json());
      if (complete.status !== 'ready') throw new Error('The direct upload did not complete.');
      const download = await api('/v1/files/' + target.file.id + '/content');
      const saved = new Uint8Array(await download.arrayBuffer());
      const matches = saved.length === bytes.length && saved.every((byte, index) => byte === bytes[index]);
      done({image, matches, bytes:saved.length, blocked, uploadedId, directId});
    })().catch(error => done({error:String(error), uploadedId, directId}));
  `, args: [] })
  try {
    assert.equal(result.error, undefined)
    assert.deepEqual(result.image, [...png])
    assert.equal(result.matches, true)
    assert.equal(result.bytes, Buffer.byteLength(line) * 10000)
    assert.deepEqual(result.blocked, [true, true, true])
  } finally {
    const remove = await element("css selector", `button[aria-label="Take out ${filename}"]`)
    await call(remove + "/click", {})
    const ids = [result.uploadedId, result.directId].filter(Boolean)
    const cleaned = await call("/execute/async", { script: `
      const native = globalThis.__OPENBOT_RUNTIME__;
      const organization = localStorage.getItem(native.storageNamespace + '.openbot.organization');
      Promise.all(${JSON.stringify(ids)}.map(id => native.fetch(native.apiOrigin + '/v1/files/' + id,
        {method:'DELETE',headers:{'OpenBot-Organization':organization}}).then(response => response.status)))
        .then(statuses => arguments[0](statuses), () => arguments[0]([]));
    `, args: [] })
    assert.deepEqual(cleaned, ids.map(() => 204))
  }
}
