PoolSim changes

Open index.html in a browser and press Start. The two maps are the same city. The left one can share a cab. The right one cannot. Press Report when the clock stops, or press Stop and then Report for a look partway through.

One booking is still one person. A cab still never carries a third person.

1. A driver does not take a losing trip
A cab takes a rider only when that rider's fare covers the extra pay and the fuel. Driving empty to the pickup is unpaid, and fuel is charged for every block. If fuel is the larger cost, the difference is paid when that rider is dropped off. The number that must stay at zero or better is the projected net: cash so far, plus the rest of the open trip.

How to see it
Hover a cab, or focus a map and use the arrow keys. The tip shows Projected net. It should not be below $0.
In the report, under Drivers, read Lowest projected net. Below zero would mean a losing dispatch.
To watch trips get refused, set Driver running cost to 0.30 and Ping radius to 40, then Reset and Start. More riders give up, because a long empty drive is no longer worth taking. Lowest projected net still stays at zero or better. The earnings chart has a Fuel top-up bar for the gaps the fare did cover.

2. The pool discount is only for a trip that shared
At pickup, a pool rider is quoted the flat discount (Y). At drop-off the fare is settled. A rider who never shared pays the full solo fare. A rider who shared pays less the longer their detour, and never more than the flat discount. A second rider is accepted only when their fare also covers the refund to the person already aboard.

How to see it
While the run is going, the Pool riders saved tile says the discount applies only if they shared.
In the report, the first note is "The discount is for sharing, and a longer detour pays less." It counts riders who never shared and the money a flat discount would have given them for nothing. It also counts what riders who did share actually saved.
Raise Pool rider discount and fewer trips share, because the refund gets harder to fund. Lower it and more trips share.

3. The time cap covers the whole trip when a solo cab was free
Time in the car still stays within Max time in car vs. solo (1.50× by default). If an idle cab was in range when the rider was matched, the whole trip, from request to drop-off, also stays within that multiple of the solo trip they could have taken then. If no solo cab was in range, only the time in the car is capped. The other map is not used for this check.

How to see it
Hover a pool cab that has someone aboard. The tip shows the arrival as a multiple of the cap, for example 1.04× of 1.50×.
In the report, the third note is "Door-to-door time stays within the solo option that was available." On a normal run it should say that none of the riders who had a solo cab finished later than the cap. The Try button next to it tightens the cap to 1.20× so you can watch matches get pickier.

4. The closest sensible pair is matched, not the person who has waited longest
Each second, every cab in range is scored against every rider it could take. The score is the extra time the match would cost, minus how long that rider has already waited. The best pairs are assigned first. A cab takes one new rider, then a pool cab may take a second. There is no switch back to the old "oldest request grabs the nearest cab" rule.

How to see it
In the report, compare the two cities on riders delivered, average wait for pickup, and empty blocks per pickup. Pooling should not win those by sending a cab across the city for whoever has been waiting longest.
This is the hardest change to see on the map itself. The check is the report table, not a new control.

5. A closed area appears halfway through the run
At 45% of the clock a diamond 6 blocks across closes in both cities. The spot is chosen from the seed, so the same seed puts it in the same place. With the default 300 second run, that is 135 seconds. Trips that start or end inside are cancelled. A cab that is inside and has no stop outside drives to the nearest point outside and drops anyone whose destination was inside. Uber covers what that exit still lacks, so the driver does not go below zero. A cab that is already outside goes around the diamond instead of through it. The route on the map bends around the red area.

How to see it
Watch either map as the clock passes 45% of the duration. A red diamond fades in. The legend calls it Closed area. The same diamond is on both maps.
After it appears, no cab outside the diamond steps into it. Routes bend around it.
No pickup or drop-off is drawn inside it. Riders who were still waiting for a trip that touches it are marked with a red ×.
If a cab is inside the diamond, its route leads out. Hover it and check Projected net. Leaving the area does not push that number below zero.
The size and the timing are fixed. There is no setting for them.

6. Left turns are slower, right turns wait at a light
A left turn, as it looks on the map, makes the next block take 25% longer. The cab does not stop. A right turn waits the time of one block at a light, then drives that block at the normal speed. When a stop can be reached by a left or a right, the cab takes the left and skips the light.

How to see it
Hover a cab with someone aboard. The arrival multiple is against the straight-line solo estimate. A trip that turns sits above 1× even when the cab did not detour for a pool rider. A trip that stays on one street does not pick up that extra time.
The report's "Extra time in the car" includes these turns as well as pool detours.

What changed after the first four rules from the form
The first four rules are the ones the work started with. The driver is still the person those rules are for. Two things were added after that, and one assumption moved.

Travel time is no longer only distance divided by speed. A left turn takes 25% longer and does not stop. A right turn waits the time of one block at a light. There is still no traffic jam. When both ways to a stop are open, the cab takes the left and skips the light. That is item 6.

A closed area was not one of the four ideas. At 45% of the run a 6-block diamond closes on both maps. Trips that touch it are cancelled. A cab inside drives out. A cab already outside goes around it. That is item 5.

The driver rule was narrowed in one place. A normal trip is still refused when the fare cannot cover it. Uber still does not pay for a bad dispatch. The closed area is the exception: the platform shut the street, so Uber covers the shortfall from the drive out, and only that. The rider is cancelled, not sent on a worse trip with no rule.

The discount and the premium were modified. At 30% off and a 25% premium, drivers on the default city earned less than in the city with no pooling. The second fare could not fund the refund, so few trips shared, and those were paid once. The default is now 10% off and a 40% premium. More trips share, riders save more in total, and driver earnings on that city finish above the city with no pooling. The cab still refuses a trip the fare cannot cover. Set the discount back to 30% and that gap returns. With many more cabs than riders, the fleet can still earn less, because one shared trip replaces two paid ones and no one is left waiting.

The rest did not move. One booking is one person. A cab holds two. The two cities do not use each other's cabs. The fare is still quoted from the solo trip and settled at drop-off. Below zero still means the open trip finished, not the cash in the middle of a pickup.

How AI was used
The sim was already here. The rules for what to change were set before any code was written: two people in a cab, one person per booking, a driver who does not finish below zero, and a result that still has to work for the rider and for Uber.

AI was used to read the engine, find the runs where a driver goes below zero, and compare a few fare rules on the default city. It also drafted the code that puts those rules into the existing planner, and the checks that fail if a rule breaks.

It did not pick the product. One suggestion was that Uber should pay whatever a driver is short, on every trip. That was not used for a normal dispatch. A top-up is paid only when the rider's fare already covers the fuel. Otherwise the cab does not take the trip. The only later exception is the closed area, above. A new booking screen, a new look for the page, traffic, sending idle cabs toward demand, and a full optimal matcher were suggested and left out. The closed area and the turn timing were asked for and added to the movement the sim already had.

Left out
No booking form. Idle cabs are not sent toward busy areas. There is no traffic jam. Turns cost time, as in item 6. The page was not restyled. Matching is a sorted list of pairs, not a full optimal assignment. The light is always one block of waiting, not a real signal.

AI Tool Used : Cursor