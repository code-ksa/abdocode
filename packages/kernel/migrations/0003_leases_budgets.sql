
-- Leases and budgets.
--
-- Both exist to survive a restart, which is the only reason they are here and
-- not in memory. A fencing token kept in RAM is reset by the crash it was meant
-- to defend against, and a budget kept in RAM forgets everything the process
-- already spent.
--
-- Leases are append-only: a new generation is a new row, and the highest
-- generation for a scope is its current holder. Revocation is therefore an
-- insert, not an update, so no writer can quietly walk a generation backwards.
--
-- Budgets are the one table here that is updated, because consumption grows.
-- The triggers below allow exactly that and nothing else: consumed may only
-- increase, and a limit may not be changed at all. A budget whose ceiling could
-- be raised in place is not a limit, it is a suggestion.
--
-- Statement text below a marker must begin with its CREATE, because the
-- canonical schema manifest matches each object by that prefix.
-- ABDO_MIGRATION_STATEMENT
CREATE TABLE journal_budgets (
    scope_id BLOB NOT NULL CHECK (length(scope_id) = 16),
    dimension INTEGER NOT NULL CHECK (dimension >= 1 AND dimension <= 4),
    limit_value INTEGER NOT NULL CHECK (limit_value >= 0),
    consumed INTEGER NOT NULL CHECK (consumed >= 0 AND consumed <= limit_value),
    PRIMARY KEY (scope_id, dimension)
) STRICT;
-- ABDO_MIGRATION_STATEMENT
CREATE TABLE journal_leases (
    scope_id BLOB NOT NULL CHECK (length(scope_id) = 16),
    generation INTEGER NOT NULL CHECK (generation > 0),
    holder_id BLOB NOT NULL CHECK (length(holder_id) = 16),
    issued_at_ms INTEGER NOT NULL CHECK (issued_at_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > issued_at_ms),
    PRIMARY KEY (scope_id, generation)
) STRICT;
-- ABDO_MIGRATION_STATEMENT
CREATE INDEX journal_leases_current
    ON journal_leases(scope_id, generation DESC);
-- ABDO_MIGRATION_STATEMENT
CREATE TRIGGER journal_budgets_consumption_only_grows
BEFORE UPDATE ON journal_budgets
WHEN NEW.consumed < OLD.consumed
  OR NEW.limit_value != OLD.limit_value
  OR NEW.scope_id != OLD.scope_id
  OR NEW.dimension != OLD.dimension
BEGIN
    SELECT RAISE(ABORT, 'budget consumption may only grow and a limit may not move');
END;
-- ABDO_MIGRATION_STATEMENT
CREATE TRIGGER journal_budgets_no_delete
BEFORE DELETE ON journal_budgets
BEGIN
    SELECT RAISE(ABORT, 'budgets cannot be deleted');
END;
-- ABDO_MIGRATION_STATEMENT
CREATE TRIGGER journal_leases_no_update
BEFORE UPDATE ON journal_leases
BEGIN
    SELECT RAISE(ABORT, 'lease generations are append-only');
END;
-- ABDO_MIGRATION_STATEMENT
CREATE TRIGGER journal_leases_no_delete
BEFORE DELETE ON journal_leases
BEGIN
    SELECT RAISE(ABORT, 'lease generations are append-only');
END;
