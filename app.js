(function(){
  "use strict";

  var state = {
    userLat: null,
    userLon: null,
    rangeKm: 50,
    aircraft: [],
    selectedIcao: null,
    sortKey: 'dist',
    sortAsc: true,
    refreshTimer: null,
    failureStreak: 0,
    fetching: false,
    preferredTransport: {},
    refreshIntervalMs: 6000,
    maxBackoffMs: 60000,
    lastUpdateTs: null,
    showingLocationInfo: false
  };

  var els = {
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    rangeSelect: document.getElementById('rangeSelect'),
    rangeLabel: document.getElementById('rangeLabel'),
    refreshBtn: document.getElementById('refreshBtn'),
    locBtn: document.getElementById('locBtn'),
    scopeSvg: document.getElementById('scopeSvg'),
    scopeFootnote: document.getElementById('scopeFootnote'),
    manualPanel: document.getElementById('manualPanel'),
    latInput: document.getElementById('latInput'),
    lonInput: document.getElementById('lonInput'),
    manualSetBtn: document.getElementById('manualSetBtn'),
    countLabel: document.getElementById('countLabel'),
    acTableBody: document.getElementById('acTableBody'),
    emptyState: document.getElementById('emptyState'),
    loadingState: document.getElementById('loadingState'),
    detailContent: document.getElementById('detailContent'),
    detailTitle: document.getElementById('detailTitle'),
    indUpdatedTime: document.getElementById('indUpdatedTime'),
    acTable: document.getElementById('acTable'),
    themeBtn: document.getElementById('themeBtn')
  };

  // ---------- persisted settings (localStorage; works once hosted, not in this preview) ----------
  function safeGetStored(key){
    try { return localStorage.getItem(key); } catch(e){ return null; }
  }
  function safeSetStored(key, val){
    try { localStorage.setItem(key, val); } catch(e){ /* storage unavailable, ignore */ }
  }

  var THEME_KEY = 'luftrum-theme';
  var RANGE_KEY = 'luftrum-range-km';

  function applyTheme(theme){
    if (theme === 'light'){
      document.body.setAttribute('data-theme', 'light');
      els.themeBtn.textContent = '● Mörkt läge';
    } else {
      document.body.removeAttribute('data-theme');
      els.themeBtn.textContent = '☀ Ljust läge';
    }
  }

  applyTheme(safeGetStored(THEME_KEY));

  // Restore the last-used range (falls back to the 50 km default if nothing saved
  // or the saved value isn't one of the dropdown's options)
  (function restoreRange(){
    var saved = safeGetStored(RANGE_KEY);
    if (saved && els.rangeSelect.querySelector('option[value="' + saved + '"]')){
      els.rangeSelect.value = saved;
      state.rangeKm = parseInt(saved, 10);
    }
  })();

  els.themeBtn.addEventListener('click', function(){
    var isLight = document.body.getAttribute('data-theme') === 'light';
    var next = isLight ? 'dark' : 'light';
    applyTheme(next);
    safeSetStored(THEME_KEY, next);
  });

  // ---------- geo helpers ----------
  function toRad(d){ return d * Math.PI / 180; }
  function toDeg(r){ return r * 180 / Math.PI; }

  function haversineKm(lat1, lon1, lat2, lon2){
    var R = 6371;
    var dLat = toRad(lat2 - lat1);
    var dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat/2)*Math.sin(dLat/2) +
            Math.cos(toRad(lat1))*Math.cos(toRad(lat2)) *
            Math.sin(dLon/2)*Math.sin(dLon/2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  function bearingDeg(lat1, lon1, lat2, lon2){
    var y = Math.sin(toRad(lon2-lon1)) * Math.cos(toRad(lat2));
    var x = Math.cos(toRad(lat1))*Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1))*Math.cos(toRad(lat2))*Math.cos(toRad(lon2-lon1));
    var brng = toDeg(Math.atan2(y, x));
    return (brng + 360) % 360;
  }

  function boundingBox(lat, lon, rangeKm){
    var latDelta = rangeKm / 111.32;
    var lonDelta = rangeKm / (111.32 * Math.cos(toRad(lat)) || 1);
    return {
      lamin: lat - latDelta,
      lamax: lat + latDelta,
      lomin: lon - lonDelta,
      lomax: lon + lonDelta
    };
  }

  // ---------- status ----------
  function setStatus(text, mode){
    els.statusText.textContent = text;
    els.statusDot.className = 'dot' + (mode === 'live' ? ' live' : mode === 'err' ? ' err' : '');
  }

  function setLamp(id, lampState){
    var el = document.getElementById(id);
    if (!el) return;
    var lamp = el.querySelector('.lamp');
    if (!lamp) return;
    lamp.className = 'lamp' + (lampState && lampState !== 'off' ? ' ' + lampState : '');
  }

  // ---------- mini-map (passive geographic backdrop behind the radar) ----------
  var map = null;

  function initMap(lat, lon){
    if (typeof L === 'undefined' || map) return;
    map = L.map('miniMap', {
      zoomControl: false,
      attributionControl: true,
      dragging: false,
      touchZoom: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      tap: false
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(map);

    fitMapToRange(lat, lon, state.rangeKm);
    setTimeout(function(){ if (map) map.invalidateSize(); }, 150);
  }

  // Frames the map so its visible area roughly matches the radar's current range ring,
  // using the same bounding-box math the API queries use for consistency.
  function fitMapToRange(lat, lon, rangeKm){
    if (!map) return;
    var bb = boundingBox(lat, lon, rangeKm);
    map.fitBounds([[bb.lamin, bb.lomin], [bb.lamax, bb.lomax]], { animate: false });
  }

  function updateMapPosition(lat, lon){
    if (typeof L === 'undefined') return;
    if (!map){ initMap(lat, lon); return; }
    fitMapToRange(lat, lon, state.rangeKm);
  }

  function updateMapRange(){
    if (map && state.userLat !== null) fitMapToRange(state.userLat, state.userLon, state.rangeKm);
  }

  // ---------- location (browser API + 3 IP services raced, fastest wins) ----------
  function geoViaBrowser(){
    return new Promise(function(resolve, reject){
      if (!navigator.geolocation){
        reject(new Error('Geolocation API saknas i denna miljö'));
        return;
      }
      navigator.geolocation.getCurrentPosition(function(pos){
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          source: 'Enhetens platstjänst'
        });
      }, function(err){
        reject(new Error('Enhetens platstjänst nekad/otillgänglig (kod ' + err.code + ')'));
      }, { enableHighAccuracy:false, timeout:8000, maximumAge:60000 });
    });
  }

  function fetchJson(url){
    return fetch(url, { cache:'no-store', mode:'cors' }).then(function(res){
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function geoViaIpwho(){
    return fetchJson('https://ipwho.is/').then(function(d){
      if (!d || d.success === false || typeof d.latitude !== 'number') throw new Error('inget giltigt svar');
      return { lat: d.latitude, lon: d.longitude, source: 'IP-position (ipwho.is' + (d.city ? ', ' + d.city : '') + ')' };
    }).catch(function(e){ throw new Error('ipwho.is: ' + e.message); });
  }

  function geoViaGeojs(){
    return fetchJson('https://get.geojs.io/v1/ip/geo.json').then(function(d){
      var lat = parseFloat(d && d.latitude), lon = parseFloat(d && d.longitude);
      if (isNaN(lat) || isNaN(lon)) throw new Error('inget giltigt svar');
      return { lat: lat, lon: lon, source: 'IP-position (geojs.io' + (d.city ? ', ' + d.city : '') + ')' };
    }).catch(function(e){ throw new Error('geojs.io: ' + e.message); });
  }

  function geoViaIpapi(){
    return fetchJson('https://ipapi.co/json/').then(function(d){
      if (!d || typeof d.latitude !== 'number' || typeof d.longitude !== 'number') throw new Error('inget giltigt svar');
      return { lat: d.latitude, lon: d.longitude, source: 'IP-position (ipapi.co' + (d.city ? ', ' + d.city : '') + ')' };
    }).catch(function(e){ throw new Error('ipapi.co: ' + e.message); });
  }

  function requestLocation(){
    setStatus('Frågar fyra positionstjänster — använder den som svarar snabbast…', '');
    setLamp('indPosition', 'warn');
    var settled = false;
    var errors = [];
    var serviceFns = [geoViaBrowser, geoViaIpwho, geoViaGeojs, geoViaIpapi];

    serviceFns.forEach(function(fn){
      fn().then(function(result){
        if (settled) return;
        settled = true;
        state.userLat = result.lat;
        state.userLon = result.lon;
        setLamp('indPosition', 'ok');
        setStatus('Position via ' + result.source + ' — hämtar flygdata…', '');
        updateMapPosition(result.lat, result.lon);
        startTracking();
      }).catch(function(err){
        errors.push(err.message);
        if (!settled && errors.length >= serviceFns.length){
          handleLocationFailure('Alla positionstjänster misslyckades (' + errors.join(' · ') + '). Ange koordinater manuellt nedan — t.ex. via Google Maps (håll fingret på din plats).');
        }
      });
    });

  }

  function handleLocationFailure(msg){
    setStatus(msg, 'err');
    setLamp('indPosition', 'err');
    els.manualPanel.classList.add('open');
    els.scopeFootnote.textContent = 'Ingen position — ange koordinater manuellt.';
  }

  els.manualSetBtn.addEventListener('click', function(){
    var lat = parseFloat(els.latInput.value.replace(',', '.'));
    var lon = parseFloat(els.lonInput.value.replace(',', '.'));
    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180){
      setStatus('Ogiltiga koordinater. Kontrollera format (t.ex. 59.33).', 'err');
      return;
    }
    state.userLat = lat;
    state.userLon = lon;
    setLamp('indPosition', 'ok');
    setStatus('Manuell position satt — hämtar flygdata…', '');
    updateMapPosition(lat, lon);
    startTracking();
  });

  els.locBtn.addEventListener('click', function(){
    els.manualPanel.classList.toggle('open');
    requestLocation();
  });

  // ---------- fetching ----------
  function fetchJsonTimeout(url, timeoutMs){
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = controller ? setTimeout(function(){ controller.abort(); }, timeoutMs) : null;
    return fetch(url, { cache:'no-store', signal: controller ? controller.signal : undefined })
      .then(function(res){
        if (timer) clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .catch(function(err){
        if (timer) clearTimeout(timer);
        throw err;
      });
  }

  function transportList(url){
    var encoded = encodeURIComponent(url);
    return [
      { label: 'direkt', url: url, timeout: 5000 },
      { label: 'codetabs-proxy', url: 'https://api.codetabs.com/v1/proxy?quest=' + encoded, timeout: 8000 },
      { label: 'allorigins-proxy', url: 'https://api.allorigins.win/raw?url=' + encoded, timeout: 8000 },
      { label: 'corsproxy.io', url: 'https://corsproxy.io/?url=' + encoded, timeout: 8000 }
    ];
  }

  function raceTransports(candidates, onWin){
    return new Promise(function(resolve, reject){
      var settled = false;
      var errors = [];
      candidates.forEach(function(t){
        fetchJsonTimeout(t.url, t.timeout).then(function(data){
          if (settled) return;
          settled = true;
          if (onWin) onWin(t.label);
          resolve(data);
        }).catch(function(err){
          errors.push(t.label + ': ' + err.message);
          if (!settled && errors.length >= candidates.length){
            settled = true;
            reject(new Error(errors.join(' / ')));
          }
        });
      });
    });
  }

  // First call for a given source (or after its preferred transport starts failing) races
  // direct + all proxies to find what works. Once a transport is known-good, later polls
  // reuse just that one request instead of hammering every proxy every 8 seconds — much
  // gentler on the free proxy services while still fast.
  function fetchJsonResilient(url, prefKey){
    var all = transportList(url);
    var preferredLabel = prefKey ? state.preferredTransport[prefKey] : null;
    var preferred = preferredLabel ? all.filter(function(t){ return t.label === preferredLabel; })[0] : null;

    if (preferred){
      return fetchJsonTimeout(preferred.url, preferred.timeout).catch(function(){
        // preferred transport failed this time — fall back to a full race and re-learn
        return raceTransports(all, function(winner){
          if (prefKey) state.preferredTransport[prefKey] = winner;
        });
      });
    }
    return raceTransports(all, function(winner){
      if (prefKey) state.preferredTransport[prefKey] = winner;
    });
  }

  // Shared parser for the "readsb"/ADSBX-v2-style response format used by both
  // adsb.lol and adsb.fi (opendata.adsb.fi is an explicitly ADSBX-v2-compatible mirror).
  function parseReadsbStyle(data, lat, lon, rangeKm){
    var raw = (data && data.ac) ? data.ac : [];
    var list = [];
    for (var i = 0; i < raw.length; i++){
      var s = raw[i];
      if (typeof s.lat !== 'number' || typeof s.lon !== 'number') continue;
      var dist = haversineKm(lat, lon, s.lat, s.lon);
      if (dist > rangeKm) continue;
      var onGround = (s.alt_baro === 'ground');
      var altM = (!onGround && typeof s.alt_baro === 'number') ? s.alt_baro * 0.3048 : (onGround ? 0 : null);
      var velMs = (typeof s.gs === 'number') ? s.gs * 0.514444 : null;
      list.push({
        icao24: (s.hex || (s.flight || String(i))).toLowerCase(),
        callsign: (s.flight || '').trim() || '—',
        country: s.t || s.r || '—',
        lon: s.lon, lat: s.lat,
        baroAlt: altM,
        onGround: onGround,
        velocity: velMs,
        trueTrack: (typeof s.track === 'number') ? s.track : null,
        geoAlt: null,
        dist: dist,
        bearing: bearingDeg(lat, lon, s.lat, s.lon)
      });
    }
    return list;
  }

  function fetchFromAdsbLol(lat, lon, rangeKm){
    var radiusNm = Math.min(rangeKm / 1.852, 250);
    var url = 'https://api.adsb.lol/v2/point/' + lat + '/' + lon + '/' + radiusNm.toFixed(1);
    return fetchJsonResilient(url, 'adsblol').then(function(data){
      return parseReadsbStyle(data, lat, lon, rangeKm);
    });
  }

  function fetchFromAdsbFi(lat, lon, rangeKm){
    var radiusNm = Math.min(rangeKm / 1.852, 250);
    var url = 'https://opendata.adsb.fi/api/v2/lat/' + lat + '/lon/' + lon + '/dist/' + radiusNm.toFixed(1);
    return fetchJsonResilient(url, 'adsbfi').then(function(data){
      return parseReadsbStyle(data, lat, lon, rangeKm);
    });
  }

  function fetchFromOpenSky(lat, lon, rangeKm){
    var bb = boundingBox(lat, lon, rangeKm);
    var url = 'https://opensky-network.org/api/states/all?lamin=' + bb.lamin +
              '&lomin=' + bb.lomin + '&lamax=' + bb.lamax + '&lomax=' + bb.lomax;
    return fetchJsonResilient(url, 'opensky').then(function(data){
      var raw = data && data.states ? data.states : [];
      var list = [];
      for (var i = 0; i < raw.length; i++){
        var s = raw[i];
        var lon2 = s[5], lat2 = s[6];
        if (lat2 === null || lon2 === null) continue;
        var dist = haversineKm(lat, lon, lat2, lon2);
        if (dist > rangeKm) continue;
        list.push({
          icao24: s[0],
          callsign: (s[1] || '').trim() || '—',
          country: s[2] || '—',
          lon: lon2, lat: lat2,
          baroAlt: s[7],
          onGround: s[8],
          velocity: s[9],
          trueTrack: s[10],
          geoAlt: s[13],
          dist: dist,
          bearing: bearingDeg(lat, lon, lat2, lon2)
        });
      }
      return list;
    });
  }

  // adsb.lol and adsb.fi are both free, keyless, and built for frequent polling — they're
  // raced against each other immediately. OpenSky has a much stricter anonymous quota, so
  // it's only woken up if neither has answered within a short grace window.
  function fetchAircraft(){
    if (state.userLat === null || state.fetching) return;
    state.fetching = true;
    els.loadingState.style.display = 'block';
    els.emptyState.style.display = 'none';
    setLamp('indApi', 'warn');
    setLamp('indUpdated', 'warn');

    var lat = state.userLat, lon = state.userLon, rangeKm = state.rangeKm;
    var settled = false;
    var errors = [];
    var expected = 2; // adsb.lol + adsb.fi race immediately
    var openSkyStarted = false;
    var graceTimer = null;

    function finishIfDone(){
      if (!settled && errors.length >= expected){
        state.failureStreak++;
        var backoff = Math.min(state.refreshIntervalMs * Math.pow(2, state.failureStreak), state.maxBackoffMs);
        setStatus('Kunde inte hämta flygdata från någon källa (' + errors.join(' · ') + '). Försöker igen om ' + Math.round(backoff/1000) + 's…', 'err');
        setLamp('indApi', 'err');
        setLamp('indUpdated', 'err');
        state.fetching = false;
        els.loadingState.style.display = 'none';
        scheduleNextFetch(backoff);
      }
    }

    function startOpenSky(){
      if (openSkyStarted || settled) return;
      openSkyStarted = true;
      expected = 3;
      fetchFromOpenSky(lat, lon, rangeKm).then(function(list){
        if (settled) return;
        settled = true;
        applyAircraftResult(list, 'OpenSky');
      }).catch(function(err){
        errors.push('OpenSky: ' + err.message);
        finishIfDone();
      });
    }

    graceTimer = setTimeout(startOpenSky, 2500);

    var tier1FailCount = 0;
    function tier1Attempt(promise, label){
      promise.then(function(list){
        if (settled) return;
        settled = true;
        clearTimeout(graceTimer);
        applyAircraftResult(list, label);
      }).catch(function(err){
        errors.push(label + ': ' + err.message);
        tier1FailCount++;
        if (tier1FailCount >= 2){
          clearTimeout(graceTimer);
          startOpenSky();
        }
        finishIfDone();
      });
    }

    tier1Attempt(fetchFromAdsbLol(lat, lon, rangeKm), 'adsb.lol');
    tier1Attempt(fetchFromAdsbFi(lat, lon, rangeKm), 'adsb.fi');
  }

  function applyAircraftResult(list, sourceName){
    state.aircraft = list;
    state.failureStreak = 0;
    state.lastUpdateTs = Date.now();
    setLamp('indApi', 'ok');
    setLamp('indUpdated', 'ok');
    els.indUpdatedTime.textContent = new Date(state.lastUpdateTs).toLocaleTimeString('sv-SE');
    setStatus('Live (' + sourceName + ') — ' + list.length + ' flygplan inom ' + state.rangeKm + ' km', 'live');
    render();
    state.fetching = false;
    scheduleNextFetch(state.refreshIntervalMs);
  }

  function scheduleNextFetch(delayMs){
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(fetchAircraft, delayMs);
  }

  function startTracking(){
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.failureStreak = 0;
    fetchAircraft();
  }

  els.refreshBtn.addEventListener('click', function(){
    if (state.userLat !== null){
      state.failureStreak = 0;
      if (state.refreshTimer) clearTimeout(state.refreshTimer);
      fetchAircraft();
    } else {
      requestLocation();
    }
  });

  els.rangeSelect.addEventListener('change', function(){
    state.rangeKm = parseInt(els.rangeSelect.value, 10);
    els.rangeLabel.textContent = state.rangeKm + ' KM';
    safeSetStored(RANGE_KEY, String(state.rangeKm));
    buildStaticScope();
    updateMapRange();
    if (state.userLat !== null) fetchAircraft();
    else renderBlips();
  });

  // ---------- rendering: radar scope ----------
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs){
    var el = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function buildStaticScope(){
    var svg = els.scopeSvg;
    svg.innerHTML = '';
    var cx = 230, cy = 230, maxR = 195;

    // range rings
    var rings = 4;
    for (var i = 1; i <= rings; i++){
      var r = (maxR / rings) * i;
      svg.appendChild(svgEl('circle', {class:'radar-ring', cx:cx, cy:cy, r:r, 'stroke-width':1}));
      var kmVal = Math.round(state.rangeKm * (i/rings));
      var label = svgEl('text', {class:'ring-label', x:cx+4, y:cy-r+12, 'font-size':9, 'font-family':'JetBrains Mono, monospace'});
      label.textContent = kmVal + 'km';
      svg.appendChild(label);
    }

    // cross lines
    svg.appendChild(svgEl('line', {class:'radar-cross', x1:cx, y1:cy-maxR, x2:cx, y2:cy+maxR, 'stroke-width':1}));
    svg.appendChild(svgEl('line', {class:'radar-cross', x1:cx-maxR, y1:cy, x2:cx+maxR, y2:cy, 'stroke-width':1}));

    // compass labels
    var compass = [['N',cx,cy-maxR-10],['S',cx,cy+maxR+16],['V',cx-maxR-14,cy+4],['Ö',cx+maxR+8,cy+4]];
    compass.forEach(function(c){
      var t = svgEl('text', {class:'compass-label', x:c[1], y:c[2], 'font-size':12, 'font-family':'JetBrains Mono, monospace', 'text-anchor':'middle', 'font-weight':'600'});
      t.textContent = c[0];
      svg.appendChild(t);
    });

    // sweep group
    var sweepGroup = svgEl('g', {class:'sweep', id:'sweepGroup'});
    var sweepGrad = svgEl('defs', {});
    var grad = svgEl('linearGradient', {id:'sweepGrad', x1:'0', y1:'0', x2:'1', y2:'0'});
    grad.appendChild(svgEl('stop', {class:'sweep-stop-a', offset:'0%'}));
    grad.appendChild(svgEl('stop', {class:'sweep-stop-b', offset:'100%'}));
    sweepGrad.appendChild(grad);
    svg.appendChild(sweepGrad);
    var sweepPath = svgEl('path', {
      d: describeSector(cx, cy, maxR, -14, 0),
      fill: 'url(#sweepGrad)'
    });
    sweepGroup.appendChild(sweepPath);
    svg.appendChild(sweepGroup);

    // center marker (user)
    var centerGroup = svgEl('g', {class:'center-mark', style:'cursor:pointer;'});
    centerGroup.appendChild(svgEl('circle', {cx:cx, cy:cy, r:16, fill:'transparent'})); // easy tap target
    centerGroup.appendChild(svgEl('circle', {class:'center-dot', cx:cx, cy:cy, r:4}));
    centerGroup.appendChild(svgEl('circle', {class:'center-ring', cx:cx, cy:cy, r:9, 'stroke-width':1, opacity:0.5}));
    centerGroup.addEventListener('click', showLocationInfo);
    svg.appendChild(centerGroup);

    // group for blips (populated on each render)
    svg.appendChild(svgEl('g', {id:'blipGroup'}));
  }

  function describeSector(cx, cy, r, startAngle, endAngle){
    function polar(angleDeg){
      var a = toRad(angleDeg - 90);
      return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    }
    var p1 = polar(startAngle);
    var p2 = polar(endAngle);
    return 'M ' + cx + ' ' + cy + ' L ' + p1.x + ' ' + p1.y + ' A ' + r + ' ' + r + ' 0 0 1 ' + p2.x + ' ' + p2.y + ' Z';
  }

  function renderBlips(){
    var cx = 230, cy = 230, maxR = 195;
    var group = document.getElementById('blipGroup');
    if (!group) return;
    group.innerHTML = '';

    state.aircraft.forEach(function(ac){
      var r = Math.min((ac.dist / state.rangeKm) * maxR, maxR);
      var angleRad = toRad(ac.bearing);
      var x = cx + r * Math.sin(angleRad);
      var y = cy - r * Math.cos(angleRad);

      var isSelected = ac.icao24 === state.selectedIcao;
      var g = svgEl('g', {class:'blip' + (isSelected ? ' selected' : ''), 'data-icao':ac.icao24, style:'cursor:pointer;'});

      // heading tick
      if (ac.trueTrack !== null && ac.trueTrack !== undefined){
        var hr = toRad(ac.trueTrack);
        var hx = x + 9 * Math.sin(hr);
        var hy = y - 9 * Math.cos(hr);
        g.appendChild(svgEl('line', {class:'blip-heading', x1:x, y1:y, x2:hx, y2:hy, 'stroke-width':1.4, opacity:0.85}));
      }

      var core = svgEl('circle', {class:'blip-core', cx:x, cy:y, r:3.2});
      g.appendChild(core);

      if (ac.callsign && ac.callsign !== '—'){
        var label = svgEl('text', {class:'blip-label', x:x+6, y:y-6, 'font-size':8.5, 'font-family':'JetBrains Mono, monospace'});
        label.textContent = ac.callsign;
        g.appendChild(label);
      }

      g.addEventListener('click', function(){
        selectAircraft(ac.icao24);
      });

      group.appendChild(g);
    });
  }

  // ---------- rendering: table ----------
  function sortAircraft(){
    var key = state.sortKey;
    var arr = state.aircraft.slice();
    arr.sort(function(a,b){
      var av, bv;
      switch(key){
        case 'callsign': av = a.callsign; bv = b.callsign; break;
        case 'alt': av = a.baroAlt||0; bv = b.baroAlt||0; break;
        case 'spd': av = a.velocity||0; bv = b.velocity||0; break;
        case 'hdg': av = a.trueTrack||0; bv = b.trueTrack||0; break;
        case 'country': av = a.country; bv = b.country; break;
        default: av = a.dist; bv = b.dist;
      }
      if (av < bv) return state.sortAsc ? -1 : 1;
      if (av > bv) return state.sortAsc ? 1 : -1;
      return 0;
    });
    return arr;
  }

  function renderTable(){
    var arr = sortAircraft();
    els.acTableBody.innerHTML = '';
    els.countLabel.textContent = arr.length;

    if (arr.length === 0){
      els.emptyState.style.display = 'block';
      els.acTable.style.display = 'none';
    } else {
      els.emptyState.style.display = 'none';
      els.acTable.style.display = 'table';
    }

    arr.forEach(function(ac){
      var tr = document.createElement('tr');
      if (ac.icao24 === state.selectedIcao) tr.className = 'selected';
      tr.innerHTML =
        '<td class="callsign">' + ac.callsign + '</td>' +
        '<td>' + (ac.baroAlt !== null ? Math.round(ac.baroAlt) + ' m' : '—') + '</td>' +
        '<td>' + (ac.velocity !== null ? Math.round(ac.velocity*3.6) + ' km/h' : '—') + '</td>' +
        '<td>' + ac.dist.toFixed(1) + ' km</td>' +
        '<td>' + (ac.trueTrack !== null ? Math.round(ac.trueTrack) + '°' : '—') + '</td>' +
        '<td class="dim">' + ac.country + '</td>';
      tr.addEventListener('click', function(icao){
        return function(){ selectAircraft(icao); };
      }(ac.icao24));
      els.acTableBody.appendChild(tr);
    });
  }

  // ---------- aircraft lookup (type, manufacturer, owner, photo via adsbdb.com) ----------
  var aircraftInfoCache = {}; // icao24 -> { status: 'loading'|'ok'|'none'|'error', data, message }

  function fetchAircraftInfo(icao24){
    var key = (icao24 || '').trim().toLowerCase();
    if (!key) return;
    var cached = aircraftInfoCache[key];
    if (cached && cached.status !== 'error') return; // already loading/loaded

    aircraftInfoCache[key] = { status:'loading' };
    fetchJsonResilient('https://api.adsbdb.com/v0/aircraft/' + encodeURIComponent(key))
      .then(function(data){
        var ac = data && data.response && data.response.aircraft;
        aircraftInfoCache[key] = ac ? { status:'ok', data: ac } : { status:'none' };
        if (state.selectedIcao === icao24) renderDetail();
      })
      .catch(function(err){
        aircraftInfoCache[key] = { status:'error', message: err.message };
        if (state.selectedIcao === icao24) renderDetail();
      });
  }

  function aircraftInfoBlockHtml(icao24){
    var key = (icao24 || '').trim().toLowerCase();
    var entry = aircraftInfoCache[key];
    if (!entry || entry.status === 'loading'){
      return '<div class="route-block"><p class="route-status">Hämtar flygplansdata…</p></div>';
    }
    if (entry.status === 'none'){
      return '<div class="route-block"><p class="route-status">Flygplanet (' + icao24.toUpperCase() + ') finns inte i flygplansdatabasen.</p></div>';
    }
    if (entry.status === 'error'){
      return '<div class="route-block"><p class="route-status">Kunde inte hämta flygplansdata (' + entry.message + ').</p></div>';
    }
    var d = entry.data;
    var html = '<div class="route-block">';
    html += '<div class="route-airline"><strong>' + (d.manufacturer || '') + (d.manufacturer && d.type ? ' ' : '') + (d.type || 'Okänd typ') + '</strong>' + (d.icao_type ? ' · ' + d.icao_type : '') + '</div>';
    html += '<div class="detail-grid">';
    html += '<div class="detail-item"><div class="k">Registrering</div><div class="v" style="font-size:14px;">' + (d.registration || '—') + '</div></div>';
    html += '<div class="detail-item"><div class="k">Ägare / operatör</div><div class="v" style="font-size:13px;">' + (d.registered_owner || '—') + '</div></div>';
    html += '<div class="detail-item"><div class="k">Registrerat land</div><div class="v" style="font-size:13px;">' + (d.registered_owner_country_name || '—') + '</div></div>';
    html += '</div>';
    if (d.url_photo_thumbnail){
      html += '<a href="' + d.url_photo + '" target="_blank" rel="noopener"><img src="' + d.url_photo_thumbnail + '" alt="Foto av ' + (d.registration || 'flygplanet') + '" style="width:100%; border-radius:6px; margin-top:10px; display:block;"></a>';
    }
    html += '</div>';
    return html;
  }

  // ---------- route lookup (airline, origin, destination via adsbdb.com) ----------
  var routeCache = {}; // callsign -> { status: 'loading'|'ok'|'none'|'error', data, message }

  function fetchRoute(callsign){
    var key = (callsign || '').trim();
    if (!key || key === '—') return;
    var cached = routeCache[key];
    if (cached && cached.status !== 'error') return; // already loading/loaded

    routeCache[key] = { status:'loading' };
    fetchJsonResilient('https://api.adsbdb.com/v0/callsign/' + encodeURIComponent(key))
      .then(function(data){
        var fr = data && data.response && data.response.flightroute;
        routeCache[key] = fr ? { status:'ok', data: fr } : { status:'none' };
        if (state.selectedIcao){
          var ac = state.aircraft.filter(function(a){ return a.icao24 === state.selectedIcao; })[0];
          if (ac && ac.callsign.trim() === key) renderDetail();
        }
      })
      .catch(function(err){
        routeCache[key] = { status:'error', message: err.message };
        if (state.selectedIcao){
          var ac = state.aircraft.filter(function(a){ return a.icao24 === state.selectedIcao; })[0];
          if (ac && ac.callsign.trim() === key) renderDetail();
        }
      });
  }

  function routeBlockHtml(callsign){
    var key = (callsign || '').trim();
    if (!key || key === '—'){
      return '<div class="route-block"><p class="route-status">Ingen anropssignal sänds — kan inte slå upp rutt.</p></div>';
    }
    var entry = routeCache[key];
    if (!entry || entry.status === 'loading'){
      return '<div class="route-block"><p class="route-status">Hämtar ruttinformation…</p></div>';
    }
    if (entry.status === 'none'){
      return '<div class="route-block"><p class="route-status">Ingen ruttinformation hittad för ' + key + ' (okänd i ruttdatabasen — vanligt för privat-, militär- eller charterflyg).</p></div>';
    }
    if (entry.status === 'error'){
      return '<div class="route-block"><p class="route-status">Kunde inte hämta ruttinformation (' + entry.message + ').</p></div>';
    }
    var fr = entry.data;
    var airlineName = (fr.airline && fr.airline.name) ? fr.airline.name : 'Okänt flygbolag';
    var origin = fr.origin, dest = fr.destination;
    var html = '<div class="route-block">';
    html += '<div class="route-airline"><strong>' + airlineName + '</strong>' + ((fr.airline && fr.airline.country) ? ' · ' + fr.airline.country : '') + '</div>';
    if (origin && dest){
      html += '<div class="route-path">';
      html += '<div class="route-airport"><div class="code">' + (origin.iata_code || origin.icao_code || '—') + '</div><div class="name">' + origin.municipality + ', ' + origin.country_name + '</div></div>';
      html += '<div class="route-arrow">→</div>';
      html += '<div class="route-airport" style="text-align:right;"><div class="code">' + (dest.iata_code || dest.icao_code || '—') + '</div><div class="name">' + dest.municipality + ', ' + dest.country_name + '</div></div>';
      html += '</div>';
    } else {
      html += '<p class="route-status">Ofullständig ruttdata.</p>';
    }
    html += '</div>';
    return html;
  }

  function selectAircraft(icao){
    state.showingLocationInfo = false;
    state.selectedIcao = (state.selectedIcao === icao) ? null : icao;
    render();
    renderDetail();
    if (state.selectedIcao){
      var ac = state.aircraft.filter(function(a){ return a.icao24 === state.selectedIcao; })[0];
      if (ac){
        fetchRoute(ac.callsign);
        fetchAircraftInfo(ac.icao24);
      }
    }
  }

  // ---------- location info (elevation, place, timezone, sunrise/sunset via zenith click) ----------
  var locationInfoCache = {};

  function showLocationInfo(){
    if (state.userLat === null) return;
    state.selectedIcao = null;
    state.showingLocationInfo = true;
    els.detailTitle.textContent = 'Din position';
    render();
    renderDetail();
    fetchLocationInfo(state.userLat, state.userLon);
  }

  function fetchLocationInfo(lat, lon){
    var key = lat.toFixed(3) + ',' + lon.toFixed(3);
    var cached = locationInfoCache[key];
    if (cached && cached.status !== 'error') { renderDetail(); return; }

    locationInfoCache[key] = { status:'loading' };
    renderDetail();

    var elevUrl = 'https://api.open-meteo.com/v1/elevation?latitude=' + lat + '&longitude=' + lon;
    var geoUrl = 'https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' + lat + '&longitude=' + lon + '&localityLanguage=sv';
    var sunUrl = 'https://api.sunrise-sunset.org/json?lat=' + lat + '&lng=' + lon + '&formatted=0';

    Promise.all([
      fetchJsonResilient(elevUrl, 'elevation').catch(function(e){ return { __error: e.message }; }),
      fetchJsonResilient(geoUrl, 'geocode').catch(function(e){ return { __error: e.message }; }),
      fetchJsonResilient(sunUrl, 'sun').catch(function(e){ return { __error: e.message }; })
    ]).then(function(results){
      var elevRes = results[0], geoRes = results[1], sunRes = results[2];
      var entry = { status:'ok' };

      if (elevRes && !elevRes.__error && elevRes.elevation && typeof elevRes.elevation[0] === 'number'){
        entry.elevation = elevRes.elevation[0];
      }
      if (geoRes && !geoRes.__error){
        entry.place = {
          locality: geoRes.locality || geoRes.city || geoRes.localityInfo && geoRes.localityInfo.administrative && geoRes.localityInfo.administrative[0] && geoRes.localityInfo.administrative[0].name || null,
          subdivision: geoRes.principalSubdivision || null,
          country: geoRes.countryName || null
        };
      }
      if (sunRes && !sunRes.__error && sunRes.results){
        entry.sun = sunRes.results;
      }
      try { entry.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch(e){ entry.timezone = null; }

      locationInfoCache[key] = entry;
      if (state.showingLocationInfo) renderDetail();
    });
  }

  function formatLocalTime(isoUtc){
    if (!isoUtc) return '—';
    try {
      var d = new Date(isoUtc);
      return d.toLocaleTimeString('sv-SE', { hour:'2-digit', minute:'2-digit' });
    } catch(e){ return '—'; }
  }

  function renderLocationDetail(){
    var lat = state.userLat, lon = state.userLon;
    var key = lat.toFixed(3) + ',' + lon.toFixed(3);
    var entry = locationInfoCache[key];

    var html = '<div class="detail-grid">' +
      '<div class="detail-item"><div class="k">Latitud</div><div class="v" style="font-size:13px;">' + lat.toFixed(4) + '°</div></div>' +
      '<div class="detail-item"><div class="k">Longitud</div><div class="v" style="font-size:13px;">' + lon.toFixed(4) + '°</div></div>';

    if (!entry || entry.status === 'loading'){
      html += '<div class="detail-item"><div class="k">Höjd över havet</div><div class="v" style="font-size:13px;">Hämtar…</div></div>';
      html += '</div><p class="route-status" style="margin-top:10px;">Hämtar platsdata…</p>';
      els.detailContent.innerHTML = html;
      return;
    }

    html += '<div class="detail-item"><div class="k">Höjd över havet</div><div class="v">' + (typeof entry.elevation === 'number' ? Math.round(entry.elevation) + ' m' : '—') + '</div></div>';
    if (entry.timezone){
      html += '<div class="detail-item"><div class="k">Tidszon</div><div class="v" style="font-size:13px;">' + entry.timezone + '</div></div>';
    }
    html += '</div>';

    if (entry.place && (entry.place.locality || entry.place.subdivision || entry.place.country)){
      var placeParts = [entry.place.locality, entry.place.subdivision, entry.place.country].filter(Boolean);
      html += '<div class="route-block"><div class="route-airline"><strong>' + placeParts.join(', ') + '</strong></div></div>';
    }

    if (entry.sun){
      html += '<div class="route-block">';
      html += '<div class="route-airline">Sol (lokal tid, ungefärlig)</div>';
      html += '<div class="detail-grid" style="grid-template-columns:repeat(3,1fr);">';
      html += '<div class="detail-item"><div class="k">Soluppgång</div><div class="v" style="font-size:14px;">' + formatLocalTime(entry.sun.sunrise) + '</div></div>';
      html += '<div class="detail-item"><div class="k">Solnedgång</div><div class="v" style="font-size:14px;">' + formatLocalTime(entry.sun.sunset) + '</div></div>';
      html += '<div class="detail-item"><div class="k">Dagslängd</div><div class="v" style="font-size:14px;">' + (entry.sun.day_length ? Math.round(entry.sun.day_length/3600) + 't ' + Math.round((entry.sun.day_length%3600)/60) + 'm' : '—') + '</div></div>';
      html += '</div></div>';
    }

    els.detailContent.innerHTML = html;
  }

  function renderDetail(){
    if (state.showingLocationInfo){
      els.detailTitle.textContent = 'Din position';
      if (state.userLat === null){
        els.detailContent.innerHTML = '<p class="detail-empty" style="margin-top:10px;">Ingen position tillgänglig ännu.</p>';
        return;
      }
      renderLocationDetail();
      return;
    }
    els.detailTitle.textContent = 'Vald flygning';
    if (!state.selectedIcao){
      els.detailContent.innerHTML = '<p class="detail-empty" style="margin-top:10px;">Klicka på ett flygplan i listan eller på radarn för detaljer — eller på din egen position (mitten) för platsdata.</p>';
      return;
    }
    var ac = state.aircraft.filter(function(a){ return a.icao24 === state.selectedIcao; })[0];
    if (!ac){
      els.detailContent.innerHTML = '<p class="detail-empty" style="margin-top:10px;">Flygplanet är inte längre inom räckvidd.</p>';
      state.selectedIcao = null;
      return;
    }
    var compassPoints = ['N','NNÖ','NÖ','ÖNÖ','Ö','ÖSÖ','SÖ','SSÖ','S','SSV','SV','VSV','V','VNV','NV','NNV'];
    var idx = Math.round((ac.bearing % 360) / 22.5) % 16;
    els.detailContent.innerHTML =
      '<div class="detail-grid">' +
        '<div class="detail-item"><div class="k">Anropssignal</div><div class="v">' + ac.callsign + '</div></div>' +
        '<div class="detail-item"><div class="k">Typ / info</div><div class="v" style="font-size:13px;">' + ac.country + '</div></div>' +
        '<div class="detail-item"><div class="k">Höjd (baro)</div><div class="v">' + (ac.baroAlt!==null? Math.round(ac.baroAlt)+' m':'—') + '</div></div>' +
        '<div class="detail-item"><div class="k">Fart</div><div class="v">' + (ac.velocity!==null? Math.round(ac.velocity*3.6)+' km/h':'—') + '</div></div>' +
        '<div class="detail-item"><div class="k">Avstånd</div><div class="v">' + ac.dist.toFixed(1) + ' km</div></div>' +
        '<div class="detail-item"><div class="k">Riktning från dig</div><div class="v">' + compassPoints[idx] + ' (' + Math.round(ac.bearing) + '°)</div></div>' +
        '<div class="detail-item"><div class="k">Kurs (heading)</div><div class="v">' + (ac.trueTrack!==null? Math.round(ac.trueTrack)+'°':'—') + '</div></div>' +
        '<div class="detail-item"><div class="k">Status</div><div class="v" style="font-size:13px;">' + (ac.onGround ? 'På marken' : 'I luften') + '</div></div>' +
      '</div>' +
      aircraftInfoBlockHtml(ac.icao24) +
      routeBlockHtml(ac.callsign);
  }

  // sortable headers
  document.querySelectorAll('#acTable thead th').forEach(function(th){
    th.addEventListener('click', function(){
      var key = th.getAttribute('data-key');
      if (state.sortKey === key) state.sortAsc = !state.sortAsc;
      else { state.sortKey = key; state.sortAsc = true; }
      renderTable();
    });
  });

  function render(){
    els.loadingState.style.display = 'none';
    if (!document.getElementById('sweepGroup')) buildStaticScope();
    renderBlips();
    renderTable();
    renderDetail();
    els.scopeFootnote.textContent = state.aircraft.length + ' objekt spårade — ' + new Date().toLocaleTimeString('sv-SE');
  }

  // ---------- freshness watchdog for the "Uppdaterad" lamp ----------
  // Orange-blink is reserved for an active in-flight request (set directly by fetchAircraft).
  // This watchdog only steps in while idle, to catch the case where updates have silently
  // stopped (e.g. a stalled timer) — green if the last successful update is still recent,
  // red if it's gone stale without a new attempt in flight.
  function tickFreshness(){
    if (state.fetching) return; // lifecycle events (warn/ok/err) already control the lamp
    if (!state.lastUpdateTs){
      setLamp('indUpdated', 'off');
      return;
    }
    var ageSec = (Date.now() - state.lastUpdateTs) / 1000;
    var errAt = (state.refreshIntervalMs / 1000) * 4;
    setLamp('indUpdated', ageSec <= errAt ? 'ok' : 'err');
  }
  setInterval(tickFreshness, 1000);

  // init
  setLamp('indPosition', 'off');
  setLamp('indApi', 'off');
  setLamp('indUpdated', 'off');
  els.rangeLabel.textContent = state.rangeKm + ' KM';
  buildStaticScope();
  requestLocation();

  if ('serviceWorker' in navigator){
    window.addEventListener('load', function(){
      navigator.serviceWorker.register('sw.js').catch(function(err){
        console.warn('Service worker-registrering misslyckades:', err.message);
      });
    });
  }

})();
