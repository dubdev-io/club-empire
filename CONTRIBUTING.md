# Contributing

## Reviewing a pull request

All of our automated work pushes, opens and reviews pull requests as **one GitHub account**. GitHub does not let an account approve its own pull request, so a reviewer can never put a formal `APPROVE` or `REQUEST CHANGES` on a pull request that we opened. GitHub answers the attempt with *"Can not approve your own pull request"*.

We therefore carry the verdict in the review body instead of in the GitHub review state.

**1. The reviewer posts a `COMMENT` review.** Its first line is exactly one of the following, optionally prefixed with Markdown heading marks (`## `) so it renders as a heading:

```
Verdict: APPROVE — no changes requested
Verdict: APPROVE WITH NITS — <n> optional items
Verdict: REQUEST CHANGES — <n> required items
```

Nothing else goes before that line — the merger matches it after stripping any leading `#` characters and spaces. The rest of the review follows it.

**2. The person or agent who merges reads that first line.** Do not wait for a green check. A pull request that we opened will never get one.

**3. The same verdict goes on the review issue in Paperclip.** The board is our record of approval, not GitHub.

**4. Never review your own pull request.** The author must not write the review. One shared account is not a reason to drop to one pair of eyes.

**5. Do not switch on the "Require approvals" branch protection rule.** While we share one account it would make every pull request of ours impossible to merge.

---

## Why the rules say that

### The fact behind it

Verified on 2026-10-04: the GitHub identity in use is **`prioa`** (`get-me` → `login: prioa`, id 81706755). Credential mode is `managed`. Every agent on the team — author, reviewer, merger — presents that same account.

### What it costs us

- GitHub's own review history is useless as proof of review. Every review in it is a `COMMENT` by `prioa`. You cannot tell from GitHub whether a pull request was reviewed, by whom, or what they concluded. Only the Paperclip issue can tell you that. Rule 3 exists for this reason alone.
- We cannot use any branch protection rule that counts approvals, and we cannot use GitHub's "dismiss stale approvals" behaviour. Rule 5.
- Nothing is blocked today. PR #11 merged with no approval on it, which confirms no protection rule is currently demanding one.

### The failure this prevents

A merging agent that waits for a green check waits forever, and the natural next move — re-requesting review, or self-approving — either loops or quietly removes the second pair of eyes. Rule 2 names the thing that will never happen so nobody waits on it.

### The thing this does not fix

A second GitHub account, added to the repository as a collaborator and used only by the reviewing agents, would restore real `APPROVE` and `REQUEST CHANGES`, make GitHub's review history meaningful again, and let us turn on required-approval branch protection. That needs the owner to create the account and add it. It is asked on DUB-23. Until the answer is yes, the five rules above are what we do.

## Where this came from

PR [#11](https://github.com/dubdev-io/club-empire/pull/11), reviewed under DUB-23. The Web Developer hit the refusal while reviewing, posted the verdict as the first line of a `COMMENT` review, and flagged that every pull request we review will hit the same wall. The Game Developer merged on that first line and seconded the flag.
