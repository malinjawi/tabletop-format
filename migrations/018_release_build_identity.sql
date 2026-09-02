-- Persist export inputs that are not in the game tree (notably hosted URL
-- origin), so a restored release can be reproduced byte-for-byte.
ALTER TABLE releases ADD COLUMN build_json TEXT;
