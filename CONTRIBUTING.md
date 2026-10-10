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

If no review on the pull request has a conforming first line, there is no verdict. Do not merge; ask the reviewer for one.

**3. The same verdict goes on the review issue in Paperclip.** The board is our record of approval, not GitHub.

**4. Never review your own pull request.** The author must not write the review. One shared account is not a reason to drop to one pair of eyes.

**5. Do not switch on the "Require approvals" branch protection rule.** While we share one account it would make every pull request of ours impossible to merge.

**6. Several reviewers.** When a pull request has more than one reviewer, each posts their own verdict review. The merger needs a conforming `APPROVE` or `APPROVE WITH NITS` from every reviewer who was asked. The reviewers who were asked are the ones named on the Paperclip review issue, not the GitHub Reviewers field — on our pull requests that field cannot name us. A single `REQUEST CHANGES` outranks all of them.

**7. A verdict applies to the commit it was posted against.** Name the commit you reviewed in your review. The merger checks that the named commit is the current head before merging; if it is not, there is no current verdict. If the author pushes after a verdict, that verdict is stale — the author says so in a comment and asks for a re-review.

---

## Where a pull request points

`phase1-build` is the integration branch. All Phase 1 work lands there. We **squash-merge** into it: one commit for one ticket.

**8. Branch from `phase1-build`, and open the pull request against `phase1-build`.** Do not point a pull request at another pull request's branch. One ticket, one branch, one pull request, one target.

**9. If your ticket needs work that has not landed yet, wait for it.** Record the dependency as a blocker on the Paperclip issue. Do not build on the other branch. When the other ticket lands, branch again from `phase1-build` and start there.

**10. Before you merge, check that the target branch is still live.** A branch dies the moment its own pull request merges. Run:

```
gh pr list --state merged --head <target-branch>
```

If that prints a pull request, the target is dead. **Do not merge.** Rebase the work onto `phase1-build`, re-point the pull request, and ask for a re-review under rule 7. Merging into a dead branch reports success and delivers nothing.

Do not use an ancestry test (`git merge-base --is-ancestor`) for this. We squash-merge, so a squashed branch's commits never become ancestors of `phase1-build`, and the dead branch still reads as live.

---

## Why the rules say that

### The fact behind it

Verified on 2026-10-04: the GitHub identity in use is **`prioa`** (`get-me` → `login: prioa`, id 81706755). Credential mode is `managed`. Every agent on the team — author, reviewer, merger — presents that same account.

### What it costs us

- GitHub's own review history is useless as proof of review. Every review in it is a `COMMENT` by `prioa`. You cannot tell from GitHub whether a pull request was reviewed, by whom, or what they concluded. Only the Paperclip issue can tell you that. Rule 3 exists for this reason alone.
- We cannot use any branch protection rule that counts approvals, and we cannot use GitHub's "dismiss stale approvals" behaviour. Rules 5 and 7.
- Nothing is blocked today. PR #11 merged with no approval on it, which confirms no protection rule is currently demanding one.

### The failure this prevents

A merging agent that waits for a green check waits forever, and the natural next move — re-requesting review, or self-approving — either loops or quietly removes the second pair of eyes. Rule 2 names the thing that will never happen so nobody waits on it.

### The thing this does not fix

A second GitHub account, added to the repository as a collaborator and used only by the reviewing agents, would restore real `APPROVE` and `REQUEST CHANGES`, make GitHub's review history meaningful again, and let us turn on required-approval branch protection. It needs the owner to create the account and add it — no agent can do that step.

**Asked and answered on 2026-10-04: not now.** The owner parked it until something actually needs it. So the seven review rules above are not a stopgap waiting on an account; they are how we review, and a reviewer should not apologise for a `COMMENT` verdict.

The standing decision, with the full cost and benefit written out, lives on Paperclip issue DUB-28. Reopen it there if a need appears — somebody outside the team has to be able to prove a pull request was reviewed, an outside contributor joins, or we want rule 4 enforced by the machine instead of by convention. If the answer ever becomes yes, rules 2, 5 and 7 are revisited with it, and this file is the one place that changes.

### The merge that delivered nothing

Rules 8 to 10 came from a real loss, not a theory.

PR #19 squash-merged `DUB-38-cta-press-feedback` into `phase1-build` as `038a8ae`. A squash does not keep the branch's own commits, so the branch tip stopped being reachable from `phase1-build`. Eighty minutes later PR #23 merged into `DUB-38-cta-press-feedback`. GitHub accepted it and reported it merged. The merge commit `ba5aa2d` sits on a branch that nothing flows out of, so the fix never reached the build, and no open pull request would have carried it there. It looked done. It was not.

On 2026-10-10 four more open pull requests pointed at branches that were already squashed away — #37 and #22 at `DUB-38-cta-press-feedback`, #33 at `DUB-56-canvas-pip-outline` (landed by #26), #24 at `DUB-42-maxed-badge-aa` (landed by #20). Each was queued for the same silent failure.

The choice behind rule 8 is deliberate. Pointing a child at its parent branch gives a smaller diff to read; pointing it at `phase1-build` survives the parent landing. We take the bigger diff. A diff that is harder to read costs a reviewer some minutes. A merge that delivers nothing costs the work, and hides the loss behind a green "merged".

We keep squash-merging. The squash is not the fault — one commit for one ticket is worth keeping. Stacked branches are the fault.

## Where this came from

Rules 1 to 7: PR [#11](https://github.com/dubdev-io/club-empire/pull/11), reviewed under Paperclip issue DUB-23. The Web Developer hit the refusal while reviewing, posted the verdict as the first line of a `COMMENT` review, and flagged that every pull request we review will hit the same wall. The Game Developer merged on that first line and seconded the flag.

Rules 8 to 10: Paperclip issue DUB-115. The Game Developer found PR #23 merged into a branch that had already been squashed away, raised the pattern instead of only fixing their own ticket, and asked for a ruling rather than taking one. Ruled by the Senior on 2026-10-10.
