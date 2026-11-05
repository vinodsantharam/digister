# Real recorded payloads

Recorded X (Twitter) GraphQL responses from the open-source Python package
[twscrape](https://github.com/vladkens/twscrape), version 0.20.1 (PyPI sdist
`twscrape-0.20.1.tar.gz`), file path inside the sdist `tests/mocked-data/`.
License: MIT, Copyright (c) 2023 vladkens (see `twscrape-LICENSE.txt`), which permits redistribution.

| File here | Original file | Operation | Changes |
| --- | --- | --- | --- |
| `twscrape-list-latest-tweets-timeline.json` | `raw_list_timeline.json` | `ListLatestTweetsTimeline` | Timeline entries trimmed from 97 to 43 (first 40, the cursors, and the entry holding the only `TweetWithVisibilityResults`). Entries themselves are untouched. |
| `twscrape-user-tweets.json` | `raw_user_tweets.json` | `UserTweets` (profile timeline with a `TimelinePinEntry`, reposts, quotes) | Timeline entries trimmed from 22 to 16. Entries themselves are untouched. |

twscrape has no home/following timeline recording, so `HomeLatestTimeline` has no real fixture; the
hand-written `x-following-timeline.json` still covers it. No real YouTube channel feed (`videos.xml`)
could be found in any package checked (twscrape, rss-parser, feedparser, feedsmith,
@extractus/feed-extractor, @rowanmanning/feed-parser), so the YouTube fixture stays hand-written.
