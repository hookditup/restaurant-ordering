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
