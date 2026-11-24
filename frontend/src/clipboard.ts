/**
 * Copy text to the clipboard.
 *
 * One path only: the temporary textarea plus execCommand('copy'). The console
 * usually runs over plain HTTP on a LAN address, where the async clipboard API
 * does not exist, so using it would mean carrying two implementations for the
 * same button. execCommand is deprecated but every current browser still
 * supports it, and it runs synchronously inside the click handler, which is
 * what Safari requires anyway.
 */
export function copyText(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '0'
  area.style.opacity = '0'
  document.body.appendChild(area)
  // iOS only copies a selection that belongs to a focused field.
  area.focus()
  area.select()
  area.setSelectionRange(0, area.value.length)
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}
