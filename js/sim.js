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
 *      * a pool rider who had a solo cab in range at assignment finishes
 *        within maxDetour x that solo door-to-door (wait already elapsed
 *        plus that cab's drive plus the estimate);
 *      * an assigned rider's pickup slips at most pickupSlip seconds past
 *        the time they were promised;
 *      * the new rider's pickup is within pingRadius blocks of driving.
 *  - Unmatched riders give up after `patience` seconds.
 *  - Optional re-dispatch: an assigned rider still waiting for pickup is moved
 *    to a free cab that can reach them much sooner.
 *  - Driver pay: driverRate per occupied second, x(1 + X) while 2 are aboard.
 *    Driving to a pickup is unpaid. Running cost accrues per block driven.
 *    A trip is accepted only when the new rider's fare covers the extra pay
 *    and the extra fuel. Any fuel the time-pay misses is topped up at that
 *    rider's drop-off, so a driver's projected net never goes below zero.
 *  - Rider fare: quoted at pickup as fareRate x estimate, x(1 - Y) for a pool
 *    opt-in. Settled at drop-off: the full fare if they never shared, otherwise
 *    the quote x (estimate / time in the car). A pool insertion is priced on
 *    that settled plan, so the new fare has to fund any refund to someone
 *    already aboard as well as the extra pay and fuel.
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
  var THREAT_RADIUS = 6;      // manhattan blocks, fixed
  var THREAT_FRACTION = 0.45; // of the run, then the diamond closes
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
    var threatAt = node();
    return {
      cabs: cabs, riders: riders,
      threat: { x: threatAt.x, y: threatAt.y, r: THREAT_RADIUS, at: cfg.duration * THREAT_FRACTION },
    };
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
    this.threat = scenario.threat;
    this.threatOn = false;
    this.totals = {
      revenue: 0, driverPay: 0, premium: 0, discount: 0, topUp: 0,
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
        earnings: 0, premium: 0, topUpPaid: 0, trips: 0, reroutes: 0,
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
        topUp: 0,               // fuel the time-pay misses; paid at drop-off
        soloDoor: null,         // solo door-to-door available at assignment
        soloChecked: false,
      };
    });
  }

  World.prototype.zone = function (x, y) {
    if (!this.threatOn) return false;
    var z = this.threat;
    return manhattan(x, y, z.x, z.y) <= z.r;
  };

  // Nearest grid point just outside the diamond. Null when (x, y) is already outside.
  World.prototype.exitCell = function (x, y) {
    var z = this.threat, G = this.cfg.gridSize;
    if (manhattan(x, y, z.x, z.y) > z.r) return null;
    var ex = x, ey = y, dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (var n = 0; n < G * 2 && manhattan(ex, ey, z.x, z.y) <= z.r; n++) {
      var best = null, bestD = manhattan(ex, ey, z.x, z.y);
      for (var d = 0; d < 4; d++) {
        var nx = ex + dirs[d][0], ny = ey + dirs[d][1];
        if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
        var dist = manhattan(nx, ny, z.x, z.y);
        if (dist > bestD) { bestD = dist; best = [nx, ny]; }
      }
      if (!best) break;
      ex = best[0]; ey = best[1];
    }
    return { x: ex, y: ey };
  };

  World.prototype.loseUnpicked = function (cab, r) {
    if (r.state !== 'assigned') return;
    r.state = 'lost';
    r.lostAt = this.t;
    r.cab = null;
    r.topUp = 0;
    this.totals.lost++;
    this.lostLog.push(r.id);
    var i = cab.riders.indexOf(r);
    if (i >= 0) cab.riders.splice(i, 1);
  };

  // Pay whatever the open plan still lacks, so fleeing the zone cannot sink the driver.
  World.prototype.makeWhole = function (cab) {
    var net = this.projectedNet(cab);
    if (net >= -EPS) return;
    var gap = -net;
    cab.earnings += gap;
    cab.topUpPaid += gap;
    this.totals.driverPay += gap;
    this.totals.topUp += gap;
  };

  World.prototype.clearCab = function (cab) {
    var cancel = [], kept = [], i, s;
    for (i = 0; i < cab.plan.length; i++) {
      s = cab.plan[i];
      if (s.type === 'exit') continue;
      if (s.type === 'pickup' && (this.zone(s.x, s.y) || this.zone(s.rider.dx, s.rider.dy))) {
        if (s.rider.state === 'assigned') cancel.push(s.rider);
        continue;
      }
      if (s.type === 'dropoff' && this.zone(s.x, s.y)) continue;
      kept.push(s);
    }
    for (i = 0; i < cancel.length; i++) this.loseUnpicked(cab, cancel[i]);
    kept = kept.filter(function (stop) { return !stop.rider || stop.rider.state !== 'lost'; });
    var px = cab.next ? cab.next.x : cab.x;
    var py = cab.next ? cab.next.y : cab.y;
    var dropAt = { x: px, y: py };
    var leaving = false;
    for (i = 0; i < kept.length; i++) if (!this.zone(kept[i].x, kept[i].y)) leaving = true;
    if (this.zone(px, py) && !leaving) {
      var exit = this.exitCell(px, py);
      if (exit) {
        dropAt = exit;
        kept.unshift({ type: 'exit', x: exit.x, y: exit.y });
      }
    }
    for (i = cab.onboard.length - 1; i >= 0; i--) {
      var rider = cab.onboard[i];
      var still = false;
      for (var k = 0; k < kept.length; k++) if (kept[k].type === 'dropoff' && kept[k].rider === rider) still = true;
      if (!still) kept.splice(kept[0] && kept[0].type === 'exit' ? 1 : 0, 0, { type: 'dropoff', rider: rider, x: dropAt.x, y: dropAt.y });
    }
    cab.plan = kept;
    cab.planVersion++;
    if (cab.onboard.length) cab.rerouteVersion++;
    this.makeWhole(cab);
  };

  World.prototype.closeZone = function () {
    this.threatOn = true;
    var keep = [];
    for (var q = 0; q < this.queue.length; q++) {
      var r = this.queue[q];
      if (this.zone(r.ox, r.oy) || this.zone(r.dx, r.dy)) {
        r.state = 'lost';
        r.lostAt = this.t;
        this.totals.lost++;
        this.lostLog.push(r.id);
      } else keep.push(r);
    }
    this.queue = keep;
    for (var i = 0; i < this.cabs.length; i++) this.clearCab(this.cabs[i]);
  };

  World.prototype.step = function () {
    if (!this.threatOn && this.t >= this.threat.at - EPS) this.closeZone();
    // Riders who requested before this instant join the queue.
    while (this.arrivalIdx < this.riders.length && this.riders[this.arrivalIdx].requestAt <= this.t) {
      var r = this.riders[this.arrivalIdx++];
      this.totals.requested++;
      if (this.zone(r.ox, r.oy) || this.zone(r.dx, r.dy)) {
        r.state = 'lost';
        r.lostAt = this.t;
        this.totals.lost++;
        this.lostLog.push(r.id);
        continue;
      }
      r.state = 'waiting';
      this.queue.push(r);
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
      cab.planVersion++;
      if (stop.type === 'exit') continue;
      var r = stop.rider;
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
        r.fare = this.quotedFare(r);
        this.totals.revenue += r.fare;
        this.totals.discount += r.fullFare - r.fare;
        this.totals.pickedUp++;
        this.totals.waitSum += now - r.requestAt;
      } else {
        if (r.topUp) {
          cab.earnings += r.topUp;
          cab.topUpPaid += r.topUp;
          this.totals.driverPay += r.topUp;
          this.totals.topUp += r.topUp;
          r.topUp = 0;
        }
        var earned = this.settledFare(r, now - r.pickupAt, r.sharedSec > EPS);
        var adj = earned - r.fare;
        r.fare = earned;
        this.totals.revenue += adj;
        this.totals.discount -= adj;
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
    var rate = this.cfg.driverRate, prem = this.X, cost = this.cfg.costPerBlock;
    var t = this.t, x, y, pay = 0, fuel = 0, load = cab.onboard.length;
    var aboard = [], shared = {}, seen = {};
    function note(r) { seen[r.id] = r; }
    for (var a = 0; a < cab.onboard.length; a++) {
      aboard.push(cab.onboard[a]);
      note(cab.onboard[a]);
      if (cab.onboard[a].sharedSec > EPS) shared[cab.onboard[a].id] = true;
    }
    function leg(blocks) {
      if (!(blocks > 0)) return;
      if (load >= 2) {
        for (var u = 0; u < aboard.length; u++) shared[aboard[u].id] = true;
      }
      fuel += cost * blocks;
      if (load === 1) pay += rate * blocks / speed;
      else if (load >= 2) pay += rate * (1 + prem) * blocks / speed;
      t += blocks / speed;
    }
    if (cab.next) {
      leg(1 - cab.progress);
      x = cab.next.x; y = cab.next.y;
    } else {
      x = cab.x; y = cab.y;
    }
    var picks = {}, drops = {}, newPick = null;
    for (var i = 0; i < plan.length; i++) {
      var s = plan[i], r = s.rider;
      leg(manhattan(x, y, s.x, s.y));
      x = s.x; y = s.y;
      if (s.type === 'exit') continue;
      if (s.type === 'pickup') {
        load++;
        aboard.push(r);
        note(r);
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
        for (var u = aboard.length - 1; u >= 0; u--) if (aboard[u] === r) { aboard.splice(u, 1); break; }
        var pt = r.state === 'riding' ? r.pickupAt : picks[r.id];
        if (check && t - pt > limit * r.est + EPS) return null;
        var bench = r.soloChecked ? r.soloDoor
          : (r._offer == null ? null : (this.t - r.requestAt) + r._offer + r.est);
        if (check && r.pool && bench != null && t - r.requestAt > limit * bench + EPS) return null;
        drops[r.id] = t;
      }
    }
    var fareOf = {};
    for (var id in seen) {
      var rr = seen[id];
      var drop = drops[rr.id];
      var pick = rr.state === 'riding' ? rr.pickupAt : picks[rr.id];
      if (drop == null || pick == null) continue;
      fareOf[rr.id] = this.settledFare(rr, drop - pick, !!shared[rr.id]);
    }
    return { end: t, picks: picks, drops: drops, newPick: newPick, pay: pay, fuel: fuel, fareOf: fareOf };
  };

  // Quoted at pickup. Pool opt-ins are quoted the flat discount; drop-off settles it.
  World.prototype.quotedFare = function (r) {
    return r.fullFare * (r.pool ? 1 - this.Y : 1);
  };

  // Full fare unless the rider shared. A shared trip pays the flat discount
  // scaled by estimate / time in the car, and never more than the flat discount.
  World.prototype.settledFare = function (r, inCar, shared) {
    if (!r.pool || !shared || !(inCar > 0)) return r.fullFare;
    var flat = r.fullFare * (1 - this.Y);
    var scaled = flat * (r.est / inCar);
    return scaled < flat ? scaled : flat;
  };

  World.prototype.fareSum = function (fareOf) {
    var s = 0;
    for (var id in fareOf) s += fareOf[id];
    return s;
  };

  // Null when `fare` does not cover the extra time-pay and the extra fuel.
  // Otherwise the top-up that makes the driver whole on the fuel gap.
  World.prototype.fuelGap = function (fare, dPay, dFuel) {
    if (fare + EPS < dPay || fare + EPS < dFuel) return null;
    return dFuel > dPay ? dFuel - dPay : 0;
  };

  World.prototype.fuelSoFar = function (cab) {
    return this.cfg.costPerBlock * (cab.blocks.empty + cab.blocks.one + cab.blocks.two);
  };

  // Cash so far, plus the open plan driven to completion, plus top-ups not yet
  // paid. `plan` / `except` let a re-dispatch try the removal before doing it.
  World.prototype.projectedNet = function (cab, plan, except) {
    var pending = 0;
    for (var i = 0; i < cab.riders.length; i++) {
      if (cab.riders[i] !== except) pending += cab.riders[i].topUp || 0;
    }
    var rem = this.evalPlan(cab, plan == null ? cab.plan : plan, null, false);
    return cab.earnings - this.fuelSoFar(cab) + rem.pay - rem.fuel + pending;
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
    if (this.zone(r.ox, r.oy) || this.zone(r.dx, r.dy)) return null;
    if (this.zone(cab.next ? cab.next.x : cab.x, cab.next ? cab.next.y : cab.y)) return null;
    var base = this.baseEval(cab);
    var P = pickupStop(r), D = dropoffStop(r);
    var S = cab.plan, n = S.length, best = null;
    var first = S.length && S[0].type === 'exit' ? 1 : 0;
    for (var i = first; i <= n; i++) {
      for (var j = i; j <= n; j++) {
        var plan = S.slice(0, i);
        plan.push(P);
        for (var k = i; k < j; k++) plan.push(S[k]);
        plan.push(D);
        for (k = j; k < n; k++) plan.push(S[k]);
        var res = this.evalPlan(cab, plan, r, true);
        if (!res) continue;
        var dFare = this.fareSum(res.fareOf) - this.fareSum(base.fareOf);
        var gap = this.fuelGap(dFare, res.pay - base.pay, res.fuel - base.fuel);
        if (gap == null) continue;
        var delay = 0;
        for (var id in base.drops) delay += res.drops[id] - base.drops[id];
        var cost = (res.newPick - this.t) + (res.drops[r.id] - res.newPick - r.est) + delay
          + VEHICLE_WEIGHT * (res.end - base.end);
        if (!best || cost < best.cost) {
          best = { cab: cab, plan: plan, cost: cost, res: res, base: base, topUp: gap };
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
    r.topUp = opt.topUp || 0;
    if (r.pool && !r.soloChecked) {
      r.soloChecked = true;
      r.soloDoor = r._offer == null ? null : (this.t - r.requestAt) + r._offer + r.est;
    }
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

  // Drive time of the closest idle cab inside the ping radius, or null.
  World.prototype.soloOffer = function (r, idle) {
    var best = Infinity, radius = this.cfg.pingRadius;
    for (var i = 0; i < idle.length; i++) {
      var d = this.reach(idle[i], r.ox, r.oy);
      if (d <= radius + EPS && d < best) best = d;
    }
    return best < Infinity ? best / this.speed : null;
  };

  World.prototype.matchQueue = function (idle, poolable) {
    var radius = this.cfg.pingRadius, now = this.t, world = this;
    var considered = [];
    for (var q = 0; q < this.queue.length && considered.length < MAX_QUEUE_SCAN; q++) {
      var r = this.queue[q];
      if (!idle.length && !(r.pool && poolable.length)) continue;
      if (r.pool && !r.soloChecked) r._offer = this.soloOffer(r, idle);
      considered.push(r);
    }
    function gather(cabs) {
      var pairs = [];
      for (var i = 0; i < considered.length; i++) {
        var rider = considered[i];
        if (rider.state !== 'waiting') continue;
        for (var j = 0; j < cabs.length; j++) {
          var cab = cabs[j];
          if (cab.riders.length && !rider.pool) continue;
          if (world.reach(cab, rider.ox, rider.oy) > radius + EPS) continue;
          var opt = world.bestInsertion(cab, rider);
          if (!opt) continue;
          pairs.push({ r: rider, opt: opt, score: opt.cost - (now - rider.requestAt) });
        }
      }
      pairs.sort(function (a, b) {
        return a.score - b.score || a.r.id - b.r.id || a.opt.cab.id - b.opt.cab.id;
      });
      return pairs;
    }
    function assign(pairs) {
      var used = {}, taken = [];
      for (var i = 0; i < pairs.length; i++) {
        var rider = pairs[i].r, opt = pairs[i].opt, cab = opt.cab;
        if (rider.state !== 'waiting' || used[cab.id]) continue;
        world.commit(opt, rider);
        used[cab.id] = true;
        taken.push(cab);
      }
      return taken;
    }
    var first = assign(gather(idle.concat(poolable)));
    var second = [];
    for (var i = 0; i < first.length; i++) if (this.isPoolCab(first[i])) second.push(first[i]);
    if (second.length) assign(gather(second));
    var remaining = [];
    for (q = 0; q < this.queue.length; q++) {
      if (this.queue[q].state === 'waiting') remaining.push(this.queue[q]);
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
        if (this.zone(r.ox, r.oy) || this.zone(r.dx, r.dy)) continue;
        var cur = this.baseEval(c).picks[r.id] - this.t;
        if (cur < REASSIGN_MIN_GAIN) continue;
        var bestCab = null, bestEta = Infinity;
        for (var j = 0; j < idle.length; j++) {
          var d = this.reach(idle[j], r.ox, r.oy);
          if (d <= radius + EPS && d / speed < bestEta) { bestEta = d / speed; bestCab = idle[j]; }
        }
        if (!bestCab || bestEta > cur - REASSIGN_MIN_GAIN || bestEta > cur * REASSIGN_MIN_RATIO) continue;
        var stripped = c.plan.filter(function (s) { return s.rider !== r; });
        // Deadhead already driven stays with this cab. Don't strand it.
        if (this.projectedNet(c, stripped, r) < -EPS) continue;
        var neu = [pickupStop(r), dropoffStop(r)];
        var base = this.evalPlan(bestCab, bestCab.plan, null, false);
        var res = this.evalPlan(bestCab, neu, r, true);
        var gap = res && this.fuelGap(this.fareSum(res.fareOf) - this.fareSum(base.fareOf), res.pay - base.pay, res.fuel - base.fuel);
        if (gap == null) continue;

        c.plan = stripped;
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
        r.topUp = gap;
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
