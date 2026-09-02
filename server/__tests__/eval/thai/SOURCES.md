# Thai eval corpus — origin and licence

Every document in `corpus/` was **written from scratch for this repository** by
the issue 44 author. None is copied, adapted, scraped, or machine-translated
from any external source.

| Origin | Licence | Documents |
|---|---|---|
| Original work authored for this repo | Same licence as this repository | all 22 |

The recon (`.infi/recon/v1-c-thai-eval-set.md` §2) permits either Thai
government documents or original writing. Original writing was chosen because
the task brief required it, and because it removes the licence question
entirely: a corpus that lives in the repo forever should not depend on a
third-party licence assessment that nobody re-checks.

The trade-off is register. These documents imitate the phrasing of Thai
procurement regulation, HR policy, and internal technical standards, but they
are not real ระเบียบ. Recall on genuine legal boilerplate may run slightly
lower than these numbers suggest.

## Composition

| Prefix | Bucket | Documents |
|---|---|---|
| `proc-` | formal government prose | 5 |
| `hr-`, `policy-` | formal government prose | 7 |
| `tech-` | mixed Thai/English technical | 5 |
| `mixed-` | inconsistent transliteration | 5 |

The `mixed-` documents deliberately spell the same concept two ways within one
document (คอมพิวเตอร์ and `computer`, ไวไฟ and `wifi`, ไลเซนส์ and `license`),
which is how real internal Thai documents are written and a case a splitter or
embedder can fail on without any other document noticing.

## Freezing rule

The corpus is frozen as of issue 44. Changing a document changes every number
measured against it, so an edit is a pull request of its own with a stated
reason. See the recon, section 0: a corpus edited while tuning an embedder
produces a number that goes up and a system that does not improve.
