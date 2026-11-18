/*
 * PoolSim engine — pure simulation, no DOM.
 *
 * Two "twin" worlds are built from one scenario (same riders, same request
 * times, same cab start positions). One world allows pooling, the other
 * serves everyone solo. Comparing them isolates the effect of Pool.
 *
 * Model
 *  - City: G x G intersections, Manhattan metric. Cabs move one edge at a
 *    time and only turn at intersections, so a planned stop time is exactly
 *    the realised time (no traffic noise).
 *  - Requests arrive at random times over the whole run. A rider's "original
 *    estimate" is the solo in-car time: manhattan(origin, destination) / speed.
 *  - Each cab has a plan: an ordered list of pickups and drop-offs. A new pool
 *    request may be inserted anywhere in a pool cab's plan (the cab reroutes),
 *    so one rider can share with several co-riders over a single trip.
 *  - Hard rules checked on every insertion, for every rider in the plan:
 *      * never more than 2 riders aboard at any point of the plan;
 *      * a pool rider's in-car time <= maxDetour x their estimate;
 *      * an assigned rider's pickup slips at most pickupSlip seconds past
 *        the time they were promised;
 *      * the new rider's pickup is within pingRadius blocks of driving.
 *  - Unmatched riders give up after `patience` seconds.
 *  - Optional re-dispatch: an assigned rider still waiting for pickup is moved
 *    to a free cab that can reach them much sooner.
 *  - Driver pay: driverRate per occupied second, x(1 + X) while 2 are aboard.
 *    Driving to a pickup is unpaid. Running cost accrues per block driven.
 *  - Rider fare: fareRate x estimate, x(1 - Y) for pool opt-ins, charged at
 *    pickup whether or not a co-rider is ever found.
 */
// Wrapped in a named factory so app.js can also boot it inside a Web Worker.
function definePoolSim(root) {
  'use strict';

  var DEFAULTS = {
    gridSize: 50,       // intersections per side
    riders: 200,        // K
    cabs: 30,           // N
    duration: 300,      // P, simulated seconds
    poolOptIn: 60,      // % of riders who opt in to Pool
    maxDetour: 1.5,     // max in-car time / original estimate
    driverPremium: 25,  // X, % extra per second while 2 riders are aboard
    poolDiscount: 30,   // Y, % off the standard fare for opting in
    pingRadius: 15,     // blocks of driving from a cab to a pickup
    patience: 120,      // seconds a rider waits unmatched before giving up
    pickupSlip: 20,     // seconds a promised pickup may slip when a cab reroutes
    reassign: 1,        // 1 = move waiting riders to a cab that frees up closer
    cabSpeed: 1,        // blocks per second
    fareRate: 0.5,      // $ per second of original estimate
    driverRate: 0.35,   // $ per occupied second
    costPerBlock: 0.05, // driver's running cost, $ per block driven
    seed: 7,
  };

  var DT = 0.1;               // simulation step, seconds
  var DISPATCH_EVERY = 1;     // matching batch interval, seconds
  var MIN_TRIP_BLOCKS = 3;
  var MAX_PLAN_STOPS = 6;     // pending stops a cab may hold
  var VEHICLE_WEIGHT = 0.5;   // value of a cab-second relative to a rider-second
  var MAX_QUEUE_SCAN = 250;   // riders considered per dispatch batch (oldest first)
  var REASSIGN_MIN_GAIN = 8;  // seconds of pickup a re-dispatch must save...
  var REASSIGN_MIN_RATIO = 0.7; // ...and the new ETA must be <= 70% of the old
  var EPS = 1e-6;

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function manhattan(ax, ay, bx, by) {
    return Math.abs(ax - bx) + Math.abs(ay - by);
  }

  function normalizeConfig(input) {
    var cfg = {};
    for (var k in DEFAULTS) {
      var v = input && input[k] != null ? Number(input[k]) : DEFAULTS[k];
      cfg[k] = isFinite(v) ? v : DEFAULTS[k];
    }
    cfg.gridSize = Math.max(10, Math.round(cfg.gridSize));
    cfg.riders = Math.max(0, Math.round(cfg.riders));
    cfg.cabs = Math.max(1, Math.round(cfg.cabs));
    cfg.duration = Math.max(1, cfg.duration);
    cfg.maxDetour = Math.max(1, cfg.maxDetour);
    cfg.pingRadius = Math.max(1, cfg.pingRadius);
    cfg.patience = Math.max(1, cfg.patience);
    cfg.pickupSlip = Math.max(0, cfg.pickupSlip);
    cfg.reassign = cfg.reassign ? 1 : 0;
    cfg.cabSpeed = Math.max(0.1, cfg.cabSpeed);
    cfg.seed = Math.round(cfg.seed) >>> 0;
    return cfg;
  }

  // Demand: uniform random origins/destinations, request times uniform over [0, P).
  function makeScenario(cfg) {
    var rng = mulberry32(cfg.seed);
    var G = cfg.gridSize;
    function node() {
      return { x: Math.floor(rng() * G), y: Math.floor(rng() * G) };
    }
    var cabs = [];
    for (var i = 0; i < cfg.cabs; i++) cabs.push(node());
    var riders = [];
    for (var j = 0; j < cfg.riders; j++) {
      var requestAt = rng() * cfg.duration;
      var o = node();
      var d = node();
      while (manhattan(o.x, o.y, d.x, d.y) < MIN_TRIP_BLOCKS) d = node();
      // Drawn for every rider so changing the opt-in % never moves anyone.
      var optIn = rng() * 100 < cfg.poolOptIn;
      riders.push({ requestAt: requestAt, ox: o.x, oy: o.y, dx: d.x, dy: d.y, optIn: optIn });
    }
    riders.sort(function (a, b) { return a.requestAt - b.requestAt; });
    riders.forEach(function (r, idx) { r.id = idx; });
    return { cabs: cabs, riders: riders };
  }

  function World(cfg, scenario, poolEnabled) {
    this.cfg = cfg;
    this.poolEnabled = poolEnabled;
    this.speed = cfg.cabSpeed;
    this.X = cfg.driverPremium / 100;
    this.Y = cfg.poolDiscount / 100;
    this.steps = 0;
    this.t = 0;
    this.nextDispatchAt = 0;
    this.arrivalIdx = 0;
    this.queue = [];
    this.series = [];
    this.lostLog = [];
    this.totals = {
      revenue: 0, driverPay: 0, premium: 0, discount: 0,
      requested: 0, pickedUp: 0, completed: 0, lost: 0, waitSum: 0,
      reroutes: 0, reassigned: 0,
    };

    var speed = this.speed;
    this.cabs = scenario.cabs.map(function (p, i) {
      return {
        id: i, x: p.x, y: p.y, next: null, progress: 0,
        plan: [],       // pending stops, in order
        riders: [],     // riders committed: assigned or aboard
        onboard: [],
        time: { idle: 0, empty: 0, one: 0, two: 0 },
        blocks: { empty: 0, one: 0, two: 0 },
        earnings: 0, premium: 0, trips: 0, reroutes: 0,
        planVersion: 0, rerouteVersion: 0,
        _base: null, _baseKey: '',
      };
    });
    this.riders = scenario.riders.map(function (r) {
      var direct = manhattan(r.ox, r.oy, r.dx, r.dy);
      return {
        id: r.id, requestAt: r.requestAt, ox: r.ox, oy: r.oy, dx: r.dx, dy: r.dy,
        optIn: r.optIn,
        pool: poolEnabled && r.optIn,
        direct: direct,
        est: direct / speed,
        fullFare: direct / speed * cfg.fareRate,
        fare: 0,
        state: 'scheduled',     // scheduled -> waiting -> assigned -> riding -> done | lost
        cab: null,
        assignedAt: null, promisedPickupAt: null, latestPickupAt: null,
        pickupAt: null, dropoffAt: null, lostAt: null,
        sharedSec: 0,
        coRiders: [],           // ids of everyone this rider shared the cab with
        reroutes: 0,            // times their cab changed course while they were aboard
        reassigned: 0,          // times moved to a closer cab before pickup
        joinedOccupied: false,  // boarded a cab that already had a rider
        hosted: false,          // someone boarded while this rider was aboard
      };
    });
  }

  World.prototype.step = function () {
    // Riders who requested before this instant join the queue.
    while (this.arrivalIdx < this.riders.length && this.riders[this.arrivalIdx].requestAt <= this.t) {
      var r = this.riders[this.arrivalIdx++];
      r.state = 'waiting';
      this.queue.push(r);
      this.totals.requested++;
    }
    if (this.t >= this.nextDispatchAt - EPS) {
      this.dispatch();
      this.sample();
      this.nextDispatchAt += DISPATCH_EVERY;
    }
    for (var i = 0; i < this.cabs.length; i++) this.advance(this.cabs[i]);
    this.steps++;
    this.t = this.steps * DT;
  };

  // ---------------------------------------------------------------- movement

  World.prototype.advance = function (cab) {
    var budget = this.speed * DT; // blocks this step
    var now = this.t;
    for (var guard = 0; guard < 10000; guard++) {
      if (!cab.next) {
        this.serveStops(cab, now);
        if (!cab.plan.length) {
          cab.time.idle += budget / this.speed;
          return;
        }
        if (budget <= EPS) return;
        var s = cab.plan[0];
        // L-shaped routing: finish the x leg, then the y leg.
        cab.next = s.x !== cab.x
          ? { x: cab.x + Math.sign(s.x - cab.x), y: cab.y }
          : { x: cab.x, y: cab.y + Math.sign(s.y - cab.y) };
        cab.progress = 0;
      }
      var move = Math.min(1 - cab.progress, budget);
      var sec = move / this.speed;
      this.accrue(cab, sec, move);
      cab.progress += move;
      budget -= move;
      now += sec;
      if (cab.progress >= 1 - EPS) {
        cab.x = cab.next.x;
        cab.y = cab.next.y;
        cab.next = null;
        cab.progress = 0;
      }
      if (budget <= EPS) {
        if (!cab.next) this.serveStops(cab, now);
        return;
      }
    }
  };

  World.prototype.accrue = function (cab, sec, blocks) {
    var n = cab.onboard.length;
    if (n === 0) {
      cab.time.empty += sec;
      cab.blocks.empty += blocks;
      return;
    }
    var rate = this.cfg.driverRate;
    var pay = rate * sec;
    if (n === 1) {
      cab.time.one += sec;
      cab.blocks.one += blocks;
    } else {
      var prem = rate * this.X * sec;
      pay += prem;
      cab.premium += prem;
      cab.time.two += sec;
      cab.blocks.two += blocks;
      this.totals.premium += prem;
      cab.onboard[0].sharedSec += sec;
      cab.onboard[1].sharedSec += sec;
    }
    cab.earnings += pay;
    this.totals.driverPay += pay;
  };

  World.prototype.serveStops = function (cab, now) {
    while (cab.plan.length && cab.plan[0].x === cab.x && cab.plan[0].y === cab.y) {
      var stop = cab.plan.shift();
      var r = stop.rider;
      cab.planVersion++;
      if (stop.type === 'pickup') {
        if (cab.onboard.length === 1) {
          var host = cab.onboard[0];
          host.hosted = true;
          host.coRiders.push(r.id);
          r.joinedOccupied = true;
          r.coRiders.push(host.id);
        }
        cab.onboard.push(r);
        r.state = 'riding';
        r.pickupAt = now;
        r.fare = r.fullFare * (r.pool ? 1 - this.Y : 1);
        this.totals.revenue += r.fare;
        this.totals.discount += r.fullFare - r.fare;
        this.totals.pickedUp++;
        this.totals.waitSum += now - r.requestAt;
      } else {
        cab.onboard.splice(cab.onboard.indexOf(r), 1);
        cab.riders.splice(cab.riders.indexOf(r), 1);
        r.state = 'done';
        r.dropoffAt = now;
        cab.trips++;
        this.totals.completed++;
      }
    }
  };

  // ---------------------------------------------------------------- planning

  function pickupStop(r) { return { type: 'pickup', rider: r, x: r.ox, y: r.oy }; }
  function dropoffStop(r) { return { type: 'dropoff', rider: r, x: r.dx, y: r.dy }; }

  // Blocks the cab must still drive to reach (x, y) directly. A cab that is
  // mid-edge finishes the edge first.
  World.prototype.reach = function (cab, x, y) {
    return cab.next
      ? 1 - cab.progress + manhattan(cab.next.x, cab.next.y, x, y)
      : manhattan(cab.x, cab.y, x, y);
  };

  // Time the plan and check every rule. Returns null if any rule breaks.
  // `newRider` is the rider being inserted (their pickup must be within the
  // ping radius); pass check=false to time a plan already committed.
  World.prototype.evalPlan = function (cab, plan, newRider, check) {
    var speed = this.speed, limit = this.cfg.maxDetour;
    var maxPick = this.cfg.pingRadius / speed;
    var t = this.t, x, y;
    if (cab.next) {
      t += (1 - cab.progress) / speed;
      x = cab.next.x; y = cab.next.y;
    } else {
      x = cab.x; y = cab.y;
    }
    var load = cab.onboard.length;
    var picks = {}, drops = {}, newPick = null;
    for (var i = 0; i < plan.length; i++) {
      var s = plan[i], r = s.rider;
      t += manhattan(x, y, s.x, s.y) / speed;
      x = s.x; y = s.y;
      if (s.type === 'pickup') {
        load++;
        if (check) {
          if (load > 2) return null;
          if (r === newRider) {
            if (t - this.t > maxPick + EPS) return null;
          } else if (t > r.latestPickupAt + EPS) {
            return null;
          }
        }
        if (r === newRider) newPick = t;
        picks[r.id] = t;
      } else {
        load--;
        var pt = r.state === 'riding' ? r.pickupAt : picks[r.id];
        if (check && t - pt > limit * r.est + EPS) return null;
        drops[r.id] = t;
      }
    }
    return { end: t, picks: picks, drops: drops, newPick: newPick };
  };

  World.prototype.baseEval = function (cab) {
    var key = cab.planVersion + '@' + this.steps;
    if (cab._baseKey !== key) {
      cab._base = this.evalPlan(cab, cab.plan, null, false);
      cab._baseKey = key;
    }
    return cab._base;
  };

  // Best place to slot rider r into the cab's plan, by matching cost (in
  // rider-seconds): the new rider's wait, every extra in-car or waiting second
  // the change imposes on anyone, plus a weight on the extra cab-seconds.
  World.prototype.bestInsertion = function (cab, r) {
    var base = this.baseEval(cab);
    var P = pickupStop(r), D = dropoffStop(r);
    var S = cab.plan, n = S.length, best = null;
    for (var i = 0; i <= n; i++) {
      for (var j = i; j <= n; j++) {
        var plan = S.slice(0, i);
        plan.push(P);
        for (var k = i; k < j; k++) plan.push(S[k]);
        plan.push(D);
        for (k = j; k < n; k++) plan.push(S[k]);
        var res = this.evalPlan(cab, plan, r, true);
        if (!res) continue;
        var delay = 0;
        for (var id in base.drops) delay += res.drops[id] - base.drops[id];
        var cost = (res.newPick - this.t) + (res.drops[r.id] - res.newPick - r.est) + delay
          + VEHICLE_WEIGHT * (res.end - base.end);
        if (!best || cost < best.cost) {
          best = { cab: cab, plan: plan, cost: cost, res: res, base: base };
        }
      }
    }
    return best;
  };

  World.prototype.isPoolCab = function (cab) {
    if (!cab.riders.length || cab.plan.length + 2 > MAX_PLAN_STOPS) return false;
    for (var i = 0; i < cab.riders.length; i++) if (!cab.riders[i].pool) return false;
    return true;
  };

  World.prototype.commit = function (opt, r) {
    var cab = opt.cab, cfg = this.cfg;
    var rerouted = false;
    for (var i = 0; i < cab.onboard.length; i++) {
      var a = cab.onboard[i];
      if (opt.res.drops[a.id] > opt.base.drops[a.id] + EPS) {
        a.reroutes++;
        rerouted = true;
      }
    }
    if (rerouted) {
      cab.reroutes++;
      cab.rerouteVersion++;
      this.totals.reroutes++;
    }
    cab.plan = opt.plan;
    cab.planVersion++;
    cab.riders.push(r);
    r.state = 'assigned';
    r.cab = cab.id;
    r.assignedAt = this.t;
    r.promisedPickupAt = opt.res.newPick;
    r.latestPickupAt = opt.res.newPick + cfg.pickupSlip;
  };

  // ---------------------------------------------------------------- dispatch

  World.prototype.dispatch = function () {
    var cfg = this.cfg, now = this.t;

    // Riders who waited too long without a match give up.
    if (this.queue.length) {
      var keep = [];
      for (var q = 0; q < this.queue.length; q++) {
        var w = this.queue[q];
        if (now - w.requestAt >= cfg.patience - EPS) {
          w.state = 'lost';
          w.lostAt = now;
          this.totals.lost++;
          this.lostLog.push(w.id);
        } else {
          keep.push(w);
        }
      }
      this.queue = keep;
    }

    var idle = [], poolable = [], i, c;
    for (i = 0; i < this.cabs.length; i++) {
      c = this.cabs[i];
      if (!c.riders.length) idle.push(c);
      else if (this.poolEnabled && this.isPoolCab(c)) poolable.push(c);
    }

    if (this.queue.length) this.matchQueue(idle, poolable);
    if (cfg.reassign && idle.length) this.redispatch(idle);
  };

  World.prototype.matchQueue = function (idle, poolable) {
    var radius = this.cfg.pingRadius;
    var remaining = [];
    var scanned = 0;
    for (var q = 0; q < this.queue.length; q++) {
      var r = this.queue[q];
      if (scanned >= MAX_QUEUE_SCAN || (!idle.length && !(r.pool && poolable.length))) {
        remaining.push(r);
        continue;
      }
      scanned++;
      var best = null, opt, j, c;
      // Ping only cabs whose direct drive to the pickup fits in the radius.
      for (j = 0; j < idle.length; j++) {
        c = idle[j];
        if (this.reach(c, r.ox, r.oy) > radius + EPS) continue;
        opt = this.bestInsertion(c, r);
        if (opt && (!best || opt.cost < best.cost)) best = opt;
      }
      if (r.pool) {
        for (j = 0; j < poolable.length; j++) {
          c = poolable[j];
          if (this.reach(c, r.ox, r.oy) > radius + EPS) continue;
          opt = this.bestInsertion(c, r);
          if (opt && (!best || opt.cost < best.cost)) best = opt;
        }
      }
      if (!best) {
        remaining.push(r);
        continue;
      }
      var cab = best.cab;
      var wasIdle = !cab.riders.length;
      this.commit(best, r);
      if (wasIdle) {
        idle.splice(idle.indexOf(cab), 1);
        if (r.pool && this.isPoolCab(cab)) poolable.push(cab);
      } else if (!this.isPoolCab(cab)) {
        poolable.splice(poolable.indexOf(cab), 1);
      }
    }
    this.queue = remaining;
  };

  // Re-dispatch: a rider still waiting for pickup moves to a free cab that can
  // reach them much sooner. Removing stops never makes anyone else later
  // (Manhattan distances obey the triangle inequality), so the old cab's
  // remaining riders stay within every rule.
  World.prototype.redispatch = function (idle) {
    var radius = this.cfg.pingRadius, speed = this.speed;
    for (var i = 0; i < this.cabs.length && idle.length; i++) {
      var c = this.cabs[i];
      if (!c.riders.length) continue;
      var waiting = c.riders.filter(function (r) { return r.state === 'assigned'; });
      for (var w = 0; w < waiting.length && idle.length; w++) {
        var r = waiting[w];
        var cur = this.baseEval(c).picks[r.id] - this.t;
        if (cur < REASSIGN_MIN_GAIN) continue;
        var bestCab = null, bestEta = Infinity;
        for (var j = 0; j < idle.length; j++) {
          var d = this.reach(idle[j], r.ox, r.oy);
          if (d <= radius + EPS && d / speed < bestEta) { bestEta = d / speed; bestCab = idle[j]; }
        }
        if (!bestCab || bestEta > cur - REASSIGN_MIN_GAIN || bestEta > cur * REASSIGN_MIN_RATIO) continue;

        c.plan = c.plan.filter(function (s) { return s.rider !== r; });
        c.riders.splice(c.riders.indexOf(r), 1);
        c.planVersion++;
        if (c.onboard.length) c.rerouteVersion++;

        bestCab.plan = [pickupStop(r), dropoffStop(r)];
        bestCab.riders.push(r);
        bestCab.planVersion++;
        r.cab = bestCab.id;
        r.assignedAt = this.t;
        r.promisedPickupAt = this.t + bestEta;
        r.latestPickupAt = r.promisedPickupAt + this.cfg.pickupSlip;
        r.reassigned++;
        this.totals.reassigned++;

        idle.splice(idle.indexOf(bestCab), 1);
        if (!c.riders.length) idle.push(c);
      }
    }
  };

  // ---------------------------------------------------------------- readouts

  World.prototype.live = function () {
    var shared = 0, busy = 0;
    for (var i = 0; i < this.cabs.length; i++) {
      var c = this.cabs[i];
      if (c.onboard.length === 2) shared++;
      if (c.riders.length) busy++;
    }
    var T = this.totals;
    return {
      t: this.t,
      waiting: T.requested - T.pickedUp - T.lost,
      unassigned: this.queue.length,
      riding: T.pickedUp - T.completed,
      completed: T.completed,
      lost: T.lost,
      sharedCabs: shared,
      busyCabs: busy,
      idleCabs: this.cabs.length - busy,
      avgWait: T.pickedUp ? T.waitSum / T.pickedUp : null,
      driverPay: T.driverPay,
      revenue: T.revenue,
      discount: T.discount,
    };
  };

  World.prototype.sample = function () {
    var l = this.live();
    this.series.push({
      t: this.t, waiting: l.waiting, riding: l.riding, completed: l.completed, lost: l.lost,
      sharedCabs: l.sharedCabs, idleCabs: l.idleCabs, driverPay: l.driverPay,
    });
  };

  function Simulation(input) {
    this.cfg = normalizeConfig(input);
    this.scenario = makeScenario(this.cfg);
    this.pool = new World(this.cfg, this.scenario, true);
    this.base = new World(this.cfg, this.scenario, false);
  }

  Simulation.prototype.step = function () {
    this.pool.step();
    this.base.step();
  };

  Object.defineProperty(Simulation.prototype, 't', {
    get: function () { return this.pool.t; },
  });

  Object.defineProperty(Simulation.prototype, 'done', {
    get: function () { return this.pool.t >= this.cfg.duration - EPS; },
  });

  Simulation.prototype.finish = function () {
    this.pool.sample();
    this.base.sample();
    return this;
  };

  Simulation.prototype.runToEnd = function () {
    while (!this.done) this.step();
    return this.finish();
  };

  var api = {
    DEFAULTS: DEFAULTS,
    DT: DT,
    EPS: EPS,
    DISPATCH_EVERY: DISPATCH_EVERY,
    MAX_PLAN_STOPS: MAX_PLAN_STOPS,
    VEHICLE_WEIGHT: VEHICLE_WEIGHT,
    normalizeConfig: normalizeConfig,
    makeScenario: makeScenario,
    manhattan: manhattan,
    World: World,
    Simulation: Simulation,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PoolSim = api;
}
definePoolSim(this);
