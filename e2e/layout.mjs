import assert from "node:assert/strict"

// A small-window check in Linux WebKit. Android IME still needs its own check.
export async function layoutChecks({ call, execute, waitFor, element, button, screenshot }) {
  await call('/window/rect', { width: 390, height: 844 })
  await waitFor(() => execute("return innerWidth < 500 && Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--viewport-height')) - visualViewport.height) < 2"), 'The small viewport did not settle.')
  await button('Service settings')
  await call(await element('css selector', 'input[type=url]') + '/click', {})
  await call('/window/rect', { width: 390, height: 480 })
  await waitFor(() => execute("const r=document.querySelector('[role=dialog]')?.getBoundingClientRect(); return r && r.top >= 0 && r.bottom <= visualViewport.height + 1"), 'The service dialog extends beyond the visible viewport.')
  assert.equal(await execute("return document.activeElement?.matches('input[type=url]')"), true, 'Resize must keep field focus.')
  const bounds = await execute("return {width:innerWidth,scroll:document.documentElement.scrollWidth}")
  assert.ok(bounds.scroll <= bounds.width, 'The small layout must not scroll sideways.')
  await screenshot('small-dialog')
  await call(await element('css selector', '[role=dialog] button[data-slot=dialog-close]') + '/click', {})
  await waitFor(() => execute("return !document.querySelector('[role=dialog]')"), 'The dialog did not close.')
  await call('/window/rect', { width: 1200, height: 800 })
  await waitFor(() => execute('return innerWidth > 1000'), 'The desktop viewport did not return.')
}
