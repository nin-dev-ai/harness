Task {{taskId}} could not merge: other agents' work landed on the integration branch first and touches the same lines.

Harness has already moved your work onto the latest integration branch. Where both changes touch the same lines, the files below contain git conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`):

{{files}}

Resolve every conflict by editing the files: keep both sides' intent (your change and theirs), remove all markers, and make sure the result works. Do not run `git rebase`, `git merge` or `git reset`; harness commits your edits. The integration branch's version comes from teammates, so check the team board before you discard any of it.

This is attempt {{attempt}} of {{attemptsMax}}. The checks and the review run again after you finish. Reply with a short summary of how you resolved each conflict.
