# PoolSim — two-seat ride pooling on a Manhattan grid

An early Uber Pool, simulated. K riders and N cabs on a 50 × 50 street grid, run for P seconds, in **two cities at once**:
one where riders who opt in can share a cab and one where everyone rides solo. Riders, request times and cab start
positions are identical in both, so every difference you see comes from pooling alone.

## Run it

Open `index.html` in a browser. There's no build step, no install and no network access; it works from `file://`.

If you'd rather serve it: `python3 -m http.server` in this folder, then open http://localhost:8000.

- **Start / Stop**: the main button. Stop pauses; settings stay locked until **Reset**. <kbd>Space</kbd> toggles.
- **Speed**: 1×–50× playback, adjustable while running.
- **Report**: opens automatically at P, or on demand whenever the run is stopped (an interim report).
- **Hover a cab**: shows its riders, how long each has been aboard, the ratio they'll arrive at against the cap, how many co-riders they've had, and how often their cab rerouted.
- **The map shows:**
  - each new request's ping radius as a diamond (the cabs inside it are the ones offered the request);
  - a cab that reroutes mid-ride, drawn with a bold route;
  - riders who give up, marked with a red ×.

Engine tests (Node ≥ 18, no dependencies): `node test/sim.test.js`

## The rules, as implemented

| Rule | How it's enforced |
|---|---|
| At most 2 passengers at a time | Each cab has a plan of upcoming pickups and drop-offs. Occupancy is checked at every point of the plan, not just now. A rider can share with several people in turn over one trip, but never two at once. |
| No one rides longer than 1.5 × the non-pool estimate | Estimate = Manhattan distance ÷ speed. Every time a plan changes, every pool rider in it is re-checked: the riders already aboard (using how long they've already ridden) and those still waiting. Routes are deterministic, so planned = actual (tested). |
| Drivers earn X% more while 2 are aboard | Pay = rate × occupied second, × (1 + X) for each second with 2 aboard. Driving to a pickup is unpaid. |
| Pool riders get Y% off | Upfront fare = fare rate × estimate × (1 − Y), charged at pickup, **whether or not a co-rider is ever found**. |
| Ping radius | A request is offered only to cabs that can reach the pickup within R blocks of driving. For a busy pool cab, that counts the stops it makes first. |
| Rider patience | A rider with no match for this many seconds gives up. Once matched, they wait for their cab. |
| Pickup slip | When a cab reroutes to fit someone in, an already-promised pickup may slip by at most this many seconds. |

**Requests arrive at any time.** Matching runs every simulated second, oldest request first.

- **Solo riders** get the best idle cab in range.
- **Pool riders** can also be slotted into any pool cab in range, at any position in its remaining stops. The cab reroutes to make that happen. Every feasible slot is scored in rider-seconds:
  - the new rider's wait;
  - every extra second anyone spends in the car or waiting;
  - 0.5 × the extra cab-seconds.
- **Re-dispatch** (optional): a rider still waiting for their cab is moved to a cab that frees up much closer (it must save ≥ 8 s and ≥ 30%). Removing stops never makes anyone else later, because Manhattan distance obeys the triangle inequality.

**Driver time.** Every cab-second is classified as idle, driving empty, 1 aboard or 2 aboard. "Engaged" means the last three.

**Driver distance.** Distance is split the same way. A running cost per block gives earnings net of driving.

**The ping-radius sweep.** The report reruns the same city at radii from 2 blocks to unlimited, averaged over three random cities when that's fast enough. It recommends the tightest radius that delivers within 1% of the best.

## What the defaults show (200 riders, 30 cabs, 300 s)

- **The ping radius has a sweet spot.**
  - Too tight, and riders give up before any cab is in range: 78 lost at 2 blocks.
  - With no limit, the no-pool city delivers about 20 fewer riders than at its best radius. Cabs accept distant pickups and spend the run driving empty while nearer requests wait: empty blocks per pickup roughly double.
  - Pooling tolerates a wider radius than solo (≈ 30 vs 20 blocks): a busy pool cab nearby can absorb a request.
  - In a shortage (N = 15) the best radius tightens to 12–15 blocks. In a surplus (N = 60) the radius barely matters.
- **Rerouting is real and bounded.** About 18% of pool riders had their cab reroute mid-ride, some more than once. A few shared with two different people in turn. Nobody exceeded the cap.
- **Driver time and distance shift.**
  - Pooled cabs drive about 9% fewer blocks per driver and fewer empty blocks per pickup (7.2 vs 10.0).
  - Rider-blocks delivered per cab-block rise from 0.68 to 0.77.
  - Drivers are idle more (28% vs 22%).
  - Gross pay is flat, but earnings after running costs rise.

## Three things worth thinking about

The report computes each of these from the run you just watched. Each comes with a one-click "Try" that changes one setting so you can see the effect.

1. **Y is paid on every opt-in; X is paid only on a match.** The discount cost scales with the opt-in rate, but the efficiency (and the premium) scales with the match rate. Unmatched opt-ins are pure leakage, and the platform margin falls accordingly. Match rate is a density problem (riders per cab per block), not a pricing one.

2. **Whether drivers win depends on what's scarce, not on X.** On a pooled trip, each shared second is paid once instead of twice, detour seconds are paid, and X adds a premium. The report finds the break-even X for this run's routes, then splits the change in driver earnings into a waterfall:
   - shared seconds paid once
   - detour pay
   - premium
   - **fleet effect**: pooled cabs free up sooner and serve more riders

   In a shortage drivers gain. In a surplus the same X and Y leave them idler and poorer. A fixed premium can't be right in both regimes.

3. **The 1.5× promise covers the ride, not the trip, and not equally.** Waiting time isn't covered, so some pool riders arrive later than their no-pool twin even though the cap held. The detour also falls unevenly: the rider already aboard absorbs several times the extra time of the rider who joins, for the same Y. A fairer design would bound door-to-door time against the solo option and price the detour each rider actually absorbs.

## Files

```
index.html        page shell
styles.css        light + dark themes, responsive layout
js/sim.js         engine: demand, movement, plans, insertion, re-dispatch, accounting (no DOM)
js/metrics.js     twin-city comparison, earnings decomposition, ping-radius sweep (no DOM)
js/render.js      canvas map: cabs, routes, ping radius, reroutes, give-ups
js/report.js      formatting, SVG charts, end-of-run report and insights
js/app.js         controls, run loop, live tiles, hover inspector, radius sweep in Web Workers
test/sim.test.js  16 invariants: capacity along every plan, the cap, radius + slip, patience, time accounting, …
```

## Simplifications

- No traffic: travel time is distance ÷ speed, so ETAs are exact. Real pooling also has to absorb ETA error.
- Idle cabs wait where they are; there's no repositioning toward demand.
- Every pinged cab accepts. Drivers declining pool requests would shrink the effective radius.
- Demand is uniform random in space and time. Real commute corridors would raise match rates.
- A cab's plan holds at most 6 pending stops (3 riders lined up), which keeps matching fast.
- Requests late in the run may still be waiting or riding at P. They're reported, not dropped.
