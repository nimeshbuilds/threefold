// Tells the Threefold app which assistant the handoff comes from, when the
// address of this page says so. Only one of three known names is ever passed
// on, and nothing else from the address is used.
;(function () {
  var NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' }
  var from = ''
  try {
    from = (new URLSearchParams(window.location.search).get('from') || '').toLowerCase()
  } catch (error) {
    return
  }
  if (!Object.prototype.hasOwnProperty.call(NAMES, from)) return
  var link = document.getElementById('open')
  var note = document.getElementById('sender')
  if (!link || !note) return
  link.href = 'threefold://handoff?from=' + from
  note.querySelector('strong').textContent = NAMES[from]
  note.hidden = false
})()
