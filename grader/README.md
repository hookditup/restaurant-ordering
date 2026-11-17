# Restaurant Grader (grader.hookditup.com)

A free audit that scores a restaurant out of 100 on its Google listing, website, online ordering and local ranking,
then asks for contact details to show the full report. Leads go to the Hook'd IT Up GHL account with the
`grader-lead` tag, which starts the follow-up workflow.

Run: `node server.js` (Node 20+, no dependencies).

| Variable | Needed | What |
|---|---|---|
| `GOOGLE_PLACES_KEY` | yes | Google key with Places API (New) enabled |
| `PAGESPEED_KEY` | no | Key with PageSpeed Insights API enabled. Defaults to the Places key |
| `GHL_TOKEN` | for leads | Hook'd IT Up Private Integration token (contacts.write, contacts.readonly) |
| `GHL_LOCATION_ID` | for leads | `dcPoMXQFHI41aUqwe1jX` |
| `DATA_DIR` | yes on Railway | Folder on a persistent volume for saved reports and a copy of each lead |
| `PUBLIC_URL` | no | Defaults to `https://grader.hookditup.com` |

Reports are cached for 24 hours per restaurant to keep Google costs down. Each visitor can run 8 reports an hour.

Local test with fake Google data: `GOOGLE_PLACES_KEY=fake PORT=3399 node --import ./test/mock.mjs server.js`, then `node test/flow.cjs`.
