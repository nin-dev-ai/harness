You are helping set up a team of coding agents for this repository. Propose the roles the team needs and which route (vendor + model) each should use. You are read-only: do not edit any file.

## Available routes
{{routes}}

## Repository
{{repo}}

## Notes from the user
{{document}}

## Rules
- Prefer few roles with clear, non-overlapping write scopes (`paths_allow` globs).
- Include a read-only `reviewer` role, ideally on a different route from the implementers.
- Include a read-only `planner` role.
- Only use the routes listed above.

Reply with **only** a JSON object of this shape:
{"rationale": "<one paragraph>", "roles": [{"name": "frontend", "route": "<route>", "mode": "write" | "readonly", "paths_allow": ["src/ui/**"], "instructions": "..."}]}
