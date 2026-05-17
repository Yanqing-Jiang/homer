-- 096_drop_idea_index.sql
-- Drops the legacy idea_index table.
--
-- Background: idea_index was a parallel mirror of the ideas table maintained
-- by IdeasIndexer (chokidar file watcher) and the DAO's syncToIdeaIndex.
-- It drifted (148 vs 117 rows in production) because parser.ts:saveIdeaFile
-- was called from bot handlers + smart-save outside the DAO transaction.
--
-- Resolution: PR 2 routes ALL idea writes through the DAO and reads through
-- dao.getAllIdeas/getIdea directly, so the mirror is no longer needed.
-- The IdeasIndexer class is deleted in the same PR.

DROP TABLE IF EXISTS idea_index;
