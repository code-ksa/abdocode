use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use abdo_contracts::{decode_frame, encode_frame, AdmissionEvent, EventId};
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::{params, Connection, ErrorCode, OpenFlags, OptionalExtension, Transaction};

use crate::effects::{
    effect_record_hash, insert_effect_record, query_effect_tail, read_effect_history,
    read_effect_ids, EffectAppendReceipt, EffectAppendRequest, EffectHashInput, EffectId,
    EffectRecord,
};
use crate::govern::{
    charge_budget, insert_lease, read_budget, read_current_lease, upsert_budget, BudgetRecord,
    HolderId, LeaseRecord, ScopeId,
};
use crate::hash::{blob_hash, event_hash};
use crate::identity::{harden_connection, verify_hardened_connection, SqliteIdentity};
use crate::migration::{
    migrate, verify_migration_history, verify_persisted_identity, verify_schema_manifest,
    LATEST_SCHEMA_VERSION,
};
use crate::model::MAX_DERIVED_BLOB_BYTES;
use crate::{
    AppendReceipt, AppendRequest, BlobHash, ChainHash, CheckpointReport, CompactRequest,
    CompactedEntry, CompactionReceipt, CompactionRecord, EventEnvelope, Head, IntegrityReport,
    JournalError, JournalOptions, ProjectionKey, ProjectionRecord, RestorePlan, SnapshotRecord,
    StreamId,
};

const MAX_WRITER_WAIT_MS: u64 = 5_000;

#[derive(Debug)]
pub struct Journal {
    connection: Connection,
    database_path: PathBuf,
    identity: SqliteIdentity,
    #[cfg(windows)]
    _identity_handle: fs::File,
    file_scope: FileScopeIdentity,
    _file_registration: FileRegistration,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct PlatformFileIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    creation_time: u64,
    #[cfg(windows)]
    canonical_path: PathBuf,
    #[cfg(not(any(unix, windows)))]
    canonical_path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileScopeIdentity {
    canonical_path: PathBuf,
    platform: PlatformFileIdentity,
}

#[derive(Debug)]
struct FileRegistration {
    platform: PlatformFileIdentity,
}

static OPEN_FILE_IDENTITIES: OnceLock<Mutex<HashSet<PlatformFileIdentity>>> = OnceLock::new();

impl Journal {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, JournalError> {
        Self::open_with_options(path, JournalOptions::default())
    }

    pub fn open_with_options(
        path: impl AsRef<Path>,
        options: JournalOptions,
    ) -> Result<Self, JournalError> {
        let database_path = validated_database_path(path.as_ref())?;
        let wait_ms = u64::try_from(options.writer_wait.as_millis())
            .map_err(|_| JournalError::InvalidInput("writer wait does not fit u64 milliseconds"))?;
        if wait_ms > MAX_WRITER_WAIT_MS {
            return Err(JournalError::InvalidInput(
                "writer wait must be bounded to at most 5000ms",
            ));
        }

        ensure_database_file(&database_path)?;
        #[cfg(windows)]
        let identity_handle = open_windows_identity_handle(&database_path)?;
        let file_scope = FileScopeIdentity::capture(&database_path)?;
        let database_path = file_scope.canonical_path.clone();
        let file_registration = FileRegistration::acquire(&file_scope.platform, wait_ms)?;
        let connection = Connection::open_with_flags(
            &database_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|source| map_open_error(source, wait_ms, "open journal database"))?;
        reject_existing_reparse_point(&database_path)?;
        if FileScopeIdentity::capture(&database_path)? != file_scope {
            return Err(JournalError::Integrity(
                "journal database identity changed while SQLite opened it".to_owned(),
            ));
        }
        connection
            .busy_timeout(options.writer_wait)
            .map_err(|source| JournalError::sqlite("set writer wait", source))?;
        harden_connection(&connection)?;
        connection
            .pragma_update(None, "foreign_keys", true)
            .map_err(|source| JournalError::sqlite("enable foreign keys", source))?;
        connection
            .pragma_update(None, "trusted_schema", false)
            .map_err(|source| JournalError::sqlite("disable trusted schema", source))?;

        let locking_mode = connection
            .pragma_update_and_check(None, "locking_mode", "EXCLUSIVE", |row| {
                row.get::<_, String>(0)
            })
            .map_err(|source| map_open_error(source, wait_ms, "set exclusive locking mode"))?;
        if !locking_mode.eq_ignore_ascii_case("exclusive") {
            return Err(JournalError::SqliteIdentity(format!(
                "locking mode is {locking_mode:?}, not exclusive"
            )));
        }
        connection
            .execute_batch("BEGIN EXCLUSIVE; COMMIT;")
            .map_err(|source| map_open_error(source, wait_ms, "acquire sole writer lock"))?;

        let journal_mode = connection
            .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0))
            .map_err(|source| map_open_error(source, wait_ms, "enable WAL mode"))?;
        if !journal_mode.eq_ignore_ascii_case("wal") {
            return Err(JournalError::SqliteIdentity(format!(
                "journal mode is {journal_mode:?}, not WAL"
            )));
        }
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|source| JournalError::sqlite("set full synchronization", source))?;
        connection
            .pragma_update(None, "wal_autocheckpoint", 0_u32)
            .map_err(|source| JournalError::sqlite("disable automatic checkpoints", source))?;
        connection
            .pragma_update(None, "temp_store", "MEMORY")
            .map_err(|source| JournalError::sqlite("keep temporary state in memory", source))?;
        connection
            .pragma_update(None, "cache_size", -16_384_i64)
            .map_err(|source| JournalError::sqlite("bound SQLite page cache", source))?;
        connection
            .pragma_update(None, "mmap_size", 0_i64)
            .map_err(|source| JournalError::sqlite("disable database mmap", source))?;
        verify_sidecar_scope(&database_path)?;

        let mut connection = connection;
        let mut identity = SqliteIdentity::inspect(&connection)?;
        migrate(&mut connection, &database_path, &identity)?;
        identity.schema_version = connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
            .map_err(|source| JournalError::sqlite("read migrated schema version", source))?;
        if identity.schema_version != LATEST_SCHEMA_VERSION {
            return Err(JournalError::UnsupportedSchema {
                found: identity.schema_version,
                supported: LATEST_SCHEMA_VERSION,
            });
        }
        if identity.journal_mode != "wal" {
            return Err(JournalError::SqliteIdentity(
                "journal did not remain in WAL mode".to_owned(),
            ));
        }
        install_runtime_authorizer(&connection)?;

        let journal = Self {
            connection,
            database_path,
            identity,
            #[cfg(windows)]
            _identity_handle: identity_handle,
            file_scope,
            _file_registration: file_registration,
        };
        journal.verify_on_open()?;
        Ok(journal)
    }

    pub const fn sqlite_identity(&self) -> &SqliteIdentity {
        &self.identity
    }

    pub fn append(&mut self, request: AppendRequest<'_>) -> Result<AppendReceipt, JournalError> {
        self.verify_file_scope()?;
        validate_append_request(&request)?;
        crash(&self.database_path, "append.before_begin");
        let transaction = self
            .connection
            .transaction()
            .map_err(|source| JournalError::sqlite("begin journal append", source))?;
        crash(&self.database_path, "append.after_begin");

        let actual_head = query_head(&transaction, request.stream_id)?;
        if actual_head != request.expected_head {
            return Err(JournalError::CasConflict {
                expected: request.expected_head,
                actual: actual_head,
            });
        }

        let event_id = admission_event_id(request.event);
        if event_id_exists(&transaction, event_id)? {
            return Err(JournalError::DuplicateEvent {
                event_id: event_id.get(),
            });
        }
        if let Some(projection) = request.projection {
            let actual_sequence =
                query_projection_sequence(&transaction, request.stream_id, projection.key)?;
            let expected_actual = if projection.expected_sequence == 0 {
                None
            } else {
                Some(projection.expected_sequence)
            };
            if actual_sequence != expected_actual {
                return Err(JournalError::ProjectionCasConflict {
                    key: projection.key.clone(),
                    expected_sequence: projection.expected_sequence,
                    actual_sequence,
                });
            }
        }

        let previous_hash = actual_head.map_or(ChainHash::ZERO, |head| head.hash);
        let stream_sequence = checked_next(actual_head.map_or(0, |head| head.sequence))?;
        let current_global = query_next_global_sequence(&transaction)?;
        let global_sequence = checked_next(current_global)?;
        let event_frame = encode_frame(request.event).map_err(JournalError::ContractEncode)?;
        let hash = event_hash(
            request.stream_id,
            global_sequence,
            stream_sequence,
            event_id.get(),
            previous_hash,
            &event_frame,
        );

        transaction
            .execute(
                "INSERT INTO journal_events (
                    global_sequence, stream_id, stream_sequence, event_id,
                    previous_hash, event_hash, event_frame
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    sequence_i64(global_sequence)?,
                    request.stream_id.to_be_bytes().as_slice(),
                    sequence_i64(stream_sequence)?,
                    event_id.get().to_be_bytes().as_slice(),
                    previous_hash.as_bytes().as_slice(),
                    hash.as_bytes().as_slice(),
                    event_frame,
                ],
            )
            .map_err(|source| JournalError::sqlite("insert event envelope", source))?;
        crash(&self.database_path, "append.after_event_insert");

        if let Some(projection) = request.projection {
            let content_hash = insert_blob(&transaction, projection.bytes)?;
            transaction
                .execute(
                    "INSERT INTO journal_projections (
                        stream_id, projection_key, through_sequence, source_hash, blob_hash
                     ) VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(stream_id, projection_key) DO UPDATE SET
                        through_sequence = excluded.through_sequence,
                        source_hash = excluded.source_hash,
                        blob_hash = excluded.blob_hash",
                    params![
                        request.stream_id.to_be_bytes().as_slice(),
                        projection.key.as_str(),
                        sequence_i64(stream_sequence)?,
                        hash.as_bytes().as_slice(),
                        content_hash.as_bytes().as_slice(),
                    ],
                )
                .map_err(|source| JournalError::sqlite("advance projection", source))?;
        }
        crash(&self.database_path, "append.after_projection");

        if let Some(snapshot) = request.snapshot {
            let content_hash = insert_blob(&transaction, snapshot.bytes)?;
            transaction
                .execute(
                    "INSERT INTO journal_snapshots (
                        stream_id, through_sequence, source_hash, blob_hash
                     ) VALUES (?1, ?2, ?3, ?4)",
                    params![
                        request.stream_id.to_be_bytes().as_slice(),
                        sequence_i64(stream_sequence)?,
                        hash.as_bytes().as_slice(),
                        content_hash.as_bytes().as_slice(),
                    ],
                )
                .map_err(|source| JournalError::sqlite("insert snapshot", source))?;
        }
        crash(&self.database_path, "append.after_snapshot");

        advance_head(
            &transaction,
            request.stream_id,
            actual_head,
            global_sequence,
            stream_sequence,
            hash,
        )?;
        let changed = transaction
            .execute(
                "UPDATE journal_metadata SET next_global_sequence = ?1
                 WHERE singleton = 1 AND next_global_sequence = ?2",
                params![
                    sequence_i64(global_sequence)?,
                    sequence_i64(current_global)?
                ],
            )
            .map_err(|source| JournalError::sqlite("advance global sequence", source))?;
        if changed != 1 {
            return Err(JournalError::Integrity(
                "global sequence CAS did not update exactly one row".to_owned(),
            ));
        }
        crash(&self.database_path, "append.after_head_cas");
        crash(&self.database_path, "append.before_commit");
        transaction
            .commit()
            .map_err(|source| JournalError::sqlite("commit journal append", source))?;
        crash(&self.database_path, "append.after_commit_before_ack");

        Ok(AppendReceipt {
            global_sequence,
            stream_sequence,
            event_id,
            head: Head {
                sequence: stream_sequence,
                hash,
            },
        })
    }

    pub fn head(&self, stream_id: StreamId) -> Result<Option<Head>, JournalError> {
        self.verify_file_scope()?;
        query_head(&self.connection, stream_id)
    }

    pub fn read_from(
        &self,
        stream_id: StreamId,
        after_sequence: u64,
    ) -> Result<Vec<EventEnvelope>, JournalError> {
        self.verify_file_scope()?;
        if after_sequence > i64::MAX as u64 {
            return Err(JournalError::InvalidInput(
                "read cursor exceeds SQLite sequence range",
            ));
        }
        Ok(self
            .read_stream_verified(stream_id)?
            .into_iter()
            .filter(|envelope| envelope.stream_sequence > after_sequence)
            .collect())
    }

    pub fn restore(&self, stream_id: StreamId) -> Result<RestorePlan, JournalError> {
        self.verify_file_scope()?;
        let snapshot = query_latest_snapshot(&self.connection, stream_id)?;
        let anchor = snapshot.as_ref().map(|snapshot| Head {
            sequence: snapshot.through_sequence,
            hash: snapshot.source_hash,
        });
        let events = self.read_stream_after_verified(stream_id, anchor)?;
        let head = query_head(&self.connection, stream_id)?;
        let computed_head = events
            .last()
            .map(|event| Head {
                sequence: event.stream_sequence,
                hash: event.hash,
            })
            .or(anchor);
        if computed_head != head {
            return Err(JournalError::Integrity(format!(
                "stored head {head:?} differs from stream chain {computed_head:?}"
            )));
        }
        Ok(RestorePlan {
            head,
            snapshot,
            events,
        })
    }

    /// Shadow a precise event range with a summary, in one transaction (S130).
    ///
    /// # Why this is here and not in the engine
    ///
    /// Compaction driven from TypeScript is a read, a decision, and a write
    /// with a gap in the middle. In that gap an append lands, and the summary
    /// silently describes a range that is no longer the range — or worse, the
    /// engine trims what it summarised and the only copy is gone. Here the
    /// whole thing is one SQLite transaction against the same connection that
    /// serialises appends, so there is no gap to lose an event in.
    ///
    /// # Nothing is deleted
    ///
    /// The shadowed events keep their sequences, their hashes and their place
    /// in the chain; `read_from` still returns them. A compaction is an
    /// assertion that a summary *stands in for* a range, not that the range is
    /// gone, and `journal_compactions_no_delete` makes the assertion itself
    /// permanent too. That is what keeps the shadowed span rebuildable, which
    /// is the difference between compaction and loss.
    ///
    /// # What is refused
    ///
    /// An inverted or empty range, a range that runs past the head, a range
    /// whose anchor event does not hash to what the caller read, a summary
    /// larger than a derived blob may be, and any overlap with an existing
    /// compaction. Every one of these rolls the transaction back, so a refusal
    /// leaves the journal exactly as it was — the overflow case in particular,
    /// which is the one that would otherwise leave a half-written shadow.
    pub fn compact(
        &mut self,
        request: CompactRequest<'_>,
    ) -> Result<CompactionReceipt, JournalError> {
        self.verify_file_scope()?;
        if request.from_sequence == 0 {
            return Err(JournalError::InvalidInput(
                "compaction range starts at zero",
            ));
        }
        if request.through_sequence < request.from_sequence {
            return Err(JournalError::InvalidInput("compaction range is inverted"));
        }
        if request.tokens_after > request.tokens_before {
            return Err(JournalError::InvalidInput(
                "compaction reports more tokens after than before",
            ));
        }
        // Checked before the transaction opens as well as inside it: a blob
        // that cannot be stored should not take a write lock on the way to
        // finding that out.
        validate_blob_size(request.summary)?;

        let transaction = self
            .connection
            .transaction()
            .map_err(|source| JournalError::sqlite("begin journal compaction", source))?;

        let head = query_head(&transaction, request.stream_id)?;
        let Some(head) = head else {
            return Err(JournalError::InvalidInput(
                "cannot compact a stream with no events",
            ));
        };
        if request.through_sequence > head.sequence {
            return Err(JournalError::InvalidInput(
                "compaction range runs past the stream head",
            ));
        }

        let anchor_hash = event_hash_at(&transaction, request.stream_id, request.through_sequence)?;
        let overlapping: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM journal_compactions
                 WHERE stream_id = ?1
                   AND from_sequence <= ?2
                   AND through_sequence >= ?3",
                params![
                    request.stream_id.to_be_bytes().as_slice(),
                    sequence_i64(request.through_sequence)?,
                    sequence_i64(request.from_sequence)?,
                ],
                |row| row.get(0),
            )
            .map_err(|source| JournalError::sqlite("check overlapping compactions", source))?;
        if overlapping != 0 {
            return Err(JournalError::InvalidInput(
                "compaction range overlaps an existing compaction",
            ));
        }

        let blob_hash = insert_blob(&transaction, request.summary)?;
        transaction
            .execute(
                "INSERT INTO journal_compactions (
                    stream_id, from_sequence, through_sequence, source_hash, blob_hash,
                    tokens_before, tokens_after
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    request.stream_id.to_be_bytes().as_slice(),
                    sequence_i64(request.from_sequence)?,
                    sequence_i64(request.through_sequence)?,
                    anchor_hash.as_bytes().as_slice(),
                    blob_hash.as_bytes().as_slice(),
                    sequence_i64(request.tokens_before)?,
                    sequence_i64(request.tokens_after)?,
                ],
            )
            .map_err(|source| JournalError::sqlite("insert compaction", source))?;
        transaction
            .commit()
            .map_err(|source| JournalError::sqlite("commit journal compaction", source))?;

        Ok(CompactionReceipt {
            from_sequence: request.from_sequence,
            through_sequence: request.through_sequence,
            source_hash: anchor_hash,
            blob_hash,
            tokens_before: request.tokens_before,
            tokens_after: request.tokens_after,
        })
    }

    /// Every compaction on a stream, oldest first, with its summary loaded.
    pub fn compactions(&self, stream_id: StreamId) -> Result<Vec<CompactionRecord>, JournalError> {
        self.verify_file_scope()?;
        let mut statement = self
            .connection
            .prepare(
                "SELECT from_sequence, through_sequence, source_hash, blob_hash,
                        tokens_before, tokens_after
                 FROM journal_compactions
                 WHERE stream_id = ?1
                 ORDER BY from_sequence",
            )
            .map_err(|source| JournalError::sqlite("prepare compaction read", source))?;
        let rows = statement
            .query_map(params![stream_id.to_be_bytes().as_slice()], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })
            .map_err(|source| JournalError::sqlite("read compactions", source))?;

        let mut records = Vec::new();
        for row in rows {
            let (from, through, source, blob, before, after) =
                row.map_err(|source| JournalError::sqlite("decode compaction row", source))?;
            let from_sequence = stored_sequence(from)?;
            let through_sequence = stored_sequence(through)?;
            let source_hash = parse_chain_hash(&source)?;
            let blob_hash = parse_blob_hash(&blob)?;
            // The anchor is re-verified on every read. A shadow whose range no
            // longer hashes to what it claimed is not a summary, it is a
            // corruption wearing one.
            verify_event_reference(&self.connection, stream_id, through_sequence, source_hash)?;
            records.push(CompactionRecord {
                from_sequence,
                through_sequence,
                source_hash,
                blob_hash,
                tokens_before: stored_sequence(before)?,
                tokens_after: stored_sequence(after)?,
                bytes: load_blob(&self.connection, blob_hash)?,
            });
        }
        Ok(records)
    }

    /// The stream as a reader should see it: live events, with each shadowed
    /// range replaced by its summary exactly once.
    ///
    /// The raw events are still there — `read_from` returns them — so this is a
    /// view, not a truncation, and rebuilding the shadowed span is a read away.
    pub fn read_compacted(&self, stream_id: StreamId) -> Result<Vec<CompactedEntry>, JournalError> {
        let events = self.read_stream_verified(stream_id)?;
        let compactions = self.compactions(stream_id)?;
        let mut entries = Vec::new();
        let mut index = 0usize;
        for record in compactions {
            while index < events.len() && events[index].stream_sequence < record.from_sequence {
                entries.push(CompactedEntry::Event(events[index].clone()));
                index += 1;
            }
            entries.push(CompactedEntry::Summary(record.clone()));
            while index < events.len() && events[index].stream_sequence <= record.through_sequence {
                index += 1;
            }
        }
        while index < events.len() {
            entries.push(CompactedEntry::Event(events[index].clone()));
            index += 1;
        }
        Ok(entries)
    }

    pub fn projection(
        &self,
        stream_id: StreamId,
        key: &ProjectionKey,
    ) -> Result<Option<ProjectionRecord>, JournalError> {
        self.verify_file_scope()?;
        let stored = self
            .connection
            .query_row(
                "SELECT through_sequence, source_hash, blob_hash
                 FROM journal_projections
                 WHERE stream_id = ?1 AND projection_key = ?2",
                params![stream_id.to_be_bytes().as_slice(), key.as_str()],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Vec<u8>>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|source| JournalError::sqlite("read projection", source))?;
        let Some((through_sequence, source_hash, content_hash)) = stored else {
            return Ok(None);
        };
        let through_sequence = stored_sequence(through_sequence)?;
        let source_hash = parse_chain_hash(&source_hash)?;
        let content_hash = parse_blob_hash(&content_hash)?;
        verify_event_reference(&self.connection, stream_id, through_sequence, source_hash)?;
        let bytes = load_blob(&self.connection, content_hash)?;
        Ok(Some(ProjectionRecord {
            key: key.clone(),
            through_sequence,
            source_hash,
            blob_hash: content_hash,
            bytes,
        }))
    }

    pub fn verify(&self) -> Result<IntegrityReport, JournalError> {
        self.verify_file_scope()?;
        let runtime_identity = SqliteIdentity::inspect(&self.connection)?;
        if runtime_identity != self.identity {
            return Err(JournalError::SqliteIdentity(
                "runtime SQLite identity changed after open".to_owned(),
            ));
        }
        self.verify_with_identity(&runtime_identity)
    }

    fn verify_on_open(&self) -> Result<IntegrityReport, JournalError> {
        self.verify_file_scope()?;
        self.verify_with_identity(&self.identity)
    }

    fn verify_with_identity(
        &self,
        runtime_identity: &SqliteIdentity,
    ) -> Result<IntegrityReport, JournalError> {
        verify_schema_manifest(&self.connection)?;
        verify_sqlite_integrity(&self.connection)?;
        verify_runtime_pragmas(&self.connection)?;
        verify_hardened_connection(&self.connection)?;
        verify_persisted_identity(&self.connection, runtime_identity, &self.database_path)?;
        verify_migration_history(&self.connection)?;

        let verified_events = verify_all_events_streaming(&self.connection)?;
        let stored_heads = query_all_heads(&self.connection)?;
        if stored_heads != verified_events.heads {
            return Err(JournalError::Integrity(format!(
                "stored heads {stored_heads:?} differ from computed heads {:?}",
                verified_events.heads
            )));
        }
        if query_next_global_sequence(&self.connection)? != verified_events.last_global_sequence {
            return Err(JournalError::Integrity(
                "global sequence metadata differs from the event log".to_owned(),
            ));
        }

        let blobs = query_all_blobs(&self.connection)?;
        let snapshots = verify_derived_references(&self.connection, "journal_snapshots", &blobs)?;
        let projections =
            verify_derived_references(&self.connection, "journal_projections", &blobs)?;

        Ok(IntegrityReport {
            events: verified_events.events,
            streams: verified_events.heads.len() as u64,
            blobs: blobs.len() as u64,
            snapshots,
            projections,
        })
    }

    pub fn checkpoint(&self) -> Result<CheckpointReport, JournalError> {
        self.verify_file_scope()?;
        crash(&self.database_path, "checkpoint.before");
        let (busy, log_frames, checkpointed_frames) = self
            .connection
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                Ok((
                    row.get::<_, u32>(0)?,
                    row.get::<_, u32>(1)?,
                    row.get::<_, u32>(2)?,
                ))
            })
            .map_err(|source| JournalError::sqlite("checkpoint WAL", source))?;
        crash(&self.database_path, "checkpoint.after");
        Ok(CheckpointReport {
            busy,
            log_frames,
            checkpointed_frames,
        })
    }

    /// Durably record one effect phase transition.
    ///
    /// The uniqueness of `(effect, phase)` is enforced by the schema, so a
    /// second attempt to record a phase fails as a duplicate rather than
    /// appending a second row. That is what makes a crashed-then-resumed
    /// dispatch impossible to double-count: the ledger, not the caller, refuses.
    pub fn append_effect(
        &mut self,
        request: EffectAppendRequest<'_>,
    ) -> Result<EffectAppendReceipt, JournalError> {
        self.verify_file_scope()?;
        validate_blob_size(request.payload)?;
        crash(&self.database_path, "effect.before_begin");
        let transaction = self
            .connection
            .transaction()
            .map_err(|source| JournalError::sqlite("begin effect append", source))?;
        crash(&self.database_path, "effect.after_begin");

        let tail = query_effect_tail(&transaction, request.effect_id)?;
        let previous_hash = tail.map_or(ChainHash::ZERO, |(_, hash)| hash);
        let phase_sequence = checked_next(tail.map_or(0, |(sequence, _)| sequence))?;
        let record_hash = effect_record_hash(EffectHashInput {
            effect_id: request.effect_id,
            phase_sequence,
            phase_tag: request.phase_tag,
            stream_id: request.stream_id,
            cause_event_hash: request.cause_event_hash,
            previous_hash,
            payload: request.payload,
            at_ms: request.at_ms,
        });
        let payload_hash = insert_blob(&transaction, request.payload)?;
        insert_effect_record(
            &transaction,
            &request,
            phase_sequence,
            previous_hash,
            record_hash,
            payload_hash.as_bytes().as_slice(),
        )?;
        crash(&self.database_path, "effect.after_insert");
        crash(&self.database_path, "effect.before_commit");
        transaction
            .commit()
            .map_err(|source| JournalError::sqlite("commit effect append", source))?;
        crash(&self.database_path, "effect.after_commit");
        Ok(EffectAppendReceipt {
            effect_id: request.effect_id,
            phase_sequence,
            phase_tag: request.phase_tag,
            record_hash,
        })
    }

    /// Every stored phase of one effect, oldest first, hash chain verified.
    pub fn effect_history(&self, effect_id: EffectId) -> Result<Vec<EffectRecord>, JournalError> {
        self.verify_file_scope()?;
        read_effect_history(&self.connection, effect_id)
    }

    /// Every effect the ledger knows about. This is the recovery entry point.
    pub fn effect_ids(&self) -> Result<Vec<EffectId>, JournalError> {
        self.verify_file_scope()?;
        read_effect_ids(&self.connection)
    }

    /// Issue the next lease generation for a scope.
    ///
    /// The generation comes from the stored maximum, so it is monotone across
    /// restarts by construction rather than by a counter somebody remembered to
    /// persist. Two runs of the kernel cannot hand out the same fencing token.
    pub fn issue_lease(
        &mut self,
        scope: ScopeId,
        holder: HolderId,
        issued_at_ms: u64,
        expires_at_ms: u64,
    ) -> Result<LeaseRecord, JournalError> {
        self.verify_file_scope()?;
        if expires_at_ms <= issued_at_ms {
            return Err(JournalError::InvalidInput(
                "a lease must expire after it is issued",
            ));
        }
        let transaction = self
            .connection
            .transaction()
            .map_err(|source| JournalError::sqlite("begin lease issue", source))?;
        let generation = read_current_lease(&transaction, scope)?
            .map_or(0, |lease| lease.generation)
            .checked_add(1)
            .ok_or_else(|| JournalError::Integrity("lease generation overflowed".into()))?;
        insert_lease(
            &transaction,
            scope,
            generation,
            holder,
            issued_at_ms,
            expires_at_ms,
        )?;
        transaction
            .commit()
            .map_err(|source| JournalError::sqlite("commit lease issue", source))?;
        Ok(LeaseRecord {
            scope,
            generation,
            holder,
            issued_at_ms,
            expires_at_ms,
        })
    }

    /// The lease currently in force for a scope, if any.
    pub fn current_lease(&self, scope: ScopeId) -> Result<Option<LeaseRecord>, JournalError> {
        self.verify_file_scope()?;
        read_current_lease(&self.connection, scope)
    }

    /// Declare a budget line. Setting it again does not move it.
    pub fn set_budget(
        &mut self,
        scope: ScopeId,
        dimension: u8,
        limit: u64,
    ) -> Result<(), JournalError> {
        self.verify_file_scope()?;
        if dimension == 0 || dimension > 4 {
            return Err(JournalError::InvalidInput("unknown budget dimension"));
        }
        upsert_budget(&self.connection, scope, dimension, limit)
    }

    pub fn budget(
        &self,
        scope: ScopeId,
        dimension: u8,
    ) -> Result<Option<BudgetRecord>, JournalError> {
        self.verify_file_scope()?;
        read_budget(&self.connection, scope, dimension)
    }

    /// Charge a budget, or refuse. Returns whether the charge was taken.
    pub fn charge(
        &mut self,
        scope: ScopeId,
        dimension: u8,
        amount: u64,
    ) -> Result<bool, JournalError> {
        self.verify_file_scope()?;
        charge_budget(&self.connection, scope, dimension, amount)
    }

    #[cfg(feature = "test-hooks")]
    pub(crate) fn database_path_for_test(&self) -> &Path {
        &self.database_path
    }

    #[cfg(feature = "test-hooks")]
    pub(crate) fn execute_authorization_probe(&self, sql: &str) -> Result<(), JournalError> {
        self.verify_file_scope()?;
        self.connection
            .execute_batch(sql)
            .map_err(|source| JournalError::sqlite("execute authorization probe", source))
    }

    #[cfg(feature = "test-hooks")]
    pub(crate) fn seed_fixture_batch(
        &mut self,
        stream_id: StreamId,
        start_seed: u128,
        count: u64,
        snapshot_sequence: u64,
    ) -> Result<crate::test_support::FixtureSeedReport, JournalError> {
        self.verify_file_scope()?;
        if count == 0 || snapshot_sequence == 0 || snapshot_sequence > count {
            return Err(JournalError::InvalidInput(
                "fixture count/snapshot sequence is invalid",
            ));
        }
        if self.head(stream_id)?.is_some() || self.verify()?.events != 0 {
            return Err(JournalError::InvalidInput(
                "fixture seeding requires an empty journal",
            ));
        }

        let transaction = self
            .connection
            .transaction()
            .map_err(|source| JournalError::sqlite("begin fixture batch", source))?;
        let mut head = None;
        let mut fixture_digest = [0_u8; 32];
        for offset in 0..count {
            let sequence = offset
                .checked_add(1)
                .ok_or(JournalError::SequenceExhausted)?;
            let seed = start_seed
                .checked_add(u128::from(offset))
                .ok_or(JournalError::InvalidInput("fixture seed overflow"))?;
            let event = crate::test_support::fixture_event(seed)?;
            let event_id = admission_event_id(&event);
            let frame = encode_frame(&event).map_err(JournalError::ContractEncode)?;
            let previous_hash = head.map_or(ChainHash::ZERO, |value: Head| value.hash);
            let hash = event_hash(
                stream_id,
                sequence,
                sequence,
                event_id.get(),
                previous_hash,
                &frame,
            );
            fixture_digest = crate::test_support::fold_fixture_digest(fixture_digest, hash);

            transaction
                .execute(
                    "INSERT INTO journal_events (
                        global_sequence, stream_id, stream_sequence, event_id,
                        previous_hash, event_hash, event_frame
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        sequence_i64(sequence)?,
                        stream_id.to_be_bytes().as_slice(),
                        sequence_i64(sequence)?,
                        event_id.get().to_be_bytes().as_slice(),
                        previous_hash.as_bytes().as_slice(),
                        hash.as_bytes().as_slice(),
                        frame,
                    ],
                )
                .map_err(|source| JournalError::sqlite("insert fixture event", source))?;

            if sequence == snapshot_sequence {
                let content_hash = insert_blob(&transaction, &fixture_digest)?;
                transaction
                    .execute(
                        "INSERT INTO journal_snapshots (
                            stream_id, through_sequence, source_hash, blob_hash
                         ) VALUES (?1, ?2, ?3, ?4)",
                        params![
                            stream_id.to_be_bytes().as_slice(),
                            sequence_i64(sequence)?,
                            hash.as_bytes().as_slice(),
                            content_hash.as_bytes().as_slice(),
                        ],
                    )
                    .map_err(|source| JournalError::sqlite("insert fixture snapshot", source))?;
            }

            advance_head(&transaction, stream_id, head, sequence, sequence, hash)?;
            let current_global = sequence
                .checked_sub(1)
                .ok_or(JournalError::SequenceExhausted)?;
            let changed = transaction
                .execute(
                    "UPDATE journal_metadata SET next_global_sequence = ?1
                     WHERE singleton = 1 AND next_global_sequence = ?2",
                    params![sequence_i64(sequence)?, sequence_i64(current_global)?],
                )
                .map_err(|source| {
                    JournalError::sqlite("advance fixture global sequence", source)
                })?;
            if changed != 1 {
                return Err(JournalError::Integrity(
                    "fixture global-sequence CAS did not change one row".to_owned(),
                ));
            }
            head = Some(Head { sequence, hash });
        }
        transaction
            .commit()
            .map_err(|source| JournalError::sqlite("commit fixture batch", source))?;
        Ok(crate::test_support::FixtureSeedReport {
            events: count,
            snapshot_sequence,
            head: head.ok_or(JournalError::SequenceExhausted)?,
            fixture_digest,
        })
    }

    fn read_stream_verified(
        &self,
        stream_id: StreamId,
    ) -> Result<Vec<EventEnvelope>, JournalError> {
        let rows = query_event_rows(
            &self.connection,
            "SELECT global_sequence, stream_id, stream_sequence, event_id,
                    previous_hash, event_hash, event_frame
             FROM journal_events WHERE stream_id = ?1 ORDER BY stream_sequence",
            [stream_id.to_be_bytes().as_slice()],
        )?;
        verify_event_rows(rows, false, None)
    }

    fn read_stream_after_verified(
        &self,
        stream_id: StreamId,
        anchor: Option<Head>,
    ) -> Result<Vec<EventEnvelope>, JournalError> {
        let after_sequence = anchor.map_or(0, |head| head.sequence);
        let rows = query_event_rows(
            &self.connection,
            "SELECT global_sequence, stream_id, stream_sequence, event_id,
                    previous_hash, event_hash, event_frame
             FROM journal_events
             WHERE stream_id = ?1 AND stream_sequence > ?2
             ORDER BY stream_sequence",
            params![
                stream_id.to_be_bytes().as_slice(),
                sequence_i64(after_sequence)?
            ],
        )?;
        let events = verify_event_rows(rows, false, anchor.map(|head| (stream_id, head)))?;
        if events.iter().any(|event| event.stream_id != stream_id) {
            return Err(JournalError::Integrity(
                "stream-tail query returned an event from another stream".to_owned(),
            ));
        }
        Ok(events)
    }

    fn verify_file_scope(&self) -> Result<(), JournalError> {
        let current = FileScopeIdentity::capture(&self.database_path)?;
        if current != self.file_scope {
            return Err(JournalError::Integrity(
                "journal database path or platform file identity changed after open".to_owned(),
            ));
        }
        verify_sidecar_scope(&self.database_path)
    }
}

impl FileScopeIdentity {
    fn capture(path: &Path) -> Result<Self, JournalError> {
        reject_existing_reparse_point(path)?;
        let canonical_path = fs::canonicalize(path).map_err(|error| {
            JournalError::Integrity(format!(
                "journal database path cannot be canonicalized: {error}"
            ))
        })?;
        if canonical_path != path {
            return Err(JournalError::Integrity(
                "journal database path changed canonical identity".to_owned(),
            ));
        }
        let metadata = fs::metadata(path).map_err(|error| {
            JournalError::Integrity(format!("journal database metadata is unavailable: {error}"))
        })?;
        if !metadata.is_file() {
            return Err(JournalError::Integrity(
                "journal database is not a regular file".to_owned(),
            ));
        }
        verify_single_link(&metadata, "journal database")?;
        Ok(Self {
            canonical_path,
            platform: platform_file_identity(&metadata, path),
        })
    }
}

impl FileRegistration {
    fn acquire(platform: &PlatformFileIdentity, wait_ms: u64) -> Result<Self, JournalError> {
        let identities = OPEN_FILE_IDENTITIES.get_or_init(|| Mutex::new(HashSet::new()));
        let mut identities = identities.lock().map_err(|_| {
            JournalError::Integrity("open-journal file-identity registry is poisoned".to_owned())
        })?;
        if !identities.insert(platform.clone()) {
            return Err(JournalError::WriterBusy { wait_ms });
        }
        Ok(Self {
            platform: platform.clone(),
        })
    }
}

impl Drop for FileRegistration {
    fn drop(&mut self) {
        let Some(identities) = OPEN_FILE_IDENTITIES.get() else {
            return;
        };
        if let Ok(mut identities) = identities.lock() {
            identities.remove(&self.platform);
        }
    }
}

fn validated_database_path(path: &Path) -> Result<PathBuf, JournalError> {
    if path.as_os_str().is_empty() || path.file_name().is_none() {
        return Err(JournalError::InvalidInput(
            "journal path must name a database file",
        ));
    }
    let parent = path.parent().ok_or(JournalError::InvalidInput(
        "journal path must have a parent directory",
    ))?;
    if !parent.is_dir() {
        return Err(JournalError::InvalidInput(
            "journal parent directory must already exist",
        ));
    }
    let canonical_parent = fs::canonicalize(parent).map_err(|_| {
        JournalError::InvalidInput("journal parent directory must be canonicalizable")
    })?;
    let file_name = path
        .file_name()
        .ok_or(JournalError::InvalidInput("journal path has no file name"))?;
    let canonical_candidate = canonical_parent.join(file_name);
    for candidate in [
        canonical_candidate.clone(),
        sidecar_path(&canonical_candidate, "-wal"),
        sidecar_path(&canonical_candidate, "-shm"),
        sidecar_path(&canonical_candidate, "-journal"),
    ] {
        reject_existing_reparse_point(&candidate)?;
    }
    if canonical_candidate.exists() {
        fs::canonicalize(&canonical_candidate).map_err(|_| {
            JournalError::InvalidInput("existing journal path cannot be canonicalized")
        })
    } else {
        Ok(canonical_candidate)
    }
}

fn ensure_database_file(path: &Path) -> Result<(), JournalError> {
    if path.exists() {
        return Ok(());
    }
    match fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
    {
        Ok(file) => file.sync_all().map_err(|error| {
            JournalError::Integrity(format!("new journal file cannot be synchronized: {error}"))
        }),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(JournalError::Integrity(format!(
            "journal database file cannot be created exclusively: {error}"
        ))),
    }
}

#[cfg(windows)]
fn open_windows_identity_handle(path: &Path) -> Result<fs::File, JournalError> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(path)
        .map_err(|error| {
            JournalError::Integrity(format!(
                "journal identity handle cannot be held without delete sharing: {error}"
            ))
        })
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = OsString::from(path.as_os_str());
    value.push(suffix);
    PathBuf::from(value)
}

fn reject_existing_reparse_point(path: &Path) -> Result<(), JournalError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(JournalError::Integrity(format!(
                "journal database or sidecar metadata is unavailable: {error}"
            )))
        }
    };
    if metadata.file_type().is_symlink() {
        return Err(JournalError::InvalidInput(
            "journal database and sidecars cannot be symbolic links",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(JournalError::InvalidInput(
                "journal database and sidecars cannot be reparse points",
            ));
        }
    }
    if metadata.is_dir() {
        return Err(JournalError::InvalidInput(
            "journal database path cannot be a directory",
        ));
    }
    Ok(())
}

fn verify_sidecar_scope(database_path: &Path) -> Result<(), JournalError> {
    for suffix in ["-wal", "-shm", "-journal"] {
        let path = sidecar_path(database_path, suffix);
        reject_existing_reparse_point(&path)?;
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(JournalError::Integrity(format!(
                    "journal sidecar metadata is unavailable: {error}"
                )))
            }
        };
        if !metadata.is_file() {
            return Err(JournalError::Integrity(format!(
                "journal sidecar {suffix} is not a regular file"
            )));
        }
        verify_single_link(&metadata, "journal sidecar")?;
        let canonical = fs::canonicalize(&path).map_err(|error| {
            JournalError::Integrity(format!("journal sidecar cannot be canonicalized: {error}"))
        })?;
        if canonical != path {
            return Err(JournalError::Integrity(format!(
                "journal sidecar {suffix} changed canonical identity"
            )));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn platform_file_identity(metadata: &fs::Metadata, _path: &Path) -> PlatformFileIdentity {
    use std::os::unix::fs::MetadataExt;
    PlatformFileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}

#[cfg(windows)]
fn platform_file_identity(metadata: &fs::Metadata, path: &Path) -> PlatformFileIdentity {
    use std::os::windows::fs::MetadataExt;
    // Stable Rust exposes creation time but not Windows file-index/link-count
    // fields. The persisted canonical-path digest rejects alternate hard-link
    // names, while this stable field detects ordinary replacement and keys the
    // same-process registry without unsafe code.
    PlatformFileIdentity {
        creation_time: metadata.creation_time(),
        canonical_path: path.to_owned(),
    }
}

#[cfg(not(any(unix, windows)))]
fn platform_file_identity(_metadata: &fs::Metadata, path: &Path) -> PlatformFileIdentity {
    PlatformFileIdentity {
        canonical_path: path.to_owned(),
    }
}

#[cfg(unix)]
fn verify_single_link(metadata: &fs::Metadata, name: &str) -> Result<(), JournalError> {
    use std::os::unix::fs::MetadataExt;
    if metadata.nlink() != 1 {
        return Err(JournalError::Integrity(format!(
            "{name} must have exactly one filesystem link"
        )));
    }
    Ok(())
}

#[cfg(not(unix))]
fn verify_single_link(_metadata: &fs::Metadata, _name: &str) -> Result<(), JournalError> {
    Ok(())
}

fn map_open_error(source: rusqlite::Error, wait_ms: u64, context: &'static str) -> JournalError {
    if matches!(
        source.sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    ) {
        JournalError::WriterBusy { wait_ms }
    } else {
        JournalError::sqlite(context, source)
    }
}

fn install_runtime_authorizer(connection: &Connection) -> Result<(), JournalError> {
    connection
        .authorizer(Some(journal_authorizer))
        .map_err(|source| JournalError::sqlite("install runtime SQL authorizer", source))
}

fn journal_authorizer(context: AuthContext<'_>) -> Authorization {
    match context.action {
        AuthAction::Attach { .. }
        | AuthAction::Detach { .. }
        | AuthAction::AlterTable { .. }
        | AuthAction::Analyze { .. }
        | AuthAction::CreateIndex { .. }
        | AuthAction::CreateTable { .. }
        | AuthAction::CreateTempIndex { .. }
        | AuthAction::CreateTempTable { .. }
        | AuthAction::CreateTempTrigger { .. }
        | AuthAction::CreateTempView { .. }
        | AuthAction::CreateTrigger { .. }
        | AuthAction::CreateView { .. }
        | AuthAction::CreateVtable { .. }
        | AuthAction::DropIndex { .. }
        | AuthAction::DropTable { .. }
        | AuthAction::DropTempIndex { .. }
        | AuthAction::DropTempTable { .. }
        | AuthAction::DropTempTrigger { .. }
        | AuthAction::DropTempView { .. }
        | AuthAction::DropTrigger { .. }
        | AuthAction::DropView { .. }
        | AuthAction::DropVtable { .. }
        | AuthAction::Reindex { .. }
        | AuthAction::Unknown { .. } => Authorization::Deny,
        AuthAction::Function { function_name }
            if function_name.eq_ignore_ascii_case("load_extension") =>
        {
            Authorization::Deny
        }
        AuthAction::Pragma {
            pragma_name,
            pragma_value,
        } if !allowed_runtime_pragma(pragma_name, pragma_value) => Authorization::Deny,
        _ => Authorization::Allow,
    }
}

fn allowed_runtime_pragma(name: &str, value: Option<&str>) -> bool {
    if name.eq_ignore_ascii_case("wal_checkpoint") {
        return value.is_some_and(|value| value.eq_ignore_ascii_case("truncate"));
    }
    value.is_none()
        && [
            "cache_size",
            "compile_options",
            "foreign_key_check",
            "foreign_keys",
            "integrity_check",
            "journal_mode",
            "locking_mode",
            "mmap_size",
            "synchronous",
            "temp_store",
            "trusted_schema",
            "user_version",
            "wal_autocheckpoint",
        ]
        .iter()
        .any(|allowed| name.eq_ignore_ascii_case(allowed))
}

fn validate_append_request(request: &AppendRequest<'_>) -> Result<(), JournalError> {
    if request
        .expected_head
        .is_some_and(|head| head.sequence > i64::MAX as u64)
    {
        return Err(JournalError::InvalidInput(
            "expected head exceeds SQLite sequence range",
        ));
    }
    if let Some(projection) = request.projection {
        if projection.expected_sequence > i64::MAX as u64 {
            return Err(JournalError::InvalidInput(
                "projection cursor exceeds SQLite sequence range",
            ));
        }
        validate_blob_size(projection.bytes)?;
    }
    if let Some(snapshot) = request.snapshot {
        validate_blob_size(snapshot.bytes)?;
    }
    Ok(())
}

fn validate_blob_size(bytes: &[u8]) -> Result<(), JournalError> {
    if bytes.len() > MAX_DERIVED_BLOB_BYTES {
        return Err(JournalError::InvalidInput(
            "derived blob exceeds the 16MiB journal limit",
        ));
    }
    Ok(())
}

fn admission_event_id(event: &AdmissionEvent) -> EventId {
    match event {
        AdmissionEvent::Received(value) => value.event_id,
        AdmissionEvent::Validated(value) => value.event_id,
        AdmissionEvent::Admitted(value) => value.event_id,
        AdmissionEvent::Refused(value) => value.event_id,
        AdmissionEvent::Expired(value) => value.event_id,
        AdmissionEvent::Cancelled(value) => value.event_id,
    }
}

fn checked_next(current: u64) -> Result<u64, JournalError> {
    if current >= i64::MAX as u64 {
        return Err(JournalError::SequenceExhausted);
    }
    current
        .checked_add(1)
        .ok_or(JournalError::SequenceExhausted)
}

fn sequence_i64(value: u64) -> Result<i64, JournalError> {
    i64::try_from(value).map_err(|_| JournalError::SequenceExhausted)
}

fn stored_sequence(value: i64) -> Result<u64, JournalError> {
    u64::try_from(value)
        .map_err(|_| JournalError::Integrity(format!("negative stored sequence {value}")))
}

fn query_next_global_sequence(connection: &Connection) -> Result<u64, JournalError> {
    let value = connection
        .query_row(
            "SELECT next_global_sequence FROM journal_metadata WHERE singleton = 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|source| JournalError::sqlite("read global sequence", source))?;
    stored_sequence(value)
}

fn query_head(connection: &Connection, stream_id: StreamId) -> Result<Option<Head>, JournalError> {
    let stored = connection
        .query_row(
            "SELECT stream_sequence, event_hash FROM journal_stream_heads WHERE stream_id = ?1",
            [stream_id.to_be_bytes().as_slice()],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?)),
        )
        .optional()
        .map_err(|source| JournalError::sqlite("read stream head", source))?;
    stored
        .map(|(sequence, hash)| {
            Ok(Head {
                sequence: stored_sequence(sequence)?,
                hash: parse_chain_hash(&hash)?,
            })
        })
        .transpose()
}

fn query_all_heads(connection: &Connection) -> Result<BTreeMap<StreamId, Head>, JournalError> {
    let mut statement = connection
        .prepare(
            "SELECT stream_id, stream_sequence, event_hash
             FROM journal_stream_heads ORDER BY stream_id",
        )
        .map_err(|source| JournalError::sqlite("prepare stream-head scan", source))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })
        .map_err(|source| JournalError::sqlite("scan stream heads", source))?;
    let mut heads = BTreeMap::new();
    for row in rows {
        let (stream, sequence, hash) =
            row.map_err(|source| JournalError::sqlite("decode stream head", source))?;
        let stream = parse_stream_id(&stream)?;
        let head = Head {
            sequence: stored_sequence(sequence)?,
            hash: parse_chain_hash(&hash)?,
        };
        if heads.insert(stream, head).is_some() {
            return Err(JournalError::Integrity(
                "duplicate stored stream head".to_owned(),
            ));
        }
    }
    Ok(heads)
}

fn query_projection_sequence(
    connection: &Connection,
    stream_id: StreamId,
    key: &ProjectionKey,
) -> Result<Option<u64>, JournalError> {
    connection
        .query_row(
            "SELECT through_sequence FROM journal_projections
             WHERE stream_id = ?1 AND projection_key = ?2",
            params![stream_id.to_be_bytes().as_slice(), key.as_str()],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|source| JournalError::sqlite("read projection CAS", source))?
        .map(stored_sequence)
        .transpose()
}

fn event_id_exists(connection: &Connection, event_id: EventId) -> Result<bool, JournalError> {
    connection
        .query_row(
            "SELECT 1 FROM journal_events WHERE event_id = ?1",
            [event_id.get().to_be_bytes().as_slice()],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(|source| JournalError::sqlite("check duplicate event", source))
}

fn advance_head(
    transaction: &Transaction<'_>,
    stream_id: StreamId,
    previous: Option<Head>,
    global_sequence: u64,
    stream_sequence: u64,
    hash: ChainHash,
) -> Result<(), JournalError> {
    let changed = if let Some(previous) = previous {
        transaction
            .execute(
                "UPDATE journal_stream_heads
                 SET stream_sequence = ?1, global_sequence = ?2, event_hash = ?3
                 WHERE stream_id = ?4 AND stream_sequence = ?5 AND event_hash = ?6",
                params![
                    sequence_i64(stream_sequence)?,
                    sequence_i64(global_sequence)?,
                    hash.as_bytes().as_slice(),
                    stream_id.to_be_bytes().as_slice(),
                    sequence_i64(previous.sequence)?,
                    previous.hash.as_bytes().as_slice(),
                ],
            )
            .map_err(|source| JournalError::sqlite("CAS stream head", source))?
    } else {
        transaction
            .execute(
                "INSERT INTO journal_stream_heads (
                    stream_id, stream_sequence, global_sequence, event_hash
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![
                    stream_id.to_be_bytes().as_slice(),
                    sequence_i64(stream_sequence)?,
                    sequence_i64(global_sequence)?,
                    hash.as_bytes().as_slice(),
                ],
            )
            .map_err(|source| JournalError::sqlite("create stream head", source))?
    };
    if changed != 1 {
        return Err(JournalError::Integrity(
            "stream-head CAS did not change exactly one row".to_owned(),
        ));
    }
    Ok(())
}

fn insert_blob(connection: &Connection, bytes: &[u8]) -> Result<BlobHash, JournalError> {
    validate_blob_size(bytes)?;
    let hash = blob_hash(bytes);
    connection
        .execute(
            "INSERT OR IGNORE INTO journal_blobs(hash, size, bytes) VALUES (?1, ?2, ?3)",
            params![hash.as_bytes().as_slice(), bytes.len() as i64, bytes],
        )
        .map_err(|source| JournalError::sqlite("insert content-addressed blob", source))?;
    let stored = load_blob(connection, hash)?;
    if stored != bytes {
        return Err(JournalError::Integrity(
            "content-addressed blob collision or corruption".to_owned(),
        ));
    }
    Ok(hash)
}

fn load_blob(connection: &Connection, hash: BlobHash) -> Result<Vec<u8>, JournalError> {
    let (size, stored_length) = connection
        .query_row(
            "SELECT size, length(bytes) FROM journal_blobs WHERE hash = ?1",
            [hash.as_bytes().as_slice()],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .map_err(|source| JournalError::sqlite("preflight content-addressed blob", source))?;
    let bounded_size = validate_stored_blob_bounds(size, stored_length)?;
    let bytes = connection
        .query_row(
            "SELECT bytes FROM journal_blobs WHERE hash = ?1",
            [hash.as_bytes().as_slice()],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .map_err(|source| JournalError::sqlite("load bounded content-addressed blob", source))?;
    if bytes.len() != bounded_size || blob_hash(&bytes) != hash {
        return Err(JournalError::Integrity(
            "content-addressed blob failed rehash".to_owned(),
        ));
    }
    Ok(bytes)
}

fn query_latest_snapshot(
    connection: &Connection,
    stream_id: StreamId,
) -> Result<Option<SnapshotRecord>, JournalError> {
    let stored = connection
        .query_row(
            "SELECT through_sequence, source_hash, blob_hash
             FROM journal_snapshots WHERE stream_id = ?1
             ORDER BY through_sequence DESC LIMIT 1",
            [stream_id.to_be_bytes().as_slice()],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|source| JournalError::sqlite("read latest snapshot", source))?;
    let Some((through_sequence, source_hash, content_hash)) = stored else {
        return Ok(None);
    };
    let through_sequence = stored_sequence(through_sequence)?;
    let source_hash = parse_chain_hash(&source_hash)?;
    let content_hash = parse_blob_hash(&content_hash)?;
    verify_event_reference(connection, stream_id, through_sequence, source_hash)?;
    let bytes = load_blob(connection, content_hash)?;
    Ok(Some(SnapshotRecord {
        through_sequence,
        source_hash,
        blob_hash: content_hash,
        bytes,
    }))
}

fn verify_event_reference(
    connection: &Connection,
    stream_id: StreamId,
    sequence: u64,
    hash: ChainHash,
) -> Result<(), JournalError> {
    let present = connection
        .query_row(
            "SELECT 1 FROM journal_events
             WHERE stream_id = ?1 AND stream_sequence = ?2 AND event_hash = ?3",
            params![
                stream_id.to_be_bytes().as_slice(),
                sequence_i64(sequence)?,
                hash.as_bytes().as_slice(),
            ],
            |_| Ok(()),
        )
        .optional()
        .map_err(|source| JournalError::sqlite("verify derived source event", source))?;
    if present.is_none() {
        return Err(JournalError::Integrity(
            "derived state points to a missing event/hash".to_owned(),
        ));
    }
    Ok(())
}

type EventRow = (i64, Vec<u8>, i64, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>);

fn query_event_rows<P>(
    connection: &Connection,
    sql: &str,
    params: P,
) -> Result<Vec<EventRow>, JournalError>
where
    P: rusqlite::Params,
{
    let mut statement = connection
        .prepare(sql)
        .map_err(|source| JournalError::sqlite("prepare event scan", source))?;
    let rows = statement
        .query_map(params, |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        })
        .map_err(|source| JournalError::sqlite("query event scan", source))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|source| JournalError::sqlite("decode event scan", source))?;
    Ok(rows)
}

#[cfg(test)]
fn read_all_events_verified(connection: &Connection) -> Result<Vec<EventEnvelope>, JournalError> {
    let rows = query_event_rows(
        connection,
        "SELECT global_sequence, stream_id, stream_sequence, event_id,
                previous_hash, event_hash, event_frame
         FROM journal_events ORDER BY global_sequence",
        [],
    )?;
    verify_event_rows(rows, true, None)
}

#[derive(Debug)]
struct StreamingEventVerification {
    events: u64,
    last_global_sequence: u64,
    heads: BTreeMap<StreamId, Head>,
}

fn verify_all_events_streaming(
    connection: &Connection,
) -> Result<StreamingEventVerification, JournalError> {
    let mut statement = connection
        .prepare(
            "SELECT global_sequence, stream_id, stream_sequence, event_id,
                    previous_hash, event_hash, event_frame
             FROM journal_events ORDER BY global_sequence",
        )
        .map_err(|source| JournalError::sqlite("prepare streaming event verification", source))?;
    let mut rows = statement
        .query([])
        .map_err(|source| JournalError::sqlite("query streaming event verification", source))?;
    let mut verification = StreamingEventVerification {
        events: 0,
        last_global_sequence: 0,
        heads: BTreeMap::new(),
    };

    while let Some(row) = rows
        .next()
        .map_err(|source| JournalError::sqlite("read streaming event row", source))?
    {
        let global_sequence = stored_sequence(
            row.get::<_, i64>(0)
                .map_err(|source| JournalError::sqlite("decode global sequence", source))?,
        )?;
        let expected_global = checked_next(verification.last_global_sequence)?;
        if global_sequence != expected_global {
            return Err(JournalError::Integrity(format!(
                "global sequence gap after {}: found {global_sequence}",
                verification.last_global_sequence
            )));
        }

        let stream_id = parse_stream_id(row_blob(row, 1, "stream id")?)?;
        let stream_sequence = stored_sequence(
            row.get::<_, i64>(2)
                .map_err(|source| JournalError::sqlite("decode stream sequence", source))?,
        )?;
        let event_id = parse_event_id(row_blob(row, 3, "event id")?)?;
        let previous_hash = parse_chain_hash(row_blob(row, 4, "previous hash")?)?;
        let hash = parse_chain_hash(row_blob(row, 5, "event hash")?)?;
        let frame = row_blob(row, 6, "event frame")?;

        let previous_head = verification.heads.get(&stream_id).copied();
        let expected_previous = previous_head.map_or(ChainHash::ZERO, |head| head.hash);
        let expected_sequence = checked_next(previous_head.map_or(0, |head| head.sequence))?;
        if previous_hash != expected_previous || stream_sequence != expected_sequence {
            return Err(JournalError::Integrity(format!(
                "stream chain discontinuity for {stream_id:?} at {stream_sequence}"
            )));
        }

        let event = decode_frame::<AdmissionEvent>(frame).map_err(JournalError::ContractDecode)?;
        if admission_event_id(&event) != event_id {
            return Err(JournalError::Integrity(
                "event id column differs from canonical event frame".to_owned(),
            ));
        }
        let computed = event_hash(
            stream_id,
            global_sequence,
            stream_sequence,
            event_id.get(),
            previous_hash,
            frame,
        );
        if computed != hash {
            return Err(JournalError::Integrity(
                "event envelope hash does not match canonical bytes".to_owned(),
            ));
        }

        verification.heads.insert(
            stream_id,
            Head {
                sequence: stream_sequence,
                hash,
            },
        );
        verification.events = verification
            .events
            .checked_add(1)
            .ok_or(JournalError::SequenceExhausted)?;
        verification.last_global_sequence = global_sequence;
    }
    Ok(verification)
}

fn row_blob<'row>(
    row: &'row rusqlite::Row<'_>,
    index: usize,
    name: &'static str,
) -> Result<&'row [u8], JournalError> {
    match row
        .get_ref(index)
        .map_err(|source| JournalError::sqlite("read borrowed event column", source))?
    {
        rusqlite::types::ValueRef::Blob(bytes) => Ok(bytes),
        _ => Err(JournalError::Integrity(format!(
            "journal event {name} column is not a BLOB"
        ))),
    }
}

fn verify_event_rows(
    rows: Vec<EventRow>,
    require_global_contiguous: bool,
    anchor: Option<(StreamId, Head)>,
) -> Result<Vec<EventEnvelope>, JournalError> {
    let mut global_previous = 0_u64;
    let mut stream_heads = HashMap::<StreamId, Head>::new();
    if let Some((stream_id, head)) = anchor {
        stream_heads.insert(stream_id, head);
    }
    let mut envelopes = Vec::with_capacity(rows.len());
    for row in rows {
        let global_sequence = stored_sequence(row.0)?;
        if require_global_contiguous && global_sequence != checked_next(global_previous)? {
            return Err(JournalError::Integrity(format!(
                "global sequence gap after {global_previous}: found {global_sequence}"
            )));
        }
        global_previous = global_sequence;
        let stream_id = parse_stream_id(&row.1)?;
        let stream_sequence = stored_sequence(row.2)?;
        let event_id = parse_event_id(&row.3)?;
        let previous_hash = parse_chain_hash(&row.4)?;
        let hash = parse_chain_hash(&row.5)?;
        let expected_previous = stream_heads
            .get(&stream_id)
            .map_or(ChainHash::ZERO, |head| head.hash);
        let expected_sequence = stream_heads
            .get(&stream_id)
            .map_or(1, |head| head.sequence.saturating_add(1));
        if previous_hash != expected_previous || stream_sequence != expected_sequence {
            return Err(JournalError::Integrity(format!(
                "stream chain discontinuity for {stream_id:?} at {stream_sequence}"
            )));
        }
        let event = decode_frame::<AdmissionEvent>(&row.6).map_err(JournalError::ContractDecode)?;
        if admission_event_id(&event) != event_id {
            return Err(JournalError::Integrity(
                "event id column differs from canonical event frame".to_owned(),
            ));
        }
        let computed = event_hash(
            stream_id,
            global_sequence,
            stream_sequence,
            event_id.get(),
            previous_hash,
            &row.6,
        );
        if computed != hash {
            return Err(JournalError::Integrity(
                "event envelope hash does not match canonical bytes".to_owned(),
            ));
        }
        stream_heads.insert(
            stream_id,
            Head {
                sequence: stream_sequence,
                hash,
            },
        );
        envelopes.push(EventEnvelope {
            global_sequence,
            stream_sequence,
            stream_id,
            event_id,
            previous_hash,
            hash,
            event,
        });
    }
    Ok(envelopes)
}

fn query_all_blobs(connection: &Connection) -> Result<HashSet<BlobHash>, JournalError> {
    let mut statement = connection
        .prepare("SELECT hash, size, length(bytes) FROM journal_blobs ORDER BY hash")
        .map_err(|source| JournalError::sqlite("prepare blob scan", source))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|source| JournalError::sqlite("scan blobs", source))?;
    let mut ordered_hashes = Vec::new();
    for row in rows {
        let (hash, size, stored_length) =
            row.map_err(|source| JournalError::sqlite("decode blob row", source))?;
        let hash = parse_blob_hash(&hash)?;
        validate_stored_blob_bounds(size, stored_length)?;
        ordered_hashes.push(hash);
    }
    drop(statement);

    let mut blobs = HashSet::with_capacity(ordered_hashes.len());
    for hash in ordered_hashes {
        load_blob(connection, hash)?;
        if !blobs.insert(hash) {
            return Err(JournalError::Integrity(
                "duplicate content-addressed blob".to_owned(),
            ));
        }
    }
    Ok(blobs)
}

fn validate_stored_blob_bounds(size: i64, stored_length: i64) -> Result<usize, JournalError> {
    let size = usize::try_from(size).map_err(|_| {
        JournalError::Integrity("immutable blob has a negative or unrepresentable size".to_owned())
    })?;
    let stored_length = usize::try_from(stored_length).map_err(|_| {
        JournalError::Integrity(
            "immutable blob has a negative or unrepresentable byte length".to_owned(),
        )
    })?;
    if size > MAX_DERIVED_BLOB_BYTES || stored_length > MAX_DERIVED_BLOB_BYTES {
        return Err(JournalError::Integrity(
            "immutable blob exceeds the 16MiB journal limit".to_owned(),
        ));
    }
    if size != stored_length {
        return Err(JournalError::Integrity(
            "immutable blob size differs from its byte length".to_owned(),
        ));
    }
    Ok(size)
}

fn verify_derived_references(
    connection: &Connection,
    table: &'static str,
    blobs: &HashSet<BlobHash>,
) -> Result<u64, JournalError> {
    let sql = format!("SELECT stream_id, through_sequence, source_hash, blob_hash FROM {table}");
    let mut statement = connection
        .prepare(&sql)
        .map_err(|source| JournalError::sqlite("prepare derived-state scan", source))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, Vec<u8>>(3)?,
            ))
        })
        .map_err(|source| JournalError::sqlite("scan derived state", source))?;
    let mut count = 0_u64;
    for row in rows {
        let (stream, sequence, source_hash, content_hash) =
            row.map_err(|source| JournalError::sqlite("decode derived state", source))?;
        let key = (parse_stream_id(&stream)?, stored_sequence(sequence)?);
        let source_hash = parse_chain_hash(&source_hash)?;
        let content_hash = parse_blob_hash(&content_hash)?;
        verify_event_reference(connection, key.0, key.1, source_hash)?;
        if !blobs.contains(&content_hash) {
            return Err(JournalError::Integrity(format!(
                "{table} row points to a missing blob"
            )));
        }
        count = count
            .checked_add(1)
            .ok_or(JournalError::SequenceExhausted)?;
    }
    Ok(count)
}

fn verify_sqlite_integrity(connection: &Connection) -> Result<(), JournalError> {
    let mut statement = connection
        .prepare("PRAGMA integrity_check")
        .map_err(|source| JournalError::sqlite("prepare SQLite integrity check", source))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|source| JournalError::sqlite("run SQLite integrity check", source))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|source| JournalError::sqlite("decode SQLite integrity check", source))?;
    if rows != ["ok"] {
        return Err(JournalError::Integrity(format!(
            "SQLite integrity_check returned {rows:?}"
        )));
    }

    let mut foreign_key_check = connection
        .prepare("PRAGMA foreign_key_check")
        .map_err(|source| JournalError::sqlite("prepare foreign-key check", source))?;
    let mut rows = foreign_key_check
        .query([])
        .map_err(|source| JournalError::sqlite("run foreign-key check", source))?;
    if rows
        .next()
        .map_err(|source| JournalError::sqlite("decode foreign-key check", source))?
        .is_some()
    {
        return Err(JournalError::Integrity(
            "SQLite foreign_key_check found a violation".to_owned(),
        ));
    }
    Ok(())
}

fn verify_runtime_pragmas(connection: &Connection) -> Result<(), JournalError> {
    for (pragma, expected) in [
        ("cache_size", -16_384_i64),
        ("foreign_keys", 1_i64),
        ("mmap_size", 0_i64),
        ("synchronous", 2_i64),
        ("temp_store", 2_i64),
        ("trusted_schema", 0_i64),
        ("wal_autocheckpoint", 0_i64),
    ] {
        let actual = connection
            .query_row(&format!("PRAGMA {pragma}"), [], |row| row.get::<_, i64>(0))
            .map_err(|source| JournalError::sqlite("verify runtime pragma", source))?;
        if actual != expected {
            return Err(JournalError::SqliteIdentity(format!(
                "PRAGMA {pragma} is {actual}, expected {expected}"
            )));
        }
    }
    for (pragma, expected) in [("journal_mode", "wal"), ("locking_mode", "exclusive")] {
        let actual = connection
            .query_row(&format!("PRAGMA {pragma}"), [], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|source| JournalError::sqlite("verify runtime mode", source))?;
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(JournalError::SqliteIdentity(format!(
                "PRAGMA {pragma} is {actual:?}, expected {expected:?}"
            )));
        }
    }
    Ok(())
}

fn parse_stream_id(bytes: &[u8]) -> Result<StreamId, JournalError> {
    StreamId::from_blob(bytes).map_err(|reason| JournalError::Integrity(reason.to_owned()))
}

fn parse_event_id(bytes: &[u8]) -> Result<EventId, JournalError> {
    let value = u128::from_be_bytes(
        bytes
            .try_into()
            .map_err(|_| JournalError::Integrity("event id is not 16 bytes".to_owned()))?,
    );
    EventId::try_from_u128(value)
        .map_err(|_| JournalError::Integrity("event id is zero".to_owned()))
}

fn parse_chain_hash(bytes: &[u8]) -> Result<ChainHash, JournalError> {
    ChainHash::from_blob(bytes).map_err(|reason| JournalError::Integrity(reason.to_owned()))
}

fn parse_blob_hash(bytes: &[u8]) -> Result<BlobHash, JournalError> {
    BlobHash::from_blob(bytes).map_err(|reason| JournalError::Integrity(reason.to_owned()))
}

fn crash(path: &Path, point: &str) {
    #[cfg(feature = "test-hooks")]
    crate::test_support::maybe_crash(path, point);

    #[cfg(not(feature = "test-hooks"))]
    let _ = (path, point);
}

/// The recorded hash of one event, by stream sequence.
fn event_hash_at(
    connection: &Connection,
    stream_id: StreamId,
    stream_sequence: u64,
) -> Result<ChainHash, JournalError> {
    let stored: Option<Vec<u8>> = connection
        .query_row(
            "SELECT event_hash FROM journal_events
             WHERE stream_id = ?1 AND stream_sequence = ?2",
            params![
                stream_id.to_be_bytes().as_slice(),
                sequence_i64(stream_sequence)?
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(|source| JournalError::sqlite("read event hash", source))?;
    let Some(bytes) = stored else {
        return Err(JournalError::InvalidInput(
            "compaction anchor names an event that does not exist",
        ));
    };
    parse_chain_hash(&bytes)
}

#[cfg(test)]
mod tests {
    use abdo_contracts::{CauseRef, CommandId, ProposalId, ReceivedEvent, RootCause};

    use super::*;

    fn insert_test_event(
        connection: &Connection,
        stream_id: StreamId,
        global_sequence: u64,
        previous: Option<Head>,
        seed: u128,
    ) -> Head {
        let stream_sequence = previous.map_or(1, |head| head.sequence + 1);
        let event_id = EventId::try_from_u128(seed + 1).unwrap();
        let event = AdmissionEvent::Received(Box::new(ReceivedEvent {
            event_id,
            proposal_id: ProposalId::try_from_u128(seed + 2).unwrap(),
            command_id: CommandId::try_from_u128(seed + 3).unwrap(),
            cause: CauseRef::Root(Box::new(RootCause)),
            at_ms: u64::try_from(seed).unwrap() + 10,
        }));
        let frame = encode_frame(&event).unwrap();
        let previous_hash = previous.map_or(ChainHash::ZERO, |head| head.hash);
        let hash = event_hash(
            stream_id,
            global_sequence,
            stream_sequence,
            event_id.get(),
            previous_hash,
            &frame,
        );
        connection
            .execute(
                "INSERT INTO journal_events (
                    global_sequence, stream_id, stream_sequence, event_id,
                    previous_hash, event_hash, event_frame
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    sequence_i64(global_sequence).unwrap(),
                    stream_id.to_be_bytes().as_slice(),
                    sequence_i64(stream_sequence).unwrap(),
                    event_id.get().to_be_bytes().as_slice(),
                    previous_hash.as_bytes().as_slice(),
                    hash.as_bytes().as_slice(),
                    frame,
                ],
            )
            .unwrap();
        Head {
            sequence: stream_sequence,
            hash,
        }
    }

    #[test]
    fn streaming_verifier_matches_owned_multistream_golden_and_rejects_tampering() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE journal_events (
                    global_sequence INTEGER PRIMARY KEY,
                    stream_id BLOB NOT NULL,
                    stream_sequence INTEGER NOT NULL,
                    event_id BLOB NOT NULL,
                    previous_hash BLOB NOT NULL,
                    event_hash BLOB NOT NULL,
                    event_frame BLOB NOT NULL
                 );",
            )
            .unwrap();
        let first_stream = StreamId::try_from_u128(11).unwrap();
        let second_stream = StreamId::try_from_u128(12).unwrap();
        let first_one = insert_test_event(&connection, first_stream, 1, None, 100);
        let second_one = insert_test_event(&connection, second_stream, 2, None, 200);
        let first_two = insert_test_event(&connection, first_stream, 3, Some(first_one), 300);
        let second_two = insert_test_event(&connection, second_stream, 4, Some(second_one), 400);

        let streaming = verify_all_events_streaming(&connection).unwrap();
        let owned = read_all_events_verified(&connection).unwrap();
        let mut owned_heads = BTreeMap::new();
        for event in &owned {
            owned_heads.insert(
                event.stream_id,
                Head {
                    sequence: event.stream_sequence,
                    hash: event.hash,
                },
            );
        }
        assert_eq!(streaming.events, owned.len() as u64);
        assert_eq!(streaming.last_global_sequence, 4);
        assert_eq!(streaming.heads, owned_heads);
        assert_eq!(streaming.heads.get(&first_stream), Some(&first_two));
        assert_eq!(streaming.heads.get(&second_stream), Some(&second_two));

        let mut tampered_frame: Vec<u8> = connection
            .query_row(
                "SELECT event_frame FROM journal_events WHERE global_sequence = 4",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let last = tampered_frame.last_mut().unwrap();
        *last ^= 1;
        connection
            .execute(
                "UPDATE journal_events SET event_frame = ?1 WHERE global_sequence = 4",
                [tampered_frame],
            )
            .unwrap();
        assert!(verify_all_events_streaming(&connection).is_err());
    }

    #[test]
    fn tail_verification_rejects_a_tampered_snapshot_anchor() {
        let stream_id = StreamId::try_from_u128(1).unwrap();
        let event_id = EventId::try_from_u128(2).unwrap();
        let event = AdmissionEvent::Received(Box::new(ReceivedEvent {
            event_id,
            proposal_id: ProposalId::try_from_u128(3).unwrap(),
            command_id: CommandId::try_from_u128(4).unwrap(),
            cause: CauseRef::Root(Box::new(RootCause)),
            at_ms: 5,
        }));
        let frame = encode_frame(&event).unwrap();
        let trusted_anchor = Head {
            sequence: 1,
            hash: ChainHash::from_bytes([7; 32]),
        };
        let tail_hash = event_hash(stream_id, 2, 2, event_id.get(), trusted_anchor.hash, &frame);
        let row: EventRow = (
            2,
            stream_id.to_be_bytes().to_vec(),
            2,
            event_id.get().to_be_bytes().to_vec(),
            trusted_anchor.hash.as_bytes().to_vec(),
            tail_hash.as_bytes().to_vec(),
            frame,
        );

        let verified =
            verify_event_rows(vec![row.clone()], false, Some((stream_id, trusted_anchor))).unwrap();
        assert_eq!(verified.len(), 1);
        assert_eq!(verified[0].hash, tail_hash);

        let tampered_anchor = Head {
            sequence: trusted_anchor.sequence,
            hash: ChainHash::from_bytes([8; 32]),
        };
        assert!(matches!(
            verify_event_rows(vec![row], false, Some((stream_id, tampered_anchor))),
            Err(JournalError::Integrity(message))
                if message.contains("stream chain discontinuity")
        ));
    }
}
