# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Terminal states

The five roles above are triage states: they say what an **open** issue is waiting for. A closed issue
needs a different word, and this repo uses two.

| Label      | Meaning                                                                       |
| ---------- | ----------------------------------------------------------------------------- |
| `done`     | Implemented; the acceptance list is ticked and verified                        |
| `superseded` | The problem was real and is solved, but not the way this issue proposed. The `## Comments` entry must name what replaced it and account for every acceptance criterion |

`wontfix` remains distinct from both: it means nothing was actioned and nothing will be.

Edit the right-hand column to match whatever vocabulary you actually use.
