/* PoolSim map renderer — draws one World onto a canvas. */
(function (root) {
  'use strict';

  var PING_MS = 700;     // a new request's ping radius expands and fades
  var REROUTE_MS = 1100; // a cab that changes course mid-ride is highlighted
  var LOST_MS = 1600;    // a rider who gives up leaves a fading mark

  function readTheme() {
    var cs = getComputedStyle(document.documentElement);
    function v(name) { return cs.getPropertyValue(name).trim(); }
    return {
      street: v('--map-street'),
      block: v('--map-block'),
      solo: v('--solo'),
      pool1: v('--pool1'),
      shared: v('--shared'),
      idle: v('--idle'),
      ink: v('--ink'),
      bad: v('--bad'),
    };
  }

  function MapView(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.layer = document.createElement('canvas');
    this.world = null;
    this.size = 0;
    this.dpr = 1;
    this.hoverCab = null;
    this.theme = readTheme();
    this.resetEffects();
  }

  MapView.prototype.resetEffects = function () {
    this.seenArrivals = 0;
    this.seenLost = 0;
    this.pings = [];
    this.lostMarks = [];
    this.rerouteSeen = {};
    this.rerouteUntil = {};
  };

  MapView.prototype.setWorld = function (world) {
    this.world = world;
    this.resetEffects();
    this.buildStatic();
  };

  MapView.prototype.setTheme = function () {
    this.theme = readTheme();
    this.buildStatic();
  };

  MapView.prototype.resize = function (size) {
    size = Math.max(120, Math.floor(size));
    if (size === this.size) return;
    this.size = size;
    this.dpr = Math.min(2, root.devicePixelRatio || 1);
    this.canvas.width = this.layer.width = Math.round(size * this.dpr);
    this.canvas.height = this.layer.height = Math.round(size * this.dpr);
    this.canvas.style.width = this.canvas.style.height = size + 'px';
    this.buildStatic();
  };

  // Intersections sit on a lattice with a small margin around the city.
  MapView.prototype.geom = function () {
    var G = this.world.cfg.gridSize;
    var cell = this.size / (G - 1 + 1.4);
    return { G: G, cell: cell, pad: cell * 0.7 };
  };

  MapView.prototype.buildStatic = function () {
    if (!this.world || !this.size) return;
    var ctx = this.layer.getContext('2d');
    var g = this.geom(), th = this.theme;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = th.street;
    ctx.fillRect(0, 0, this.size, this.size);
    var street = Math.max(1.5, g.cell * 0.32);
    var side = g.cell - street;
    var r = Math.min(2, side * 0.18);
    ctx.fillStyle = th.block;
    ctx.beginPath();
    for (var i = 0; i < g.G - 1; i++) {
      for (var j = 0; j < g.G - 1; j++) {
        var x = g.pad + i * g.cell + street / 2;
        var y = g.pad + j * g.cell + street / 2;
        if (ctx.roundRect) ctx.roundRect(x, y, side, side, r);
        else ctx.rect(x, y, side, side);
      }
    }
    ctx.fill();
  };

  MapView.prototype.cabColor = function (cab) {
    var th = this.theme;
    if (cab.onboard.length === 2) return th.shared;
    if (!cab.riders.length) return th.idle;
    return cab.riders[0].pool ? th.pool1 : th.solo;
  };

  MapView.prototype.cabPoint = function (cab) {
    var g = this.geom();
    var x = cab.x, y = cab.y;
    if (cab.next) {
      x += (cab.next.x - cab.x) * cab.progress;
      y += (cab.next.y - cab.y) * cab.progress;
    }
    return { x: g.pad + x * g.cell, y: g.pad + y * g.cell };
  };

  MapView.prototype.traceRoute = function (ctx, cab, g) {
    var p = this.cabPoint(cab);
    ctx.moveTo(p.x, p.y);
    var cx = cab.x, cy = cab.y;
    if (cab.next) {
      cx = cab.next.x; cy = cab.next.y;
      ctx.lineTo(g.pad + cx * g.cell, g.pad + cy * g.cell);
    }
    for (var i = 0; i < cab.plan.length; i++) {
      var s = cab.plan[i];
      if (s.x !== cx) ctx.lineTo(g.pad + s.x * g.cell, g.pad + cy * g.cell);
      ctx.lineTo(g.pad + s.x * g.cell, g.pad + s.y * g.cell);
      cx = s.x; cy = s.y;
    }
  };

  // Pick up new requests, reroutes and give-ups since the last frame.
  MapView.prototype.collectEffects = function (nowMs) {
    var w = this.world, i;
    if (w.arrivalIdx < this.seenArrivals) this.resetEffects();
    for (i = Math.max(this.seenArrivals, w.arrivalIdx - 30); i < w.arrivalIdx; i++) {
      this.pings.push({ x: w.riders[i].ox, y: w.riders[i].oy, born: nowMs, pool: w.riders[i].pool });
    }
    this.seenArrivals = w.arrivalIdx;
    for (i = Math.max(this.seenLost, w.lostLog.length - 30); i < w.lostLog.length; i++) {
      var r = w.riders[w.lostLog[i]];
      this.lostMarks.push({ x: r.ox, y: r.oy, born: nowMs });
    }
    this.seenLost = w.lostLog.length;
    for (i = 0; i < w.cabs.length; i++) {
      var c = w.cabs[i];
      if (c.rerouteVersion !== (this.rerouteSeen[c.id] || 0)) {
        this.rerouteUntil[c.id] = nowMs + REROUTE_MS;
        this.rerouteSeen[c.id] = c.rerouteVersion;
      }
    }
    this.pings = this.pings.filter(function (p) { return nowMs - p.born < PING_MS; });
    this.lostMarks = this.lostMarks.filter(function (p) { return nowMs - p.born < LOST_MS; });
  };

  MapView.prototype.draw = function (nowMs) {
    if (!this.world || !this.size) return;
    var ctx = this.ctx, g = this.geom(), th = this.theme, w = this.world;
    var cell = g.cell;
    this.collectEffects(nowMs);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.layer, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.lineJoin = ctx.lineCap = 'round';

    var cabs = w.cabs, i, k, c, color, x, y;

    // Ping radius of new requests: every cab inside this diamond is asked.
    var R = w.cfg.pingRadius * cell;
    var edge = g.pad - cell * 0.5, span = (g.G - 1) * cell + cell;
    ctx.save();
    ctx.beginPath();
    ctx.rect(edge, edge, span, span);
    ctx.clip();
    for (i = 0; i < this.pings.length; i++) {
      var p = this.pings[i];
      var f = (nowMs - p.born) / PING_MS;
      var rr = R * Math.min(1, f * 1.6);
      x = g.pad + p.x * cell; y = g.pad + p.y * cell;
      ctx.globalAlpha = 0.5 * (1 - f);
      ctx.strokeStyle = p.pool ? th.pool1 : th.solo;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(x, y - rr); ctx.lineTo(x + rr, y); ctx.lineTo(x, y + rr); ctx.lineTo(x - rr, y); ctx.closePath();
      ctx.stroke();
      ctx.globalAlpha = 0.07 * (1 - f);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    // Planned routes; cabs that just rerouted mid-ride are drawn bold.
    for (i = 0; i < cabs.length; i++) {
      c = cabs[i];
      if (!c.plan.length) continue;
      var flash = (this.rerouteUntil[c.id] || 0) > nowMs && c.onboard.length > 0;
      var focus = c === this.hoverCab || flash;
      ctx.globalAlpha = focus ? 1 : 0.38;
      ctx.lineWidth = focus ? Math.max(1.75, cell * 0.3) : Math.max(1, cell * 0.18);
      ctx.strokeStyle = this.cabColor(c);
      ctx.beginPath();
      this.traceRoute(ctx, c, g);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Drop-off markers for committed riders.
    var sq = Math.max(3, cell * 0.5);
    for (i = 0; i < cabs.length; i++) {
      c = cabs[i];
      if (!c.plan.length) continue;
      color = this.cabColor(c);
      for (k = 0; k < c.plan.length; k++) {
        var s = c.plan[k];
        if (s.type !== 'dropoff') continue;
        x = g.pad + s.x * cell; y = g.pad + s.y * cell;
        ctx.fillStyle = th.street;
        ctx.fillRect(x - sq / 2 - 1, y - sq / 2 - 1, sq + 2, sq + 2);
        ctx.fillStyle = color;
        ctx.fillRect(x - sq / 2, y - sq / 2, sq, sq);
      }
    }

    // Riders waiting at the curb. Unmatched riders pulse.
    var rd = Math.max(2, cell * 0.26);
    var phase = (nowMs % 1600) / 1600;
    for (i = 0; i < w.arrivalIdx; i++) {
      var r = w.riders[i];
      if (r.state !== 'waiting' && r.state !== 'assigned') continue;
      x = g.pad + r.ox * cell; y = g.pad + r.oy * cell;
      color = r.pool ? th.pool1 : th.solo;
      if (r.state === 'waiting') {
        ctx.globalAlpha = 0.55 * (1 - phase);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, rd + phase * cell * 0.9, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = th.street;
      ctx.beginPath();
      ctx.arc(x, y, rd + 1.25, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, rd, 0, Math.PI * 2);
      ctx.fill();
    }

    // Riders who gave up.
    var xs = Math.max(3, cell * 0.45);
    ctx.strokeStyle = th.bad;
    ctx.lineWidth = 2;
    for (i = 0; i < this.lostMarks.length; i++) {
      var m = this.lostMarks[i];
      x = g.pad + m.x * cell; y = g.pad + m.y * cell;
      ctx.globalAlpha = 1 - (nowMs - m.born) / LOST_MS;
      ctx.beginPath();
      ctx.moveTo(x - xs, y - xs); ctx.lineTo(x + xs, y + xs);
      ctx.moveTo(x + xs, y - xs); ctx.lineTo(x - xs, y + xs);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Cabs. Idle cabs recede; shared cabs get a halo.
    var rc = Math.max(2.6, cell * 0.4);
    for (i = 0; i < cabs.length; i++) {
      c = cabs[i];
      var pt = this.cabPoint(c);
      color = this.cabColor(c);
      var n = c.onboard.length;
      var radius = !c.riders.length ? rc * 0.72 : n === 2 ? rc * 1.18 : rc;
      if (n === 2) {
        ctx.globalAlpha = 0.2;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, radius * 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = th.street;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, radius + 1.5, 0, Math.PI * 2);
      ctx.fill();
      if (c.riders.length && n === 0) {
        // Empty, driving to a pickup.
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1.25, radius * 0.45);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, radius - ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      if (c === this.hoverCab) {
        ctx.strokeStyle = th.ink;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, radius + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  };

  MapView.prototype.cabAt = function (mx, my) {
    if (!this.world) return null;
    var best = null, bestD = Math.max(9, this.geom().cell * 1.2);
    for (var i = 0; i < this.world.cabs.length; i++) {
      var p = this.cabPoint(this.world.cabs[i]);
      var d = Math.hypot(p.x - mx, p.y - my);
      if (d < bestD) { bestD = d; best = this.world.cabs[i]; }
    }
    return best;
  };

  root.MapView = MapView;
})(this);
