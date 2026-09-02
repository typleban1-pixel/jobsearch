-- Clearing a save is an UPDATE, not a DELETE.
--
-- The portal is granted no DELETE on any table, and carving an exception
-- for a preference table would be the first crack in that. An explicit
-- UNDECIDED state keeps the invariant and records more than a deletion
-- would: that a decision was made and then withdrawn.
--
-- Its own migration because ALTER TYPE ... ADD VALUE may not be used in
-- the same transaction that adds it.
alter type interest_state add value if not exists 'UNDECIDED';
