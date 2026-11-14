# Simulator tab (lineup lab)

The Simulator tab has two views: the head-to-head Game simulator and the Lineup lab described here. In the Lineup lab you set lineups by drag and drop (or tap a player, then pick a slot), then run a season simulation that uses
injuries, byes, matchup strength, weather and betting lines. Entertainment and analysis only.

## How it fits together

- `scripts/lab-context.mjs` is the "server". A GitHub Action (`.github/workflows/lab-context.yml`) runs it every 3 hours
  and commits `data/lab-context.json` when something changed (and at least once a day). Nothing runs on a live server and
  no API keys are needed.
- The site reads that file, so no key or secret ever reaches the browser, and the file's `generated` time and `warnings`
  are shown on the tab. A source that fails is listed there; its numbers are skipped rather than reused.
- The season simulation runs in a Web Worker in the visitor's browser (`labWorkerMain` in `index.html`) with a progress bar.
- Lineup scenarios are saved in the visitor's browser (`localStorage`, wrapped in try/catch). Everything is read-only against Sleeper.
- SortableJS 1.15.7 (MIT) is copied into `index.html` so there is no CDN dependency.

## Data sources and terms of use

| Source | Used for | Notes |
|---|---|---|
| Sleeper API (`api.sleeper.app/v1`) | league, rosters, `/players/nfl` injuries, weekly stats | Public and read-only. Sleeper asks to stay under about 1,000 calls a minute; a run makes about 50 calls, most of them to ESPN and Open-Meteo. |
| ESPN site API (`site.api.espn.com/.../nfl/scoreboard`) | schedule, byes, kickoff times, roof, betting lines | **Unofficial and undocumented.** Not covered by a published license. It is the same feed the Dudley Zone tab uses. Fields can change without notice. If it fails, the file says so. |
| Open-Meteo (`api.open-meteo.com`) | hourly forecast at each outdoor stadium | Free for non-commercial use, no key, attribution appreciated (credited on the tab). |
| Vegas lines | implied team totals | Taken from the ESPN scoreboard feed above (no separate source). |

No site is scraped. Projections come from this league's own scoring history (see below), not from a third-party site.

## Projections and how to swap the provider

The default provider, `rolling`, is a recency-weighted average of a player's last 8 games under **this league's scoring**,
pulled toward replacement level when he has few games. Floor and ceiling are the 20th and 80th percentile of those games.

To use a different source, add a function to `PROVIDERS` in `scripts/lab-context.mjs`:

```js
PROVIDERS.myProvider = async (week, { players, history, season }) => ({
  [playerId]: { mean, sd, floor, ceil, src: 'Where this came from' }, // for every id in `players`
});
```

Then set `PROJECTION_PROVIDER: myProvider` in the workflow's `env`. Check the provider's terms first; do not scrape a site
that prohibits it. The client only reads `mean`, `sd`, `floor` and `ceil` from the JSON.

## How the numbers are built

- **Adjusted mean** = projection x matchup multiplier x weather factor x game-script factor.
- **Matchup**: points each defense has allowed per game to each position, as a multiplier clamped to 0.90 - 1.10 and shrunk
  toward 1.0 early in the season (weight games / (games + 4)).
- **Weather** (outdoor games only; domes and retractable roofs ignored): wind above 15 mph trims QB up to 8%, WR/TE up to 6%;
  kickers lose up to 10%; rain or snow trims passing 3 - 6%; very cold trims kickers 3%.
- **Game script**: implied team total vs a 22.5-point baseline moves QB/WR/TE about +/-7% at most, RB about 6%.
- **Availability**: Out and IR 0% this week; Doubtful 10%; Questionable about 65% (35 - 85% with practice reports);
  healthy 97%. For later weeks, Out becomes 35% and Questionable 90% (injuries heal or get worse; this is a guess).
  Bye weeks and players with no game score 0.
- **Simulation** (10,000 runs by default): each starter is drawn from a normal distribution truncated at 0, with a spread
  by position. Players on the same NFL team share a bit of game-level noise (QB 0.30, WR 0.25, TE 0.20, RB/K 0.10), a simple
  stand-in for "QB and WR1 rise together". Optional auto-sub replaces a starter who doesn't play with the best eligible bench player.
- **Other teams** use an auto-optimized lineup from the same projections. Your own lineups, and an opponent you edit, are used as set.
- **Your lineups vs auto-optimized** run on the same random draws, so the difference is not simulation noise.
- **Title odds** use each team's average projected weekly score for the playoff games.
- **Why a win probability moved** (top 3 factors) is worked out from the same inputs: points gained or lost from injuries,
  matchup strength, wind and betting lines for both lineups. It explains the projection; it does not decompose the simulation.

## Tests

`node --test tests/lab.test.mjs` runs lineup validation, the simulation sampling and the data model. The lineup and worker
code is read straight out of `index.html`.

## Assumptions and known limitations

- Projections are a rolling average, not an expert forecast, and do not know about role changes, trades or rookies' usage.
- Defense and kicker projections use the same rolling method; IDP positions are not projected.
- Matchup strength uses a player's current NFL team for past weeks, so a traded player's old games count toward his new team's opponents.
- Weather forecasts exist only about 15 days out; later games have no weather adjustment.
- Injury news in the file is only as fresh as the last run (every 3 hours). Inactive lists an hour before kickoff are not included.
- Best case = plays and scores at his ceiling; worst case = scores at his floor (injury odds still apply).
- Slot rules cover QB, RB, WR, TE, K, DEF, FLEX, WRRB, REC, SUPER_FLEX and basic IDP. Taxi eligibility (rookie status) is not checked.
- Ties in the standings are broken by points for, as on the Playoff Odds tab. The Path to the Playoffs and Playoff Odds sections
  use their own, lineup-free simulation and will not change when you edit lineups here.
