// Swaps the screenshot in the hero when a tab is chosen. Works without it:
// the first screenshot is in the page already.
(function () {
  var root = document.querySelector('[data-showcase]')
  if (!root) return
  var image = root.querySelector('#shot')
  var tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'))

  function select(tab) {
    tabs.forEach(function (other) {
      other.setAttribute('aria-selected', String(other === tab))
      other.tabIndex = other === tab ? 0 : -1
    })
    image.style.opacity = '0.4'
    var next = new Image()
    next.onload = function () {
      image.src = next.src
      image.alt = tab.getAttribute('data-alt') || ''
      image.style.opacity = '1'
    }
    next.src = 'screenshots/' + tab.getAttribute('data-shot') + '.png'
  }

  tabs.forEach(function (tab, index) {
    tab.tabIndex = index === 0 ? 0 : -1
    tab.addEventListener('click', function () {
      select(tab)
    })
    tab.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
      var step = event.key === 'ArrowRight' ? 1 : -1
      var target = tabs[(index + step + tabs.length) % tabs.length]
      target.focus()
      select(target)
    })
  })
})()

// Adds a Copy button to each command in the quick start. Without it the
// commands are still plain text that can be selected.
;(function () {
  if (!navigator.clipboard) return
  Array.prototype.forEach.call(document.querySelectorAll('pre.cmd'), function (block) {
    var code = block.querySelector('code')
    if (!code) return
    var button = document.createElement('button')
    button.type = 'button'
    button.className = 'copy'
    button.textContent = 'Copy'
    button.setAttribute('aria-label', 'Copy command: ' + code.textContent)
    button.addEventListener('click', function () {
      navigator.clipboard.writeText(code.textContent).then(function () {
        button.textContent = 'Copied'
        setTimeout(function () {
          button.textContent = 'Copy'
        }, 1600)
      })
    })
    block.appendChild(button)
  })
})()

// Fills the handoff prompt box from the published skill file, so the prompt on
// this page can never drift from the skill. Without scripting, the page links
// to the file instead.
;(function () {
  var box = document.querySelector('[data-handoff-prompt]')
  if (!box || !window.fetch) return
  var intro = 'Follow the instructions below for this conversation, right now.'
  fetch('skills/threefolds/SKILL.md')
    .then(function (response) {
      if (!response.ok) throw new Error('not found')
      return response.text()
    })
    .then(function (text) {
      // Drop the front matter between the two "---" lines. The prompt is what follows,
      // up to the section about installing the app, which a pasted prompt has no use for.
      var body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '').split('\n## Installing Threefold')[0].trim()
      var code = box.querySelector('code')
      code.textContent = intro + '\n\n' + body
      box.hidden = false
      var fallback = document.querySelector('[data-handoff-fallback]')
      if (fallback) fallback.hidden = true
      var button = box.querySelector('button')
      if (!button || !navigator.clipboard) return
      button.hidden = false
      button.addEventListener('click', function () {
        navigator.clipboard.writeText(code.textContent).then(function () {
          button.textContent = 'Copied'
          setTimeout(function () {
            button.textContent = 'Copy the prompt'
          }, 1600)
        })
      })
    })
    .catch(function () {})
})()

// The "install message" for assistants that create a skill from a chat message
// (the Gemini app, ChatGPT workspaces with Skills): a request to create the
// skill, followed by the skill's own text. Built from the published file, so it
// cannot drift from it. The button stays hidden when that is not possible.
;(function () {
  var box = document.querySelector('[data-skill-install]')
  if (!box || !window.fetch || !navigator.clipboard) return
  var button = box.querySelector('button')
  fetch('skills/threefolds/SKILL.md')
    .then(function (response) {
      if (!response.ok) throw new Error('not found')
      return response.text()
    })
    .then(function (text) {
      var body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '').trim()
      var message =
        'Create a skill named "threefolds" based on these instructions. Keep the instructions exactly as they are written.\n\n' + body
      box.hidden = false
      button.addEventListener('click', function () {
        navigator.clipboard.writeText(message).then(function () {
          button.textContent = 'Copied'
          setTimeout(function () {
            button.textContent = 'Copy the install message'
          }, 1600)
        })
      })
    })
    .catch(function () {})
})()
