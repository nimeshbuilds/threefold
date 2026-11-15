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
