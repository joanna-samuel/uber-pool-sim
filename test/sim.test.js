// Engine invariants. Run: node test/sim.test.js
'use strict';
const assert = require('assert');
const S = require('../js/sim.js');
const M = require('../js/metrics.js');

const EPS = 1e-6;
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('  FAIL ' + name + '\n       ' + e.message);
    process.exitCode = 1;
  }
}
function sim(over) {
  return new S.Simulation(Object.assign({}, S.DEFAULTS, over));
}
function runChecked(over, onStep) {
  const s = sim(over);
  while (!s.done) {
    s.step();
    if (onStep) onStep(s);
  }
  return s.finish();
}
const inCar = (r) => r.dropoffAt - r.pickupAt;

const SCENARIOS = [
  {},
  { cabs: 10 },
  { cabs: 80 },
  { riders: 600, cabs: 40, seed: 3 },
  { maxDetour: 1.2, seed: 11 },
  { maxDetour: 2.5, poolOptIn: 100, seed: 5, pingRadius: 6 },
  { gridSize: 20, riders: 300, cabs: 15, cabSpeed: 2.5, seed: 9 },
  { pingRadius: 3, patience: 40, pickupSlip: 0 },
  { pingRadius: 200, reassign: 0, riders: 400 },
];
const cache = new Map();
function finished(over) {
  const key = JSON.stringify(over);
  if (!cache.has(key)) cache.set(key, runChecked(over));
  return cache.get(key);
}

console.log('PoolSim engine tests');

test('never more than 2 aboard, now or anywhere in a planned route', () => {
  for (const over of SCENARIOS) {
    runChecked(over, (s) => {
      for (const w of [s.pool, s.base]) {
        for (const c of w.cabs) {
          assert(c.onboard.length <= 2, 'aboard > 2');
          let load = c.onboard.length;
          let riderStops = 0;
          for (const st of c.plan) {
            if (st.type === 'exit') continue;
            riderStops++;
            load += st.type === 'pickup' ? 1 : -1;
            assert(load <= 2 && load >= 0, `cab ${c.id} plan load ${load}`);
          }
          assert(riderStops <= S.MAX_PLAN_STOPS, 'plan too long');
        }
      }
    });
  }
});

test('every pool rider rides at most maxDetour x their solo estimate', () => {
  for (const over of SCENARIOS) {
    const s = finished(over);
    for (const r of s.pool.riders) {
      if (r.state !== 'done') continue;
      assert(inCar(r) <= s.cfg.maxDetour * r.est + EPS,
        `rider ${r.id}: ${inCar(r).toFixed(3)}s > ${s.cfg.maxDetour} x ${r.est.toFixed(3)}s`);
    }
  }
});

test('solo riders (both worlds) ride exactly their estimate and never share', () => {
  for (const over of SCENARIOS) {
    const s = finished(over);
    for (const r of s.base.riders.concat(s.pool.riders.filter((x) => !x.pool))) {
      if (r.state !== 'done') continue;
      const z = s.pool.threat;
      const destClosed = S.manhattan(r.dx, r.dy, z.x, z.y) <= z.r && r.dropoffAt >= z.at - EPS;
      if (destClosed) assert(inCar(r) <= r.est + EPS, `rider ${r.id} evacuation lengthened the ride`);
      else assert(Math.abs(inCar(r) - r.est) < EPS, `rider ${r.id} solo ride ${inCar(r)} != ${r.est}`);
      assert(r.sharedSec < EPS && r.coRiders.length === 0, `solo rider ${r.id} shared`);
    }
    for (const c of s.base.cabs) assert(c.time.two < EPS, 'baseline cab carried 2');
  }
});

test('pickups honour the ping radius and the allowed slip', () => {
  for (const over of SCENARIOS) {
    const s = finished(over);
    const cfg = s.cfg;
    for (const w of [s.pool, s.base]) {
      for (const r of w.riders) {
        if (r.pickupAt == null) continue;
        assert(r.pickupAt <= r.latestPickupAt + EPS, `rider ${r.id} picked up after the slip window`);
        assert(r.pickupAt - r.assignedAt <= cfg.pingRadius / cfg.cabSpeed + cfg.pickupSlip + EPS,
          `rider ${r.id} picked up from beyond the ping radius`);
        assert(r.pickupAt >= r.requestAt - EPS, `rider ${r.id} picked before request`);
        if (r.dropoffAt != null) assert(r.dropoffAt >= r.pickupAt, `rider ${r.id} dropped before pickup`);
      }
    }
  }
});

test('only unmatched riders give up, and only after their patience runs out', () => {
  for (const over of SCENARIOS) {
    const s = finished(over);
    for (const w of [s.pool, s.base]) {
      for (const r of w.riders) {
        if (r.state !== 'lost') continue;
        const z = w.threat;
        const closed = S.manhattan(r.ox, r.oy, z.x, z.y) <= z.r || S.manhattan(r.dx, r.dy, z.x, z.y) <= z.r;
        if (closed && r.lostAt >= z.at - EPS) continue;
        assert(r.pickupAt == null && r.assignedAt == null, `rider ${r.id} lost after being matched`);
        assert(r.lostAt - r.requestAt >= s.cfg.patience - EPS, `rider ${r.id} gave up early`);
      }
    }
  }
  const tight = finished({ pingRadius: 3, patience: 40, pickupSlip: 0 });
  assert(tight.base.totals.lost > 0, 'a tight radius should strand some riders');
});

test('every cab-second is idle, empty, 1 aboard or 2 aboard', () => {
  for (const over of SCENARIOS) {
    const s = finished(over);
    for (const w of [s.pool, s.base]) {
      for (const c of w.cabs) {
        const t = c.time.idle + c.time.empty + c.time.one + c.time.two;
        assert(Math.abs(t - w.t) < 1e-6, `cab ${c.id} time ${t} != ${w.t}`);
      }
    }
  }
});

test('driver pay = rate x (occupied s + X x 2-aboard s) + fuel top-up, and sums across cabs', () => {
  for (const over of SCENARIOS) {
    const s = finished(over);
    const X = s.cfg.driverPremium / 100;
    for (const w of [s.pool, s.base]) {
      let total = 0;
      for (const c of w.cabs) {
        const expect = s.cfg.driverRate * (c.time.one + c.time.two + X * c.time.two) + c.topUpPaid;
        assert(Math.abs(c.earnings - expect) < 1e-6, `cab ${c.id} pay mismatch`);
        total += c.earnings;
      }
      assert(Math.abs(total - w.totals.driverPay) < 1e-6, 'fleet pay mismatch');
    }
  }
});

test('no driver is projected below zero', () => {
  const cases = SCENARIOS.concat([
    { costPerBlock: 0.3, pingRadius: 40 },
    { fareRate: 0.05, costPerBlock: 0.5, driverRate: 0.05, riders: 40, duration: 80 },
  ]);
  for (const over of cases) {
    const s = finished(over);
    for (const w of [s.pool, s.base]) {
      for (const c of w.cabs) {
        assert(w.projectedNet(c) >= -1e-6, `cab ${c.id} projected ${w.projectedNet(c)}`);
      }
    }
  }
  const broke = finished({ fareRate: 0.05, costPerBlock: 0.5, driverRate: 0.05, riders: 40, duration: 80 });
  assert.strictEqual(broke.pool.totals.pickedUp, 0);
  assert.strictEqual(broke.base.totals.pickedUp, 0);
  const thin = finished({ riders: 40, cabs: 8, duration: 120, driverRate: 0.1, fareRate: 0.5, costPerBlock: 0.2, pingRadius: 20, seed: 1 });
  assert(thin.base.totals.topUp > 0, 'expected a fuel top-up when time-pay misses fuel');
  for (const c of thin.base.cabs) assert(thin.base.projectedNet(c) >= -1e-6);
});

test('a closed area empties out and takes no new trips', () => {
  const s = finished({});
  for (const w of [s.pool, s.base]) {
    const z = w.threat;
    assert(w.threatOn, 'zone never closed');
    assert.strictEqual(z.r, 6);
    for (const c of w.cabs) {
      for (const st of c.plan) assert(S.manhattan(st.x, st.y, z.x, z.y) > z.r, 'stop inside the zone');
      if (S.manhattan(c.x, c.y, z.x, z.y) <= z.r) {
        assert(c.plan.length && S.manhattan(c.plan[0].x, c.plan[0].y, z.x, z.y) > z.r,
          `cab ${c.id} is inside with nowhere outside to go`);
      }
    }
    for (const r of w.riders) {
      const originIn = S.manhattan(r.ox, r.oy, z.x, z.y) <= z.r;
      const destIn = S.manhattan(r.dx, r.dy, z.x, z.y) <= z.r;
      if ((originIn || destIn) && r.requestAt >= z.at - EPS) assert.strictEqual(r.state, 'lost');
      if (r.pickupAt != null && r.pickupAt >= z.at - EPS) assert(!originIn, `picked up inside after close`);
    }
  }
});

test('pool door-to-door stays within the solo option offered at assignment', () => {
  for (const over of SCENARIOS) {
    const s = finished(over);
    for (const r of s.pool.riders) {
      if (!r.pool || r.soloDoor == null || r.dropoffAt == null) continue;
      const door = r.dropoffAt - r.requestAt;
      assert(door <= s.cfg.maxDetour * r.soloDoor + EPS,
        `rider ${r.id}: door ${door.toFixed(2)}s > ${s.cfg.maxDetour} × ${r.soloDoor.toFixed(2)}s`);
    }
  }
});

test('pool discount is settled at drop-off', () => {
  const s = finished({});
  const Y = s.cfg.poolDiscount / 100;
  for (const w of [s.pool, s.base]) {
    let rev = 0;
    for (const r of w.riders) {
      if (r.pickupAt == null) continue;
      rev += r.fare;
      if (!r.pool) {
        assert(Math.abs(r.fare - r.fullFare) < 1e-9, `solo rider ${r.id}`);
        continue;
      }
      const flat = r.fullFare * (1 - Y);
      if (r.state !== 'done') {
        assert(Math.abs(r.fare - flat) < 1e-9, `rider ${r.id} quoted before drop-off`);
        continue;
      }
      if (r.sharedSec <= EPS) {
        assert(Math.abs(r.fare - r.fullFare) < 1e-9, `rider ${r.id} paid a discount without sharing`);
      } else {
        const scaled = flat * (r.est / (r.dropoffAt - r.pickupAt));
        const expect = Math.min(flat, scaled);
        assert(Math.abs(r.fare - expect) < 1e-6, `rider ${r.id} fare ${r.fare} != ${expect}`);
        assert(r.fare <= flat + 1e-9, `rider ${r.id} paid more than the flat discount`);
      }
    }
    assert(Math.abs(rev - w.totals.revenue) < 1e-6, 'revenue does not match fares');
  }
  assert(s.pool.riders.some((r) => r.pool && r.state === 'done' && r.sharedSec > EPS), 'expected a shared trip');
  assert(s.pool.riders.some((r) => r.pool && r.state === 'done' && r.sharedSec <= EPS), 'expected an unmatched pool trip');
});

test('cabs reroute mid-ride and riders can share with more than one co-rider', () => {
  const s = finished({ riders: 600, cabs: 40, seed: 3 });
  assert(s.pool.totals.reroutes > 0, 'no mid-ride reroutes');
  const multi = s.pool.riders.filter((r) => r.coRiders.length >= 2);
  assert(multi.length > 0, 'no rider had two co-riders');
  // ...but never two at the same time: each co-rider pair overlapped one at a time.
  for (const r of multi) {
    const spans = r.coRiders.map((id) => s.pool.riders[id])
      .map((o) => [Math.max(o.pickupAt, r.pickupAt), Math.min(o.dropoffAt ?? Infinity, r.dropoffAt ?? Infinity)])
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) assert(spans[i][0] >= spans[i - 1][1] - EPS, `rider ${r.id} had 2 co-riders at once`);
  }
});

test('re-dispatch only runs when enabled', () => {
  assert.strictEqual(finished({ pingRadius: 200, reassign: 0, riders: 400 }).pool.totals.reassigned, 0);
  // Needs free cabs to move riders to, so use default demand with no radius cap.
  assert(runChecked({ pingRadius: 200 }).base.totals.reassigned > 0, 'expected some re-dispatches');
});

test('with 0% opt-in the pool world is identical to the baseline', () => {
  const s = runChecked({ poolOptIn: 0, riders: 300 });
  assert.strictEqual(s.pool.totals.completed, s.base.totals.completed);
  assert(Math.abs(s.pool.totals.driverPay - s.base.totals.driverPay) < 1e-9);
  s.pool.riders.forEach((r, i) => assert.strictEqual(r.dropoffAt, s.base.riders[i].dropoffAt));
});

test('same seed reproduces the run exactly; another seed differs', () => {
  const a = sim({}).runToEnd(), b = sim({}).runToEnd(), c = sim({ seed: 8 }).runToEnd();
  assert.strictEqual(a.pool.totals.driverPay, b.pool.totals.driverPay);
  assert.strictEqual(a.pool.totals.completed, b.pool.totals.completed);
  assert.notStrictEqual(a.pool.totals.driverPay, c.pool.totals.driverPay);
});

test('changing the opt-in % does not move riders or cabs', () => {
  const a = S.makeScenario(S.normalizeConfig({ poolOptIn: 20 }));
  const b = S.makeScenario(S.normalizeConfig({ poolOptIn: 90 }));
  a.riders.forEach((r, i) => {
    const q = b.riders[i];
    assert(r.ox === q.ox && r.oy === q.oy && r.dx === q.dx && r.dy === q.dy && r.requestAt === q.requestAt);
  });
});

test('driver-earnings decomposition adds up to the pool-world total', () => {
  for (const over of SCENARIOS) {
    const d = M.summarize(finished(over)).drivers.steps;
    const total = d.base + d.lostToSharing + d.detourPay + d.premium + d.topUp + d.fleet;
    assert(Math.abs(total - d.pool) < 1e-6, 'waterfall does not close');
  }
});

test('radius sweep: points cover the current radius and recommend one of them', () => {
  const cfg = S.normalizeConfig(S.DEFAULTS);
  const radii = M.sweepRadii(cfg);
  assert(radii.includes(cfg.pingRadius));
  const pts = radii.map((R) => M.sweepPoint(cfg, R, 1));
  assert(radii.includes(M.recommendRadius(pts, 'pool')));
  assert(pts[0].pool.lost > pts[pts.length - 1].pool.lost, 'tightest radius should lose more riders');
});

test('metrics survive degenerate runs (no riders, one cab)', () => {
  const s = M.summarize(sim({ riders: 0, cabs: 1 }).runToEnd());
  assert.strictEqual(s.pool.completed, 0);
  assert.strictEqual(s.passengers.matchRate, null);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
