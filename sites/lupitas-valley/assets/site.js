(function () {
  var cfg = window.LV || {};
  var PHONE = '(435) 654-3465';
  var HOURS = { 0: null, 1: ['10:30 AM', '9:00 PM'], 2: ['10:30 AM', '9:00 PM'], 3: ['10:30 AM', '9:00 PM'], 4: ['10:30 AM', '9:00 PM'], 5: ['10:30 AM', '10:00 PM'], 6: ['10:30 AM', '10:00 PM'] };

  // Today's hours, in restaurant time
  var dayName = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', weekday: 'short' }).format(new Date());
  var dayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dayName);
  var h = HOURS[dayIdx];
  document.querySelectorAll('[data-today]').forEach(function (el) {
    el.textContent = h ? 'Today: ' + h[0] + ' - ' + h[1] : 'Closed today';
  });

  // Order buttons
  if (cfg.orderUrl) {
    document.querySelectorAll('[data-order]').forEach(function (a) {
      a.href = cfg.orderUrl;
      a.firstChild.textContent = 'Order online ';
    });
    var bar = document.querySelector('[data-order-bar]');
    if (bar) { bar.href = cfg.orderUrl; bar.textContent = 'Order'; }
  }
  // Review button
  if (cfg.reviewUrl) document.querySelectorAll('[data-review]').forEach(function (a) { a.href = cfg.reviewUrl; });

  // Close open header menus on outside click
  document.addEventListener('click', function (ev) {
    document.querySelectorAll('.more[open],.mob[open]').forEach(function (d) { if (!d.contains(ev.target)) d.removeAttribute('open'); });
  });

  // Reservation time slots follow the hours for the chosen day
  var dateEl = document.getElementById('f-date'), timeEl = document.getElementById('f-time');
  if (dateEl && timeEl) {
    var now = new Date();
    dateEl.min = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(now);
    var lastHalfHour = function (d) { return d === 5 || d === 6 ? 21.5 : 20.5; };
    var label = function (t) {
      var hr = Math.floor(t), m = t % 1 ? '30' : '00', ap = hr >= 12 ? 'PM' : 'AM', h12 = hr > 12 ? hr - 12 : hr;
      return h12 + ':' + m + ' ' + ap;
    };
    var fill = function (d) {
      timeEl.innerHTML = '<option value="">Select</option>';
      for (var t = 11; t <= lastHalfHour(d); t += 0.5) {
        var o = document.createElement('option'); o.textContent = label(t); timeEl.appendChild(o);
      }
    };
    fill(1);
    dateEl.addEventListener('change', function () {
      if (!dateEl.value) return;
      var p = dateEl.value.split('-'), d = new Date(+p[0], +p[1] - 1, +p[2]).getDay();
      if (d === 0) {
        dateEl.setCustomValidity('We are closed on Sundays. Please pick another day.');
        dateEl.reportValidity();
      } else { dateEl.setCustomValidity(''); fill(d); }
    });
  }

  // Highlight the section in view on the jump bar
  if (document.querySelector('.jump')) (function (selector) {
    var nav = null, active = null, queued = false;
    function update() {
      queued = false;
      nav = document.querySelector(selector);
      if (!nav) return;
      var links = [].slice.call(nav.querySelectorAll('a[href^="#"]'));
      var line = nav.getBoundingClientRect().bottom + 24, hit = links[0];
      var pad = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
      links.forEach(function (a) {
        var s = document.getElementById(a.getAttribute('href').slice(1));
        // A tapped link can land its section lower than the bar, so allow for that gap.
        if (s && s.getBoundingClientRect().top <= Math.max(line, pad + (parseFloat(getComputedStyle(s).scrollMarginTop) || 0) + 8)) hit = a;
      });
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) hit = links[links.length - 1];
      links.forEach(function (a) { if (a !== hit) a.removeAttribute('aria-current'); });
      if (!hit || hit.getAttribute('aria-current')) return;
      hit.setAttribute('aria-current', 'true');
      var moved = active !== hit;
      active = hit;
      if (moved) nav.scrollTo({ left: hit.offsetLeft - (nav.clientWidth - hit.offsetWidth) / 2, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
    function queue() { if (!queued) { queued = true; requestAnimationFrame(update); } }
    addEventListener('scroll', queue, { passive: true });
    addEventListener('resize', queue);
    return queue;
  })('.jump')();

  // Pause button for anything that moves on its own (WCAG 2.2.2)
  var moveBtn = function (label, after, onToggle, cls) {
    var b = document.createElement('button'), off = false;
    var icon = function () {
      b.innerHTML = '<svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="' + (off ? 'M4 2.5v11l9-5.5z' : 'M3.5 2.5h3.2v11H3.5zM9.3 2.5h3.2v11H9.3z') + '"/></svg>';
      b.setAttribute('aria-label', (off ? 'Play ' : 'Pause ') + label);
    };
    b.type = 'button'; b.className = 'move-btn' + (cls || ''); icon();
    b.addEventListener('click', function () { off = !off; icon(); onToggle(off); });
    after(b);
  };
  var heroVideo = document.querySelector('.hero video');
  if (heroVideo && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    moveBtn('background video', function (b) { heroVideo.parentNode.appendChild(b); }, function (off) { if (off) heroVideo.pause(); else heroVideo.play(); }, ' hero-btn');
  }

  // Auto-scrolling rows. Guests can swipe them. They stop on hover or focus, briefly after a touch, or with Pause.
  document.querySelectorAll('[data-scroller]').forEach(function (box) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !window.requestAnimationFrame) return;
    var track = box.querySelector('.scroller-track'), items = [].slice.call(track.children);
    [1, 2].forEach(function () {
      items.forEach(function (el) {
        var c = el.cloneNode(true);
        c.setAttribute('aria-hidden', 'true');
        track.appendChild(c);
      });
    });
    var speed = +box.getAttribute('data-scroller'), pos = 0, last = 0, held = 0, paused = false, seen = true;
    var hold = function () { held = Date.now() + 2500; };
    var user = false, over = false;
    moveBtn(box.getAttribute('aria-label'), function (b) { box.parentNode.insertBefore(b, box.nextSibling); }, function (off) { user = off; paused = user || over; });
    var stop = function () { over = true; paused = true; }, go = function () { over = false; paused = user; };
    box.addEventListener('mouseenter', stop); box.addEventListener('mouseleave', go);
    box.addEventListener('focusin', stop); box.addEventListener('focusout', go);
    ['touchstart', 'touchmove', 'wheel'].forEach(function (ev) { box.addEventListener(ev, hold, { passive: true }); });
    if (window.IntersectionObserver) new IntersectionObserver(function (e) { seen = e[0].isIntersecting; }).observe(box);
    var step = function (t) {
      var gap = Math.min(t - last, 100); last = t;
      var setWidth = track.children[items.length].offsetLeft - track.children[0].offsetLeft;
      if (paused || !seen || document.hidden || Date.now() < held) {
        pos = box.scrollLeft;
      } else {
        pos += speed * gap / 1000;
        if (pos >= setWidth) pos -= setWidth;
        box.scrollLeft = pos;
      }
      if (box.scrollLeft >= setWidth * 2) { box.scrollLeft -= setWidth; pos = box.scrollLeft; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  // Forms
  document.querySelectorAll('form[data-form]').forEach(function (f) {
    f.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var msg = f.querySelector('.form-msg');
      msg.className = 'form-msg';
      if (!f.checkValidity()) { f.reportValidity(); return; }
      var data = {};
      new FormData(f).forEach(function (v, k) { data[k] = v; });
      if (data.website) return; // honeypot
      delete data.website;
      var kind = f.getAttribute('data-form');
      var ro = window.RO;
      if (!ro) {
        msg.textContent = 'This form is not available yet. Please call us at ' + PHONE + '.';
        msg.className = 'form-msg err';
        return;
      }
      var btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      fetch(ro.url + '/functions/v1/ordering', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'form', restaurant: ro.restaurant, form: kind, page: location.pathname, data: data }) })
        .then(function (r) { return r.json(); })
        .then(function (r) {
          if (!r.ok) { msg.textContent = r.error || 'Something went wrong. Please call us at ' + PHONE + '.'; msg.className = 'form-msg err'; return; }
          f.reset();
          msg.textContent = r.member ? 'Welcome! Your rewards code is ' + r.member.code + '. Save it to use your points.'
            : r.existing ? 'You are already a member. Ask us for your rewards code next time you visit.'
            : "Request Sent! We'll be in touch soon.";
          msg.className = 'form-msg ok';
        })
        .catch(function () {
          msg.textContent = 'Something went wrong. Please call us at ' + PHONE + '.';
          msg.className = 'form-msg err';
        })
        .finally(function () { btn.disabled = false; });
    });
  });
})();
