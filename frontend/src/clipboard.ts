/**
 * Copy text to the clipboard.
 *
 * The async clipboard API only exists in a secure context, and the console is
 * often served over plain HTTP on a LAN address. The deprecated execCommand
 * path still works there, so it is the fallback instead of an error toast that
 * tells the operator to select the text by hand.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the execCommand path */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}
