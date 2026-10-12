/**
 * LXGW WenKai is the librarian's voice. Its sliced @font-face sheet is only
 * attached when the librarian first opens, so the landing view never pays
 * for it.
 */
let attached = false

export function ensureLibrarianFont(): void {
  if (attached || typeof document === 'undefined') return
  attached = true
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = `${import.meta.env.BASE_URL}fonts/fonts-kai.css`
  link.dataset.font = 'librarian'
  document.head.append(link)
}
