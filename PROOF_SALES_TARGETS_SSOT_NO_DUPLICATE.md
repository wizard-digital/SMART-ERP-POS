# Sales Targets SSOT / No Duplicate

Proven: 2026-10-04T15:53:01.741Z
Gates: 16/16

No stored achievement; scope shape CHECK; CI unique teams; membership PK; advisory-locked live overlap; GENERAL/TEAM/INDIVIDUAL cashier filters; progress=detail SSOT; no client revenue math; no double-penalty returns

- PASS NO_STORED_ACHIEVED: no achieved_amount column
- PASS SCOPE_SHAPE: DB CHECK scope shape
- PASS TEAM_NAME_CI: case-insensitive unique team names
- PASS MEMBER_PK: team membership PK blocks duplicate members
- PASS ADVISORY_LOCK: overlap checks take advisory xact lock
- PASS OVERLAP_ALL_SCOPES: live overlap enforced for all scopes
- PASS TEAM_DEDUP: team members deduped; duplicate names mapped
- PASS GENERAL_SHAPE_GUARD: GENERAL rejects salesperson/team mass-shape
- PASS ACH_SSOT_SINGLE: achievement SSOT server-only; strip no revenue math
- PASS PROGRESS_USES_SSOT: progress uses same calculateTargetAchievement as detail
- PASS REPO_FILTER_MODES: GENERAL=all cashiers; TEAM/INDIVIDUAL=explicit ids
- PASS FILTER_INDIVIDUAL: INDIVIDUAL filter is single id
- PASS FILTER_GENERAL: GENERAL filter is ALL cashiers
- PASS NET_ONCE: single sale nets 100
- PASS NET_NO_DOUBLE_PENALTY: VOIDED_BY_RETURN + refund = 0 (not -100)
- PASS VOID_EXCLUDED: VOID excluded from achievement
