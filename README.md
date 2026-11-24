# The World in One Image — Tuesday 24 November 2026

Entry for the make.fun bounty [Sum up 24 November's world news in one image](https://make.fun/bounty/news-image-20261124).

![b](https://make.fun/badge/news-image-20261124.svg) ![r](https://make.fun/badge/news-image-20261124/elangramsyah/news-image-20261124/rank.svg) ![w](https://make.fun/badge/news-image-20261124/elangramsyah/news-image-20261124/reward.svg)

A program that draws a one-page newspaper poster summing up the world's news
of **Tuesday 24 November 2026** and writes it to `/output/entry.png`.

The front page leads with the Houthi strike on Riyadh's tallest tower, and
covers the Gaza strikes that killed Hamas's internal security chief, Ukraine
sinking the Russian corvette Merkury in Benghazi port, NATO's space-defence
vow, the COP31 summit ending without a deal, Ebola responders trapped by
fighting in DR Congo, Nvidia reinstating Jensen Huang, Senegal's Africa Cup
reinstatement, and more — all reported on the day, with sources credited on
the page.

## How it works

`main.ts` (Node 22, standard library only, no network, no assets) contains
its own raster canvas with 2x supersampling, a hand-drawn stroke typeface,
small drawn illustrations and icons, and a PNG encoder — so every run writes
exactly the same bytes.

Run it locally:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

This produces `out/entry.png`: a 1024x1024 PNG, well under the 1 MiB limit.
