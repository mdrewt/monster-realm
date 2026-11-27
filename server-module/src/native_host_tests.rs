//! `native_host_tests` — a test-only, in-memory implementation of the
//! SpacetimeDB host syscalls that the `#[table]`-generated accessor code calls,
//! so the SHIPPED reducer-side helpers can run against REAL rows inside an
//! ordinary native `cargo test` binary.
//!
//! HOW THE PIECES FIT. `spacetimedb::ReducerContext::__dummy()` (crate 2.16.1,
//! `vendor/spacetimedb/src/lib.rs:1191`, `#[doc(hidden)] pub`) yields a context whose `db` is
//! the real `Local` accessor, built by `Local::__host()` (`lib.rs:1194`, `:1998-2008`), so
//! `ctx.db.<table>().<index>().find(..)` in a production helper compiles and runs unchanged.
//! That generated code bottoms out in the `extern "C"` host imports declared by
//! `spacetimedb-bindings-sys` (`#[link(wasm_import_module = "spacetime_10.x")]`), which the
//! native test target leaves UNDEFINED (`vendor/native-host.patch` compiles the vendored crate's
//! `native_link_stubs` module out). This module defines every one of those ELEVEN symbols ONCE
//! (a `#[no_mangle]` symbol is one-definition-per-binary) and implements SEVEN of them
//! unconditionally: the two name lookups, the index point and range scans, the row
//! iterator's advance and close, and the index-point DELETE on an index a fixture
//! registered. The other FOUR — table scan, insert, update, delete_all_by_eq — stay loudly
//! unmodelled UNLESS the test opts that one table in (`Handle::writable` /
//! `Handle::scannable`). A full-table `.iter()` is the shape this repo bans in owner-scoped
//! readers, so a predicate reaching for one on a table nobody opted in must fail here, not
//! pass. Tests seed rows through [`Fixture::table`] / [`Fixture::table_keyed`] — never the
//! db handle.
//!
//! PROCEDURES run here too: [`Fixture::run_procedure`] hands a real `ProcedureContext` to a
//! test, with transactions that commit or roll back and every HTTP answer stubbed by the test
//! (the PROCEDURES banner below).
//!
//! that actually keeps this module out of the published wasm is the compiler:
//! any non-test reference to it fails the publish build with E0433.
//!
//! ISOLATION. `cargo nextest` (what every `just` gate runs) gives each test its
//! own process, so CI never exercises the lock below; plain `cargo test` shares
//! one process across threads, and that is what the lock is for. [`fixture`]
//! holds a process-wide serialisation lock for the test's lifetime and resets
//! the row store, while table/index ids are minted on first lookup and NEVER reset —
//! the generated `table_id()` / `index_id()` memoise their first answer in a
//! per-type `OnceLock` for the life of the process, so a later test in the
//! same process must be handed the same id for the same name.

use spacetimedb::sats::bsatn;
use spacetimedb::sys::Errno;
use spacetimedb::{DeserializeOwned, Identity, ReducerContext, Serialize};
use std::collections::{HashMap, VecDeque};
use std::marker::PhantomData;
use std::sync::{Mutex, MutexGuard, OnceLock};

/// BSATN bytes of an indexed column value, computed from a row by that index's
/// registered [`Extract`]. BSATN is canonical: byte equality IS value equality.
type Key = Vec<u8>;
type Extract = Box<dyn Fn(&[u8]) -> Key + Send>;
/// BSATN bytes of one whole row, exactly as the generated insert path encodes
/// it (`bsatn::to_vec` is the same encoder `IterBuf::serialize_into` uses).
type Row = Vec<u8>;

#[derive(Default)]
struct Host {
    /// Table name (the `accessor`) -> id. Never reset (see module doc).
    table_ids: HashMap<String, u32>,
    /// Canonical index name (`{table}_{col}_idx_btree`, or `{table}_{col_a}_{col_b}_idx_btree`
    /// for a two-column index) -> id. Never reset.
    index_ids: HashMap<String, u32>,
    /// index id -> its [`IndexModel`] (table id, key and column models), bound only
    /// for indexes THIS fixture registered — reset by every [`fixture`] because it
    /// now decides whether a WRITE aborts (D5). An index no test registered has
    /// NO table behind it: READS over it yield no rows — what lets
    /// `account_has_game_data` visit six tables while a test registers one.
    index_table: HashMap<u32, IndexModel>,
    /// table id -> live rows (keys are derived per index), reset by every [`fixture`].
    rows: HashMap<u32, Vec<Row>>,
    /// Open row iterators: rows not yet handed to the caller.
    iters: HashMap<u32, VecDeque<Row>>,
    /// Every index name the generated code asked for since the last reset —
    /// surfaced by [`Fixture::requested_indexes`] so a mis-spelled registration
    /// prints the real name instead of a bare `false`. Note the memoisation
    /// caveat in the module doc: a name is asked for once per PROCESS.
    requested_indexes: Vec<String>,
    /// bt-14: WRITE syscalls (insert / update / delete, including no-op ones) per table id since
    /// the last [`fixture`] or [`Fixture::reset_writes`] — the subscription-visible footprint of a
    /// transaction, which a row diff cannot see (an unchanged `update` still reaches subscribers).
    writes: HashMap<u32, u32>,
    /// Rows the read syscalls HANDED OUT per table id since the last [`fixture`] or
    /// [`Fixture::reset_reads`] (see [`Fixture::rows_read`]).
    reads: HashMap<u32, u32>,
    /// Opt-in write/scan model + module identity (EOF extension); reset per fixture.
    model: Model,
    next_table_id: u32,
    next_index_id: u32,
    next_iter_id: u32,
}

impl Host {
    fn table_id(&mut self, name: &str) -> u32 {
        if let Some(&id) = self.table_ids.get(name) {
            return id;
        }
        self.next_table_id += 1;
        let id = self.next_table_id;
        self.table_ids.insert(name.to_string(), id);
        id
    }

    fn index_id(&mut self, name: &str) -> u32 {
        if let Some(&id) = self.index_ids.get(name) {
            return id;
        }
        self.next_index_id += 1;
        let id = self.next_index_id;
        self.index_ids.insert(name.to_string(), id);
        id
    }

    /// Opens an iterator over `rows`. Ids start at 1: `RowIter(0)` is the
    /// bindings' `INVALID` sentinel and must never be handed out.
    fn open_iter(&mut self, rows: Vec<Row>) -> u32 {
        self.next_iter_id += 1;
        let id = self.next_iter_id;
        self.iters.insert(id, rows.into());
        id
    }

    fn rows_of(&self, table_id: u32) -> &[Row] {
        self.rows.get(&table_id).map_or(&[], Vec::as_slice)
    }

    /// [`Host::open_iter`] over rows read from `table_id`, counted as handed out — when the
    /// iterator OPENS, so a caller that stops early still counts every row the scan matched.
    fn open_read(&mut self, table_id: u32, rows: Vec<Row>) -> u32 {
        let n = u32::try_from(rows.len()).expect("native_host_tests: a read count fits a u32");
        *self.reads.entry(table_id).or_insert(0) += n;
        self.open_iter(rows)
    }
}

static HOST: OnceLock<Mutex<Host>> = OnceLock::new();
/// Held by a [`Fixture`] for a test's whole lifetime (plain `cargo test`
/// shares one process across threads; nextest does not).
static FIXTURE_LOCK: Mutex<()> = Mutex::new(());

/// The host store, locked briefly inside each syscall and each handle method.
/// A poisoned lock (a test panicked mid-syscall) is recovered rather than
/// propagated, so one failing test cannot cascade into every later one.
fn host() -> MutexGuard<'static, Host> {
    HOST.get_or_init(|| Mutex::new(Host::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// BSATN bytes of one index key, whatever the indexed column's type (an
/// `Identity`, a `u64` auto-inc key, ...): byte equality on canonical BSATN is
/// value equality for every one of them.
fn key_bytes<K: Serialize>(key: &K) -> Key {
    bsatn::to_vec(key).expect("native_host_tests: an index key always BSATN-encodes")
}

/// One test's exclusive view of the in-memory host: rows are empty on
/// construction and the process-wide serialisation lock is held until drop.
pub(crate) struct Fixture {
    _serial: MutexGuard<'static, ()>,
}

/// Acquire the host for one test: serialise against every other fixture user,
/// then wipe rows, open iterators, index registrations and the log (ids survive).
pub(crate) fn fixture() -> Fixture {
    let serial = FIXTURE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    {
        let mut h = host();
        h.rows.clear();
        h.iters.clear();
        h.index_table.clear();
        h.requested_indexes.clear();
        h.writes.clear();
        h.reads.clear();
        h.model = Model::default();
    }
    Fixture { _serial: serial }
}

impl Fixture {
    /// A real `ReducerContext` whose `db` is the real `Local` accessor type.
    pub(crate) fn ctx(&self) -> ReducerContext {
        ReducerContext::__dummy()
    }

    /// Register `table` (its `accessor` name) with the single-column index on
    /// `column`, whose key is the `Identity` `owner_of` extracts from a row.
    /// The canonical index name `{table}_{column}_idx_btree` is derived HERE,
    /// never passed in: a hand-supplied name could bind another table's index
    /// to this table's rows and let a predicate that reads the wrong table
    /// pass. Idempotent per name. A test registers exactly
    /// the one table its predicate owns; the shim models no constraints, so a
    /// duplicate unique key seeded by mistake surfaces as the bindings' own
    /// `cannot return more than one row` assertion inside `find`.
    pub(crate) fn table<'a, R: Serialize + DeserializeOwned + 'static>(
        &'a self,
        table: &str,
        column: &str,
        owner_of: fn(&R) -> Identity,
    ) -> Handle<'a, R> {
        self.table_keyed(table, column, owner_of)
    }

    /// The same registration for an index keyed by any column type (a `u64`
    /// auto-inc key, say). Same derived-name rule and idempotence as
    /// [`Fixture::table`], its `Identity`-keyed alias. Register SEVERAL indexes of
    /// one table to read it both ways — rows are keyed per index (ST extension).
    pub(crate) fn table_keyed<'a, R, K>(
        &'a self,
        table: &str,
        column: &str,
        key_of: fn(&R) -> K,
    ) -> Handle<'a, R, K>
    where
        R: Serialize + DeserializeOwned + 'static,
        K: Serialize + DeserializeOwned + Ord + 'static,
    {
        let (table_id, index_id) = register_index(table, column, key_of);
        Handle {
            table_id,
            index_id,
            key_of,
            _rows: PhantomData,
            _fixture: PhantomData,
        }
    }

    /// The same registration for a TWO-column btree index (`index(accessor = …, btree(columns =
    /// [a, b]))`): `key_of` extracts the `(a, b)` key. The index name
    /// `{table}_{a}_{b}_idx_btree` is derived here as the table macro derives it. The full key is
    /// the BSATN of the tuple, which is its fields' BSATN concatenated — the bytes the bindings
    /// send for a point scan on both columns. A range scan may fix `a` and range `b`, or range
    /// `a` alone (see [`datastore_index_scan_range_bsatn`]).
    pub(crate) fn table_composite<'a, R, A, B>(
        &'a self,
        table: &str,
        columns: [&str; 2],
        key_of: fn(&R) -> (A, B),
    ) -> Handle<'a, R, (A, B)>
    where
        R: Serialize + DeserializeOwned + 'static,
        A: Serialize + DeserializeOwned + Ord + 'static,
        B: Serialize + DeserializeOwned + Ord + 'static,
    {
        let [first, second] = columns;
        let first_key: Extract = Box::new(move |row| key_bytes(&key_of(&decode_row::<R>(row)).0));
        let second_key: Extract = Box::new(move |row| key_bytes(&key_of(&decode_row::<R>(row)).1));
        let models = vec![
            ColumnModel {
                extract: first_key,
                cmp: cmp_keys::<A>,
            },
            ColumnModel {
                extract: second_key,
                cmp: cmp_keys::<B>,
            },
        ];
        let index = format!("{table}_{first}_{second}_idx_btree");
        let (table_id, index_id) = register_columns(table, &index, key_of, models);
        Handle {
            table_id,
            index_id,
            key_of,
            _rows: PhantomData,
            _fixture: PhantomData,
        }
    }

    /// Every index name the generated code has asked this host about since
    /// the fixture was created — the diagnostic to print when a positive
    /// assertion reads `false` (a mis-spelled registration matches nothing).
    pub(crate) fn requested_indexes(&self) -> Vec<String> {
        host().requested_indexes.clone()
    }

    /// WRITE syscalls (insert / update / delete) the generated code made against `table` (its
    /// `accessor` name) since the fixture or the last [`Fixture::reset_writes`]. Counts CALLS, so a
    /// byte-identical `update` counts — that is exactly what a subscriber would be told about.
    pub(crate) fn writes_to(&self, table: &str) -> u32 {
        let mut h = host();
        let id = h.table_id(table);
        h.writes.get(&id).copied().unwrap_or(0)
    }

    /// Zero every table's write count (mark the start of the transaction under test).
    pub(crate) fn reset_writes(&self) {
        host().writes.clear();
    }

    /// Rows the host HANDED OUT from `table` (its `accessor` name) through its read syscalls —
    /// index point scans, index range scans and table scans — since the fixture or the last
    /// [`Fixture::reset_reads`]. Counted when an iterator opens, so this is the scan's cost,
    /// not how far the caller consumed it. A read through an index no fixture registered hands
    /// out nothing and counts nothing. The read-side twin of [`Fixture::writes_to`].
    pub(crate) fn rows_read(&self, table: &str) -> u32 {
        let mut h = host();
        let id = h.table_id(table);
        h.reads.get(&id).copied().unwrap_or(0)
    }

    /// Zero every table's read count.
    pub(crate) fn reset_reads(&self) {
        host().reads.clear();
    }

    /// The procedure transactions that committed since the fixture was made: one per
    /// `with_tx` or `try_with_tx` whose body returned `Ok`, a transaction that wrote nothing
    /// included. An aborted transaction is not counted.
    pub(crate) fn procedure_commits(&self) -> u32 {
        host().model.procedure_commits
    }
}

/// A typed handle onto one registered table: seeds and removes rows without
/// going through the host's write syscalls at all. Borrows the [`Fixture`] it
/// came from, so `fixture().table(..)` — a temporary fixture whose lock would
/// drop at the end of the statement — does not compile: the serialisation
/// lock outlives every handle by construction. `K` is the indexed column's
/// type and defaults to `Identity`, so every pre-rb-47 `Handle<'_, Row>`
/// spelling still names the owner-keyed shape.
pub(crate) struct Handle<'a, R, K = Identity> {
    table_id: u32,
    index_id: u32,
    key_of: fn(&R) -> K,
    _rows: PhantomData<fn(&R)>,
    _fixture: PhantomData<&'a Fixture>,
}

impl<R: Serialize, K: Serialize> Handle<'_, R, K> {
    /// Store `row` exactly as the generated insert path would encode it.
    pub(crate) fn seed(&self, row: &R) {
        let key = key_bytes(&(self.key_of)(row));
        let bytes =
            bsatn::to_vec(row).expect("native_host_tests: a table row always BSATN-encodes");
        let mut h = host();
        let derived = (h.index_table[&self.index_id].extract)(&bytes);
        assert_eq!(derived, key, "native_host_tests: extractor != key_of");
        h.rows.entry(self.table_id).or_default().push(bytes);
    }

    /// Remove every row whose key on THIS handle's index is `key`; returns how
    /// many went, so a test can assert it actually removed something.
    pub(crate) fn remove(&self, key: K) -> usize {
        let key = key_bytes(&key);
        let mut h = host();
        let h = &mut *h;
        let extract = &h.index_table[&self.index_id].extract;
        let rows = h.rows.entry(self.table_id).or_default();
        let before = rows.len();
        rows.retain(|row| extract(row) != key);
        before - rows.len()
    }
}

// ---------------------------------------------------------------------------
// The host ABI. Signatures mirror the 2.16.1 raw externs of `vendor/spacetimedb-bindings-sys`
// with the `repr(transparent)` `TableId` / `IndexId` / `RowIter`
// newtypes spelled as the `u32` they wrap. Every one is `unsafe`: it
// dereferences raw pointers handed over by the bindings, which own the
// pointed-to memory for the duration of the call (name slices, `MaybeUninit`
// out-params, `Vec` spare capacity plus a pointer to its local length).
// ---------------------------------------------------------------------------

/// SAFETY: `ptr[..len]` is a live, initialised byte slice for the call's
/// duration (the bindings pass `name.as_ptr(), name.len()` of a `&str`).
unsafe fn name_at(ptr: *const u8, len: usize) -> String {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    String::from_utf8_lossy(bytes).into_owned()
}

/// A panic that cannot unwind: it is raised inside an `extern "C"` frame, so
/// the message prints and the whole test PROCESS aborts (nextest reports a
/// signal, not a failed assertion, and `#[should_panic]` cannot catch it).
/// That is the intended loudness — the old stubs aborted silently.
fn unmodelled(symbol: &str) -> ! {
    panic!(
        "native_host_tests: `{symbol}` is not modelled — this host serves index reads and \
         index-point deletes on registered indexes, and writes/scans only on tables a test \
         opted in (`Handle::writable` / `Handle::scannable`); seed rows with `Handle::seed`"
    )
}

#[no_mangle]
unsafe extern "C" fn table_id_from_name(name: *const u8, name_len: usize, out: *mut u32) -> u16 {
    let name = unsafe { name_at(name, name_len) };
    let id = host().table_id(&name);
    // SAFETY: `out` points at the bindings' `MaybeUninit<TableId>` out-param.
    unsafe { out.write(id) };
    0
}

#[no_mangle]
unsafe extern "C" fn index_id_from_name(
    name_ptr: *const u8,
    name_len: usize,
    out: *mut u32,
) -> u16 {
    let name = unsafe { name_at(name_ptr, name_len) };
    let mut h = host();
    let id = h.index_id(&name);
    h.requested_indexes.push(name);
    // SAFETY: `out` points at the bindings' `MaybeUninit<IndexId>` out-param.
    unsafe { out.write(id) };
    0
}

#[no_mangle]
unsafe extern "C" fn datastore_index_scan_point_bsatn(
    index_id: u32,
    point_ptr: *const u8,
    point_len: usize,
    out: *mut u32,
) -> u16 {
    // SAFETY: `point_ptr[..point_len]` is the caller's serialised key buffer,
    // live for the call's duration.
    let point = unsafe { std::slice::from_raw_parts(point_ptr, point_len) };
    let mut h = host();
    let read = h.index_table.get(&index_id).map(|ix| {
        let rows: Vec<Row> = h
            .rows_of(ix.table_id)
            .iter()
            .filter(|row| (ix.extract)(row) == point)
            .cloned()
            .collect();
        (ix.table_id, rows)
    });
    let iter = match read {
        Some((table_id, rows)) => h.open_read(table_id, rows),
        None => h.open_iter(Vec::new()),
    };
    // SAFETY: `out` points at the bindings' `MaybeUninit<RowIter>` out-param.
    unsafe { out.write(iter) };
    0
}

#[no_mangle]
unsafe extern "C" fn datastore_table_scan_bsatn(table_id: u32, out: *mut u32) -> u16 {
    unsafe { table_scan(table_id, out) }
}

/// The iterator protocol the bindings' `RowIter::read` expects: write as many
/// WHOLE rows as fit and set `*buffer_len` to the bytes written; return `0`
/// when rows remain, `-1` when this call drained the iterator (which destroys
/// it — `UniqueColumn::find` relies on the last row arriving with `-1`, since
/// it asserts exhaustion after ONE `next()`), and `BUFFER_TOO_SMALL` with
/// `*buffer_len` = the next row's size when nothing fits (the first call
/// typically arrives with whatever spare capacity the pooled buffer has).
#[no_mangle]
unsafe extern "C" fn row_iter_bsatn_advance(
    iter: u32,
    buffer_ptr: *mut u8,
    buffer_len_ptr: *mut usize,
) -> i16 {
    // SAFETY: `buffer_len_ptr` points at the caller's local `usize` holding the
    // capacity of `buffer_ptr[..]`, both live for the call's duration.
    let capacity = unsafe { buffer_len_ptr.read() };
    let mut h = host();
    let Some(pending) = h.iters.get_mut(&iter) else {
        return Errno::NO_SUCH_ITER.code() as i16;
    };
    match pending.front() {
        None => {
            // SAFETY: as above.
            unsafe { buffer_len_ptr.write(0) };
            h.iters.remove(&iter);
            return -1;
        }
        Some(next) if next.len() > capacity => {
            // SAFETY: as above.
            unsafe { buffer_len_ptr.write(next.len()) };
            return Errno::BUFFER_TOO_SMALL.code() as i16;
        }
        Some(_) => {}
    }
    let mut written = 0usize;
    while let Some(row) = pending.front() {
        if written + row.len() > capacity {
            break;
        }
        // SAFETY: `written + row.len() <= capacity`, so the destination lies
        // inside the caller's spare capacity; source and destination are
        // distinct allocations.
        unsafe { std::ptr::copy_nonoverlapping(row.as_ptr(), buffer_ptr.add(written), row.len()) };
        written += row.len();
        pending.pop_front();
    }
    let drained = pending.is_empty();
    // SAFETY: as above.
    unsafe { buffer_len_ptr.write(written) };
    if drained {
        h.iters.remove(&iter);
        -1
    } else {
        0
    }
}

#[no_mangle]
unsafe extern "C" fn row_iter_bsatn_close(iter: u32) -> u16 {
    if host().iters.remove(&iter).is_some() {
        0
    } else {
        Errno::NO_SUCH_ITER.code()
    }
}

#[no_mangle]
unsafe extern "C" fn datastore_insert_bsatn(
    table_id: u32,
    row_ptr: *mut u8,
    row_len_ptr: *mut usize,
) -> u16 {
    unsafe { write_row(table_id, None, row_ptr, row_len_ptr) }
}

#[no_mangle]
unsafe extern "C" fn datastore_update_bsatn(
    table_id: u32,
    index_id: u32,
    row_ptr: *mut u8,
    row_len_ptr: *mut usize,
) -> u16 {
    unsafe { write_row(table_id, Some(index_id), row_ptr, row_len_ptr) }
}

#[no_mangle]
unsafe extern "C" fn datastore_delete_all_by_eq_bsatn(
    table_id: u32,
    rel_ptr: *const u8,
    rel_len: usize,
    out: *mut u32,
) -> u16 {
    unsafe { delete_all_by_eq(table_id, rel_ptr, rel_len, out) }
}

/// Removes every row whose indexed key IS `point`, and reports how many went.
///
/// REAL only for an index a fixture registered; anything else aborts (D5 in the
/// banner below). That is asymmetric with the read path above on purpose, and
/// the asymmetry is the point: a read of an unregistered table must yield
/// nothing so a multi-table predicate can run, while a WRITE to one is a test
/// reaching a table it never declared — which is the abort several sibling
/// suites use as their kill mechanism.
#[no_mangle]
unsafe extern "C" fn datastore_delete_by_index_scan_point_bsatn(
    index_id: u32,
    point_ptr: *const u8,
    point_len: usize,
    out: *mut u32,
) -> u16 {
    // SAFETY: `point_ptr[..point_len]` is the caller's serialised key buffer,
    // live for the call's duration.
    let point = unsafe { std::slice::from_raw_parts(point_ptr, point_len) };
    let mut h = host();
    let h = &mut *h;
    let Some(ix) = h.index_table.get(&index_id) else {
        unmodelled("datastore_delete_by_index_scan_point_bsatn on an unregistered index")
    };
    *h.writes.entry(ix.table_id).or_insert(0) += 1;
    let rows = h.rows.entry(ix.table_id).or_default();
    let before = rows.len();
    rows.retain(|row| (ix.extract)(row) != point);
    let removed = before - rows.len();
    let removed = u32::try_from(removed).expect("native_host_tests: a delete count fits a u32");
    // SAFETY: `out` points at the bindings' `MaybeUninit<u32>` out-param, which
    // `sys::call` `assume_init`s on every `0` return — so every `0`-returning
    // path here writes it, and writes EXACTLY a `u32`
    // (`vendor/spacetimedb-bindings-sys/src/lib.rs:1357`).
    unsafe { out.write(removed) };
    0
}

// ---------------------------------------------------------------------------
// THE RANGE MODEL: what the scan below reads off the wire, what it
// decides for itself, and which of its answers is a MODEL rather than an
// observation. (the value oracles are the `rb109_` tests.)
//
// THE WIRE FORMAT. Each side of a range arrives as the BSATN of a `Bound<T>`:
// tag byte 0 `Included` followed by the BSATN of the payload, 1 `Excluded`
// followed by the payload, 2 `Unbounded` with no payload at all
// (`spacetimedb-sats-2.16.1/src/ser/impls.rs:124-128`). The bindings pack both
// sides into one buffer and hand out two slices over it
// (`vendor/spacetimedb/src/table.rs:1570-1579`), and `prefix_elems` is a
// `repr(transparent)` `ColId(pub u16)`, so the raw parameter is a `u16`
// (`spacetimedb-primitives-2.16.1/src/ids.rs:125`). The parse is an EXPLICIT tag
// match: an empty slice, an unknown tag and trailing bytes after tag 2 are each
// an ERROR, never a quiet `Unbounded`. A bound this host misreads is a window
// the caller never asked for, and every count taken over it would be true about
// the wrong rows. The tag byte is stripped BEFORE the comparator sees a payload.
//
// KEYS ARE COMPARED BY DECODED VALUE, never by their bytes. BSATN writes an i64
// little-endian in two's complement, so byte order is NOT value order: a byte
// comparator sorts every negative stamp above every positive one. The
// comparator is therefore chosen at REGISTRATION, where the key type `K` is
// still in hand, and stored beside the table id — one map, one lock, no second
// static to keep in step. `bsatn::from_slice` re-enters nothing, so calling it
// under the host lock is safe.
//
// THE SORT IS STABLE, and that is tested rather than assumed. Rows sharing a
// key keep their store order — and they DO share one in the shipped case, where
// a single request stamps every chunk of its bundle with one millisecond. An
// unstable sort would make the contents of a bounded window depend on nothing a
// reader can see.
//
// ASCENDING YIELD IS THE BTREE CONTRACT, MODELLED (residual
// R-rb-109-ORDERMODEL). Nothing in this crate has watched a live datastore hand
// rows back in key order; what the model buys is that a reader whose FAIRNESS
// rests on that order can be executed and measured here at all, against a host
// that keeps the contract deliberately and says so.
//
// D6 — A BOTH-`Unbounded` RANGE WITH NO PREFIX ABORTS. It is a sorted full scan: the
// `.iter()` shape this host refuses, wearing a range. Refusing it here keeps the wall
// SHAPE-based rather than spelling-based. With a prefix fixed, an unbounded last column
// reads that prefix's rows only, and is served.
//
// D5 — THE WRITE WALL IS ASYMMETRIC, on purpose. A READ through an index no
// fixture registered yields nothing, so a predicate that visits several tables
// still runs against the one table its test owns. A WRITE through such an index
// ABORTS. Insert, update and delete_all_by_eq abort unless the test marked that
// table `writable`; the table scan aborts unless it marked it `scannable`; the
// index-point delete aborts unless the fixture registered the index. Eleven
// symbols, seven always implemented, four behind a per-table opt-in (EOF).
// ---------------------------------------------------------------------------

/// Compares two BSATN-encoded index keys by DECODED value, returning the order
/// of the values rather than of their bytes (see the banner above).
type KeyCmp = fn(&[u8], &[u8]) -> std::cmp::Ordering;

/// The [`KeyCmp`] [`Fixture::table_keyed`] registers for its key type `K` —
/// monomorphised at the registration site, which is the last place `K` is known.
///
/// A payload that will not decode is a mis-registered host or a bound the
/// bindings never sent, not a row that happens to sort oddly, so it aborts
/// rather than defaulting to some order.
fn cmp_keys<K: DeserializeOwned + Ord>(a: &[u8], b: &[u8]) -> std::cmp::Ordering {
    let (Ok(a), Ok(b)) = (bsatn::from_slice::<K>(a), bsatn::from_slice::<K>(b)) else {
        unmodelled("datastore_index_scan_range_bsatn with an index key that will not decode")
    };
    a.cmp(&b)
}

/// One side of a range with its tag byte stripped. `Copy`, so one bound can be
/// tested against every candidate row without a reborrow.
#[derive(Clone, Copy)]
enum RangeBound<'a> {
    Included(&'a [u8]),
    Excluded(&'a [u8]),
    Unbounded,
}

/// BSATN `Bound<T>` -> [`RangeBound`], strictly: see the banner above for why
/// an empty slice is an error rather than an `Unbounded`.
fn parse_bound(bytes: &[u8]) -> RangeBound<'_> {
    match bytes {
        [0, payload @ ..] => RangeBound::Included(payload),
        [1, payload @ ..] => RangeBound::Excluded(payload),
        [2] => RangeBound::Unbounded,
        _ => unmodelled("datastore_index_scan_range_bsatn with an unreadable range bound"),
    }
}

impl RangeBound<'_> {
    /// Does `key` clear this bound as the range's LOW side?
    fn admits_low(self, key: &[u8], cmp: KeyCmp) -> bool {
        match self {
            RangeBound::Included(payload) => cmp(key, payload) != std::cmp::Ordering::Less,
            RangeBound::Excluded(payload) => cmp(key, payload) == std::cmp::Ordering::Greater,
            RangeBound::Unbounded => true,
        }
    }

    /// Does `key` clear this bound as the range's HIGH side?
    fn admits_high(self, key: &[u8], cmp: KeyCmp) -> bool {
        match self {
            RangeBound::Included(payload) => cmp(key, payload) != std::cmp::Ordering::Greater,
            RangeBound::Excluded(payload) => cmp(key, payload) == std::cmp::Ordering::Less,
            RangeBound::Unbounded => true,
        }
    }
}

/// The btree range scan. The first `prefix_elems` indexed columns are FIXED to the prefix
/// bytes (the BSATN of those column values, concatenated; canonical BSATN makes byte equality
/// value equality), and the next column must clear both bounds under ITS comparator. Matching
/// rows come back ASCENDING by the decoded FULL key, ties in store order. A single-column index
/// has prefix 0 and ranges its one column.
///
/// An index no fixture registered opens an EMPTY iterator and returns `0`,
/// exactly as the point scan above does — an unregistered table reads as empty,
/// it does not abort. A both-`Unbounded` range with no prefix aborts (D6), and so does a
/// prefix that leaves no column to range (the bindings send that as a point scan). The whole
/// call takes the host lock ONCE; the comparators run inside it and re-enter nothing.
#[no_mangle]
unsafe extern "C" fn datastore_index_scan_range_bsatn(
    index_id: u32,
    prefix_ptr: *const u8,
    prefix_len: usize,
    prefix_elems: u16,
    rstart_ptr: *const u8,
    rstart_len: usize,
    rend_ptr: *const u8,
    rend_len: usize,
    out: *mut u32,
) -> u16 {
    // SAFETY: each `ptr[..len]` is a live slice of the bindings' packed range
    // buffer, owned by the caller for the call's duration.
    let prefix = unsafe { std::slice::from_raw_parts(prefix_ptr, prefix_len) };
    let rstart = unsafe { std::slice::from_raw_parts(rstart_ptr, rstart_len) };
    let rend = unsafe { std::slice::from_raw_parts(rend_ptr, rend_len) };
    let (low, high) = (parse_bound(rstart), parse_bound(rend));
    if prefix_elems == 0 && matches!((low, high), (RangeBound::Unbounded, RangeBound::Unbounded)) {
        unmodelled("datastore_index_scan_range_bsatn over a both-unbounded range (a sorted scan)");
    }
    let mut h = host();
    let read = h.index_table.get(&index_id).map(|ix| {
        let fixed = usize::from(prefix_elems);
        let Some(ranged) = ix.columns.get(fixed) else {
            unmodelled("datastore_index_scan_range_bsatn with a prefix covering every column")
        };
        let in_prefix = |row: &[u8]| {
            let fixed_key: Vec<u8> = ix.columns[..fixed]
                .iter()
                .flat_map(|column| (column.extract)(row))
                .collect();
            fixed_key == prefix
        };
        let mut hits: Vec<(Key, &Row)> = h
            .rows_of(ix.table_id)
            .iter()
            .filter(|row| in_prefix(row))
            .filter(|row| {
                let key = (ranged.extract)(row);
                low.admits_low(&key, ranged.cmp) && high.admits_high(&key, ranged.cmp)
            })
            .map(|row| ((ix.extract)(row), row))
            .collect();
        // STABLE, so equal keys keep the order `Handle::seed` stored them in.
        hits.sort_by(|a, b| (ix.cmp)(&a.0, &b.0));
        let rows: Vec<Row> = hits.into_iter().map(|(_, row)| row.clone()).collect();
        (ix.table_id, rows)
    });
    let iter = match read {
        Some((table_id, rows)) => h.open_read(table_id, rows),
        None => h.open_iter(Vec::new()),
    };
    // SAFETY: `out` points at the bindings' `MaybeUninit<RowIter>` out-param.
    unsafe { out.write(iter) };
    0
}

impl<R: Serialize, K: Serialize> Handle<'_, R, K> {
    /// Every row this table holds, in STORE order — the order [`Handle::seed`]
    /// pushed them, never a sorted view — decoded from the same BSATN the
    /// generated read path gets. The read-back half of the seeding API, so a
    /// test can compare the store against an expected SET rather than a count.
    ///
    /// THE LOCK RULE. [`host`] is a plain, NON-REENTRANT `Mutex`: a call made
    /// from inside a host syscall — from a comparator, say — would deadlock. A
    /// live `ctx.db..filter(..)` iterator holds no lock BETWEEN syscalls, so
    /// calling this between two `next()` calls does not hang; it is banned
    /// anyway, because that iterator was handed its rows when it opened and a
    /// seed or a delete underneath it leaves a reader looking at a store that
    /// has moved. COLLECT first, assert afterwards — which is what every
    /// `rb109_` test does.
    pub(crate) fn rows(&self) -> Vec<R>
    where
        R: DeserializeOwned,
    {
        host()
            .rows_of(self.table_id)
            .iter()
            .map(|row| {
                bsatn::from_slice::<R>(row).expect("native_host_tests: a stored row decodes")
            })
            .collect()
    }
}

impl Fixture {
    /// How many host row iterators are open RIGHT NOW.
    ///
    /// The observable half of the iterator lifecycle: a scan the caller
    /// abandoned mid-way must come back through the close syscall, and a leak
    /// is a real datastore resource a scheduled job would strand on every run.
    /// Zero between tests is guaranteed by [`fixture`]; zero after a tick is
    /// not, and that is what a test asserts.
    ///
    /// The ONE fixture call a test may make while a scan is live: it reads the
    /// iterator count, not the store, so it can neither deadlock (no syscall is
    /// in flight between two `next()` calls) nor watch a store move under a
    /// reader — which is how the rb109_ iterator test proves this fixture can
    /// see an OPEN iterator, not only an absent one.
    pub(crate) fn open_iters(&self) -> usize {
        host().iters.len()
    }
}

// ---------------------------------------------------------------------------
// ST-native_host_tests — THE SUCCESS-PATH EXTENSION (debloat Phase 2).
//
// What it adds, and the one rule that keeps every older test's meaning intact:
//
// * PER-INDEX KEYS. Rows are stored once per table; each registered index keeps
//   a type-erased extractor (decode the row, apply its `key_of`, BSATN the key),
//   so a table can be read through several indexes in one test.
// * OPT-IN WRITES AND SCANS. `Handle::writable()` lets the generated insert /
//   update / delete_all_by_eq / clear reach THAT table; `Handle::scannable()`
//   lets `.iter()` / `.count()` reach it. A table nobody opted in keeps the old
//   wall — the same abort several suites (lifecycle_tests) use as their kill
//   mechanism. `Handle::unique()` makes this handle's index a unique constraint
//   (insert/update collisions return UNIQUE_ALREADY_EXISTS); `Handle::auto_inc`
//   models ONE u64 sequence column (0 is the trigger, as in
//   `spacetimedb::table::SequenceTrigger`; the generated value is written back
//   exactly as `table.rs` `insert`/`update` decode it). No other constraint is
//   modelled, and a reducer's transaction is not rolled back: a reducer that
//   errors after a write leaves that write in the store. A procedure's
//   transactions do roll back (the PROCEDURES banner).
// * A SETTABLE CALLER. `Fixture::run_as(_at)` runs a closure inside the SHIPPED
//   `__call_reducer__` entry point (`vendor/spacetimedb/src/rt.rs:1299`), which is
//   the only code that hands a reducer a `ReducerContext` with a chosen sender (the
//   constructor is private, `vendor/spacetimedb/src/lib.rs:1209`). A trampoline
//   reducer is registered once per process through the public `rt::register_reducer`
//   and published into `REDUCERS` by calling `__describe_module__`. The closure's panics are
//   caught inside the trampoline and re-raised in the caller's Rust frame, so
//   assertions (and `#[should_panic]`) behave normally. Under `run_as(_at)` the
//   connection id is `None`, so the context is internal and never reads a JWT;
//   `run_as_conn_at` opens a client connection and serves its JWT (see the
//   connection banner below).
// * A CONTROLLABLE CLOCK. `Fixture::ctx_at` (the dummy context with its public
//   `timestamp` set), `run_as_at`, and the `at` of `run_procedure`.
// * A MODULE IDENTITY. The `identity` syscall answers the fixture's database
//   identity (default [`DEFAULT_DATABASE_IDENTITY`], neither the all-zero
//   `WILD_IDENTITY` nor a small `[n; 32]` test identity); before this, reaching
//   `ctx.database_identity()` failed to LINK the whole test binary.
// ---------------------------------------------------------------------------

use spacetimedb::Timestamp;
use std::cell::RefCell;
use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};

/// The module identity every fixture starts with (see the banner above).
pub(crate) const DEFAULT_DATABASE_IDENTITY: [u8; 32] = [0xDB; 32];

/// One registered index: its table, its FULL key's comparator and extractor, and one
/// [`ColumnModel`] per indexed column (one for a single-column index, whose column key is
/// the full key).
struct IndexModel {
    table_id: u32,
    cmp: KeyCmp,
    extract: Extract,
    columns: Vec<ColumnModel>,
    unique: bool,
}

/// One indexed column: what a range scan compares once a prefix has fixed the columns
/// before it.
struct ColumnModel {
    extract: Extract,
    cmp: KeyCmp,
}

type SeqGet = Box<dyn Fn(&[u8]) -> u64 + Send>;
type SeqSet = Box<dyn Fn(&[u8], u64) -> Row + Send>;
type SplitRows = fn(&[u8]) -> Vec<Row>;
type RunAsBody = *mut (dyn FnMut(&ReducerContext) + 'static);

/// One u64 sequence column: read it from a row, and write a value into a row.
struct AutoInc {
    get: SeqGet,
    set: SeqSet,
    last: u64,
}

/// Per-table opt-ins. `split` decodes a BSATN `[Row]` relation into rows.
#[derive(Default)]
struct TableModel {
    writable: bool,
    scannable: bool,
    auto_inc: Option<AutoInc>,
    split: Option<SplitRows>,
}

/// Everything [`fixture`] resets besides rows, iterators and registrations.
struct Model {
    tables: HashMap<u32, TableModel>,
    database_identity: [u8; 32],
    /// The connection `run_as_conn_at` opened (LE bytes), and the JWT claims
    /// payload `get_jwt` answers for it (`None` = a JWT-less connection), read
    /// out through [`JWT_SOURCE`] from `jwt_cursor` on.
    jwt_conn: [u8; 16],
    jwt: Option<Vec<u8>>,
    jwt_cursor: usize,
    /// What a procedure's open transaction started from; `None` outside one.
    tx: Option<TxStart>,
    /// The byte sources of a procedure's HTTP answers not yet read to the end: id -> (bytes,
    /// read cursor). Ids count up from [`ANSWER_SOURCE_BASE`].
    answer_sources: HashMap<u32, (Vec<u8>, usize)>,
    answer_sources_opened: u32,
    /// The procedure transactions committed since the fixture was made.
    procedure_commits: u32,
}

/// The state a procedure's transaction puts back if it aborts: every table's rows, and the
/// write counts (a subscriber is told nothing of an aborted transaction).
struct TxStart {
    rows: HashMap<u32, Vec<Row>>,
    writes: HashMap<u32, u32>,
}

impl Default for Model {
    fn default() -> Self {
        Model {
            tables: HashMap::new(),
            database_identity: DEFAULT_DATABASE_IDENTITY,
            jwt_conn: [0; 16],
            jwt: None,
            jwt_cursor: 0,
            tx: None,
            answer_sources: HashMap::new(),
            answer_sources_opened: 0,
            procedure_commits: 0,
        }
    }
}

fn decode_row<R: DeserializeOwned>(row: &[u8]) -> R {
    bsatn::from_slice::<R>(row).expect("native_host_tests: a stored row decodes")
}

fn encode_row<R: Serialize>(row: &R) -> Row {
    bsatn::to_vec(row).expect("native_host_tests: a table row always BSATN-encodes")
}

/// Decodes the BSATN of a `&[R]` relation (what `Table::delete` sends) into rows.
fn split_rows<R: Serialize + DeserializeOwned>(relation: &[u8]) -> Vec<Row> {
    let rows: Vec<R> = bsatn::from_slice(relation).unwrap_or_else(|_| {
        unmodelled("datastore_delete_all_by_eq_bsatn with an unreadable relation")
    });
    rows.iter().map(encode_row).collect()
}

/// Registers `{table}_{column}_idx_btree` against `table`, with the comparator
/// and extractor for `K`; returns `(table id, index id)`.
fn register_index<R, K>(table: &str, column: &str, key_of: fn(&R) -> K) -> (u32, u32)
where
    R: Serialize + DeserializeOwned + 'static,
    K: Serialize + DeserializeOwned + Ord + 'static,
{
    let column_key: Extract = Box::new(move |row| key_bytes(&key_of(&decode_row::<R>(row))));
    let models = vec![ColumnModel {
        extract: column_key,
        cmp: cmp_keys::<K>,
    }];
    register_columns(
        table,
        &format!("{table}_{column}_idx_btree"),
        key_of,
        models,
    )
}

/// Binds the index named `index` to `table`, with the full-key comparator and extractor for
/// `K` and the per-column models a prefix range scan reads; returns `(table id, index id)`.
fn register_columns<R, K>(
    table: &str,
    index: &str,
    key_of: fn(&R) -> K,
    columns: Vec<ColumnModel>,
) -> (u32, u32)
where
    R: Serialize + DeserializeOwned + 'static,
    K: Serialize + DeserializeOwned + Ord + 'static,
{
    let mut h = host();
    let table_id = h.table_id(table);
    let index_id = h.index_id(index);
    let extract: Extract = Box::new(move |row| key_bytes(&key_of(&decode_row::<R>(row))));
    let model = IndexModel {
        table_id,
        cmp: cmp_keys::<K>,
        extract,
        columns,
        unique: false,
    };
    h.index_table.insert(index_id, model);
    h.model.tables.entry(table_id).or_default().split = Some(split_rows::<R>);
    (table_id, index_id)
}

impl<R: Serialize + DeserializeOwned + 'static, K: Serialize> Handle<'_, R, K> {
    /// Let the generated insert / update / delete / clear reach this table.
    pub(crate) fn writable(self) -> Self {
        host()
            .model
            .tables
            .entry(self.table_id)
            .or_default()
            .writable = true;
        self
    }

    /// Let the generated full-table `.iter()` / `.count()` reach this table.
    pub(crate) fn scannable(self) -> Self {
        host()
            .model
            .tables
            .entry(self.table_id)
            .or_default()
            .scannable = true;
        self
    }

    /// Make this handle's index a unique constraint for host-side writes
    /// (seeding through [`Handle::seed`] is never checked).
    pub(crate) fn unique(self) -> Self {
        if let Some(ix) = host().index_table.get_mut(&self.index_id) {
            ix.unique = true;
        }
        self
    }

    /// Model this table's ONE `#[auto_inc]` u64 column: `get` reads it, `set`
    /// writes it. A host-side insert of a row whose column is 0 gets the next
    /// value (1, 2, ... per table per fixture, always above any explicit value
    /// inserted earlier) and the value is written back to the caller.
    pub(crate) fn auto_inc(self, get: fn(&R) -> u64, set: fn(&mut R, u64)) -> Self {
        let model = AutoInc {
            get: Box::new(move |row| get(&decode_row::<R>(row))),
            set: Box::new(move |row, value| {
                let mut decoded = decode_row::<R>(row);
                set(&mut decoded, value);
                encode_row(&decoded)
            }),
            last: 0,
        };
        host()
            .model
            .tables
            .entry(self.table_id)
            .or_default()
            .auto_inc = Some(model);
        self
    }
}

impl Fixture {
    /// The dummy context with its (public) `timestamp` set to `at`. The sender
    /// is still the all-zero dummy identity — use [`Fixture::run_as_at`] for a
    /// chosen caller.
    pub(crate) fn ctx_at(&self, at: Timestamp) -> ReducerContext {
        let mut ctx = ReducerContext::__dummy();
        ctx.timestamp = at;
        ctx
    }

    /// Override the identity `ctx.database_identity()` answers for this fixture.
    pub(crate) fn set_database_identity(&self, id: Identity) {
        host().model.database_identity = id.to_byte_array();
    }

    /// Run `f` with a real `ReducerContext` whose sender is `sender` (timestamp
    /// = the Unix epoch). See the EOF banner for the mechanism.
    pub(crate) fn run_as<T>(&self, sender: Identity, f: impl FnOnce(&ReducerContext) -> T) -> T {
        self.run_as_at(sender, Timestamp::UNIX_EPOCH, f)
    }

    /// [`Fixture::run_as`] at a chosen (non-negative) timestamp.
    pub(crate) fn run_as_at<T>(
        &self,
        sender: Identity,
        at: Timestamp,
        f: impl FnOnce(&ReducerContext) -> T,
    ) -> T {
        self.run_as_on(sender, 0, at, f)
    }

    /// [`Fixture::run_as_at`] over a CLIENT connection: `conn` (non-zero) becomes
    /// `ctx.connection_id()`, and the runtime resolves `ctx.sender_auth()` through
    /// the `get_jwt` syscall, which answers `jwt` — the JSON claims payload the
    /// SDK hands a module (`{"iss":..,"aud":..,"sub":..}`), or `None` for a
    /// JWT-less (anonymous) connection. See the connection banner at EOF.
    pub(crate) fn run_as_conn_at<T>(
        &self,
        sender: Identity,
        conn: u128,
        jwt: Option<&str>,
        at: Timestamp,
        f: impl FnOnce(&ReducerContext) -> T,
    ) -> T {
        assert_ne!(
            conn, 0,
            "native_host_tests: a client connection id is never zero (zero means no connection)"
        );
        {
            let mut h = host();
            h.model.jwt_conn = conn.to_le_bytes();
            h.model.jwt = jwt.map(|claims| claims.as_bytes().to_vec());
            h.model.jwt_cursor = 0;
        }
        self.run_as_on(sender, conn, at, f)
    }

    /// The shared core: `conn == 0` is the internal (no-connection) context.
    fn run_as_on<T>(
        &self,
        sender: Identity,
        conn: u128,
        at: Timestamp,
        f: impl FnOnce(&ReducerContext) -> T,
    ) -> T {
        ensure_run_as_registered();
        let micros = u64::try_from(at.to_micros_since_unix_epoch())
            .expect("native_host_tests: run_as_at needs a timestamp at or after the Unix epoch");
        let mut f = Some(f);
        let mut out: Option<std::thread::Result<T>> = None;
        let mut body = |ctx: &ReducerContext| {
            let f = f
                .take()
                .expect("native_host_tests: the run_as body runs once");
            out = Some(catch_unwind(AssertUnwindSafe(|| {
                assert_eq!(
                    ctx.sender(),
                    sender,
                    "native_host_tests: run_as sender did not land"
                );
                assert_eq!(
                    ctx.timestamp, at,
                    "native_host_tests: run_as timestamp did not land"
                );
                assert_eq!(
                    ctx.connection_id().map(|c| c.to_u128()),
                    (conn != 0).then_some(conn),
                    "native_host_tests: run_as connection id did not land"
                );
                f(ctx)
            })));
        };
        let body_ref: &mut (dyn FnMut(&ReducerContext) + '_) = &mut body;
        // SAFETY: only the lifetime is erased. The pointer is taken out of the
        // slot by the trampoline during the `__call_reducer__` call below, and the
        // slot is cleared again right after the call, while `body` is still alive.
        let erased: RunAsBody =
            unsafe { std::mem::transmute(body_ref as *mut (dyn FnMut(&ReducerContext) + '_)) };
        RUN_AS_BODY.with(|slot| *slot.borrow_mut() = Some(erased));
        let [s0, s1, s2, s3] = identity_words(sender);
        // The runtime rebuilds the id from its two words as native-endian u64s
        // read back as a LITTLE-ENDIAN byte array (`rt.rs:1340-1345`).
        let c = conn.to_le_bytes();
        let conn_word = |i: usize| u64::from_ne_bytes(c[i * 8..i * 8 + 8].try_into().unwrap());
        // SAFETY: the shipped entry point; reducer 0 is the trampoline (the only
        // registered reducer), args are the INVALID (empty) source, and the error
        // sink is one `bytes_sink_write` below accepts.
        let rc = unsafe {
            __call_reducer__(
                0,
                s0,
                s1,
                s2,
                s3,
                conn_word(0),
                conn_word(1),
                micros,
                0,
                ERROR_SINK,
            )
        };
        RUN_AS_BODY.with(|slot| slot.borrow_mut().take());
        assert_eq!(
            rc, 0,
            "native_host_tests: the run_as trampoline reported failure"
        );
        match out.expect("native_host_tests: __call_reducer__ never ran the run_as body") {
            Ok(value) => value,
            Err(panic) => resume_unwind(panic),
        }
    }
}

thread_local! {
    /// The closure [`Fixture::run_as_at`] hands to the trampoline.
    static RUN_AS_BODY: RefCell<Option<RunAsBody>> =
        const { RefCell::new(None) };
}

/// An identity as the four words the runtime's entry points take: its byte array read as
/// native-endian `u64`s (`vendor/spacetimedb/src/rt.rs:1331`).
fn identity_words(id: Identity) -> [u64; 4] {
    let bytes = id.to_byte_array();
    std::array::from_fn(|i| u64::from_ne_bytes(bytes[i * 8..i * 8 + 8].try_into().unwrap()))
}

/// `BytesSink` handles this host accepts writes to (and discards).
const DESCRIBE_SINK: u32 = 0xD5C1;
const ERROR_SINK: u32 = 0xE551;

unsafe extern "C" {
    /// `vendor/spacetimedb/src/rt.rs:1246` (`#[unsafe(no_mangle)]`).
    fn __describe_module__(description: u32);
    /// `vendor/spacetimedb/src/rt.rs:1299` (`#[unsafe(no_mangle)]`).
    fn __call_reducer__(
        id: usize,
        sender_0: u64,
        sender_1: u64,
        sender_2: u64,
        sender_3: u64,
        conn_id_0: u64,
        conn_id_1: u64,
        timestamp: u64,
        args: u32,
        error: u32,
    ) -> i16;
}

/// The trampoline reducer's registration metadata (what `#[reducer]` would
/// generate). Not a module reducer: this file only exists in the test binary.
struct RunAsTrampoline;

impl spacetimedb::rt::ExplicitNames for RunAsTrampoline {}

impl spacetimedb::rt::FnInfo for RunAsTrampoline {
    type Invoke = spacetimedb::rt::ReducerFn;
    type FnKind = spacetimedb::rt::FnKindReducer;
    const NAME: &'static str = "native_host_run_as";
    const ARG_NAMES: &'static [Option<&'static str>] = &[];
    const INVOKE: Self::Invoke = run_as_trampoline;
}

/// Type witness for `register_reducer` (the zero-argument reducer shape).
fn run_as_signature(_ctx: &ReducerContext) {}

fn run_as_trampoline(ctx: &ReducerContext, _args: &[u8]) -> spacetimedb::ReducerResult {
    let body = RUN_AS_BODY
        .with(|slot| slot.borrow_mut().take())
        .expect("native_host_tests: the run_as trampoline was called without a body");
    // SAFETY: `run_as_at` keeps the pointee alive for this whole call (see there).
    unsafe { (*body)(ctx) };
    Ok(())
}

// ---------------------------------------------------------------------------
// Caller-scoped view invocation (debloat Phase 2, EV-wallet-privacy native half)
//
// A `#[view]` fn is private to the module that declares it (schema.rs), so no test
// module can call it directly — and a copy of its body would be vacuous. Instead
// the view macro's exported describer registers the SHIPPED fn with the runtime
// before `__describe_module__`, and `Fixture::call_view` runs it through the
// runtime's own `__call_view__` entry point with a chosen sender: the exact path a
// host takes to serve a subscription. The result is `ViewResultHeader::RowData`
// (tag 0) followed by the BSATN `Vec<Row>`.
// ---------------------------------------------------------------------------

unsafe extern "C" {
    /// `#[spacetimedb::view(accessor = my_wallet, public)]` in schema.rs.
    #[link_name = "__preinit__20_register_describer_my_wallet"]
    fn register_view_my_wallet();
    /// `#[spacetimedb::view(accessor = my_account, public)]` in schema.rs.
    #[link_name = "__preinit__20_register_describer_my_account"]
    fn register_view_my_account();
    /// `#[spacetimedb::view(accessor = my_conversation, public)]` in schema.rs.
    #[link_name = "__preinit__20_register_describer_my_conversation"]
    fn register_view_my_conversation();
    /// `#[spacetimedb::view(accessor = my_monster_pub, public)]` in schema.rs.
    #[link_name = "__preinit__20_register_describer_my_monster_pub"]
    fn register_view_my_monster_pub();
    /// `#[spacetimedb::view(accessor = my_battle, public)]` in schema.rs.
    #[link_name = "__preinit__20_register_describer_my_battle"]
    fn register_view_my_battle();
    /// `#[spacetimedb::view(accessor = my_pending_evolution_notices, public)]` in schema.rs.
    #[link_name = "__preinit__20_register_describer_my_pending_evolution_notices"]
    fn register_view_my_pending_evolution_notices();
    /// `#[spacetimedb::view(accessor = my_export_bundle, public)]` in privacy.rs.
    #[link_name = "__preinit__20_register_describer_my_export_bundle"]
    fn register_view_my_export_bundle();
    /// `#[spacetimedb::view(accessor = my_inventory, public)]` in schema.rs.
    #[link_name = "__preinit__20_register_describer_my_inventory"]
    fn register_view_my_inventory();
    /// `#[spacetimedb::view(accessor = my_tactical_battle, public)]` in schema.rs (bt-7).
    #[link_name = "__preinit__20_register_describer_my_tactical_battle"]
    fn register_view_my_tactical_battle();
    /// `#[spacetimedb::view(accessor = my_battle_units, public)]` in schema.rs (bt-7).
    #[link_name = "__preinit__20_register_describer_my_battle_units"]
    fn register_view_my_battle_units();
    /// `#[spacetimedb::view(accessor = my_battle_events, public)]` in schema.rs (bt-7).
    #[link_name = "__preinit__20_register_describer_my_battle_events"]
    fn register_view_my_battle_events();
    /// `#[spacetimedb::view(accessor = my_battle_clock, public)]` in schema.rs (bt-7).
    #[link_name = "__preinit__20_register_describer_my_battle_clock"]
    fn register_view_my_battle_clock();
    /// `#[spacetimedb::view(accessor = my_battle_queue, public)]` in schema.rs (bt-7).
    #[link_name = "__preinit__20_register_describer_my_battle_queue"]
    fn register_view_my_battle_queue();
    /// `#[spacetimedb::view(accessor = my_battle_deploy, public)]` in schema.rs (bt-7).
    #[link_name = "__preinit__20_register_describer_my_battle_deploy"]
    fn register_view_my_battle_deploy();
    /// `#[spacetimedb::view(accessor = my_formation, public)]` in schema.rs (bt-7).
    #[link_name = "__preinit__20_register_describer_my_formation"]
    fn register_view_my_formation();
    /// `#[spacetimedb::view(accessor = my_trade_session, public)]` in schema.rs.
    #[link_name = "__preinit__20_register_describer_my_trade_session"]
    fn register_view_my_trade_session();
    /// `#[spacetimedb::view(accessor = my_player_quest, public)]` in schema.rs (sr-3).
    #[link_name = "__preinit__20_register_describer_my_player_quest"]
    fn register_view_my_player_quest();
    /// `#[spacetimedb::view(accessor = my_world_binding, public)]` in schema.rs.
    #[link_name = "__preinit__20_register_describer_my_world_binding"]
    fn register_view_my_world_binding();
    /// `#[spacetimedb::view(accessor = my_bind_nonce, public)]` in schema.rs.
    #[link_name = "__preinit__20_register_describer_my_bind_nonce"]
    fn register_view_my_bind_nonce();
    /// `#[spacetimedb::view(accessor = my_world_account, public)]` in account_checks.rs.
    #[link_name = "__preinit__20_register_describer_my_world_account"]
    fn register_view_my_world_account();
    /// `#[spacetimedb::view(accessor = my_world_move, public)]` in account_checks.rs.
    #[link_name = "__preinit__20_register_describer_my_world_move"]
    fn register_view_my_world_move();
    // Every `#[spacetimedb::table]` describer (macro `table.rs:1421`
    // `__preinit__20_register_describer_<accessor>`), registered before the views
    // so `Fixture::module_def` carries the full generated table set — the
    // artifact `accounts_tests.rs` compares `DATA_LIFECYCLE_MANIFEST` against.
    #[link_name = "__preinit__20_register_describer_guest_claim_reaper_schedule"]
    fn register_table_guest_claim_reaper_schedule();
    #[link_name = "__preinit__20_register_describer_movement_tick_schedule"]
    fn register_table_movement_tick_schedule();
    #[link_name = "__preinit__20_register_describer_mr_heartbeat_schedule"]
    fn register_table_mr_heartbeat_schedule();
    #[link_name = "__preinit__20_register_describer_playtest_event"]
    fn register_table_playtest_event();
    #[link_name = "__preinit__20_register_describer_playtest_reaper_schedule"]
    fn register_table_playtest_reaper_schedule();
    #[link_name = "__preinit__20_register_describer_battle_summary_reaper_schedule"]
    fn register_table_battle_summary_reaper_schedule();
    #[link_name = "__preinit__20_register_describer_battle_challenge_reaper_schedule"]
    fn register_table_battle_challenge_reaper_schedule();
    #[link_name = "__preinit__20_register_describer_character"]
    fn register_table_character();
    #[link_name = "__preinit__20_register_describer_player"]
    fn register_table_player();
    #[link_name = "__preinit__20_register_describer_move_intent"]
    fn register_table_move_intent();
    #[link_name = "__preinit__20_register_describer_last_position"]
    fn register_table_last_position();
    #[link_name = "__preinit__20_register_describer_config"]
    fn register_table_config();
    #[link_name = "__preinit__20_register_describer_zone_def"]
    fn register_table_zone_def();
    #[link_name = "__preinit__20_register_describer_species_row"]
    fn register_table_species_row();
    #[link_name = "__preinit__20_register_describer_skill_row"]
    fn register_table_skill_row();
    #[link_name = "__preinit__20_register_describer_type_relation_row"]
    fn register_table_type_relation_row();
    #[link_name = "__preinit__20_register_describer_item_row"]
    fn register_table_item_row();
    #[link_name = "__preinit__20_register_describer_shop_row"]
    fn register_table_shop_row();
    #[link_name = "__preinit__20_register_describer_shop_item_row"]
    fn register_table_shop_item_row();
    #[link_name = "__preinit__20_register_describer_encounter"]
    fn register_table_encounter();
    #[link_name = "__preinit__20_register_describer_monster"]
    fn register_table_monster();
    #[link_name = "__preinit__20_register_describer_monster_pub"]
    fn register_table_monster_pub();
    #[link_name = "__preinit__20_register_describer_battle"]
    fn register_table_battle();
    #[link_name = "__preinit__20_register_describer_inventory"]
    fn register_table_inventory();
    #[link_name = "__preinit__20_register_describer_evolution_path"]
    fn register_table_evolution_path();
    #[link_name = "__preinit__20_register_describer_npc"]
    fn register_table_npc();
    #[link_name = "__preinit__20_register_describer_player_dialogue_state"]
    fn register_table_player_dialogue_state();
    #[link_name = "__preinit__20_register_describer_player_quest"]
    fn register_table_player_quest();
    #[link_name = "__preinit__20_register_describer_player_conversation"]
    fn register_table_player_conversation();
    #[link_name = "__preinit__20_register_describer_heal_location_row"]
    fn register_table_heal_location_row();
    #[link_name = "__preinit__20_register_describer_heal_cooldown"]
    fn register_table_heal_cooldown();
    #[link_name = "__preinit__20_register_describer_trade_offer"]
    fn register_table_trade_offer();
    #[link_name = "__preinit__20_register_describer_player_wallet"]
    fn register_table_player_wallet();
    #[link_name = "__preinit__20_register_describer_account"]
    fn register_table_account();
    #[link_name = "__preinit__20_register_describer_guest_claim"]
    fn register_table_guest_claim();
    #[link_name = "__preinit__20_register_describer_profile"]
    fn register_table_profile();
    #[link_name = "__preinit__20_register_describer_leaderboard_top"]
    fn register_table_leaderboard_top();
    #[link_name = "__preinit__20_register_describer_battle_challenge"]
    fn register_table_battle_challenge();
    #[link_name = "__preinit__20_register_describer_trade_offer_reaper_schedule"]
    fn register_table_trade_offer_reaper_schedule();
    #[link_name = "__preinit__20_register_describer_export_bundle"]
    fn register_table_export_bundle();
    #[link_name = "__preinit__20_register_describer_account_deletion_reaper_schedule"]
    fn register_table_account_deletion_reaper_schedule();
    #[link_name = "__preinit__20_register_describer_export_bundle_reaper_schedule"]
    fn register_table_export_bundle_reaper_schedule();
    #[link_name = "__preinit__20_register_describer_player_session"]
    fn register_table_player_session();
    #[link_name = "__preinit__20_register_describer_pending_evolution_notice"]
    fn register_table_pending_evolution_notice();
    #[link_name = "__preinit__20_register_describer_battle_tactical"]
    fn register_table_battle_tactical();
    #[link_name = "__preinit__20_register_describer_battle_unit"]
    fn register_table_battle_unit();
    #[link_name = "__preinit__20_register_describer_battle_queue"]
    fn register_table_battle_queue();
    #[link_name = "__preinit__20_register_describer_battle_deploy"]
    fn register_table_battle_deploy();
    #[link_name = "__preinit__20_register_describer_battle_clock"]
    fn register_table_battle_clock();
    #[link_name = "__preinit__20_register_describer_battle_secret"]
    fn register_table_battle_secret();
    #[link_name = "__preinit__20_register_describer_battle_wild_unit"]
    fn register_table_battle_wild_unit();
    #[link_name = "__preinit__20_register_describer_battle_event"]
    fn register_table_battle_event();
    #[link_name = "__preinit__20_register_describer_battle_summary"]
    fn register_table_battle_summary();
    #[link_name = "__preinit__20_register_describer_player_formation"]
    fn register_table_player_formation();
    #[link_name = "__preinit__20_register_describer_tactical_deadline_sched"]
    fn register_table_tactical_deadline_sched();
    #[link_name = "__preinit__20_register_describer_tactical_advance_sched"]
    fn register_table_tactical_advance_sched();
    #[link_name = "__preinit__20_register_describer_battle_gc_sched"]
    fn register_table_battle_gc_sched();
    #[link_name = "__preinit__20_register_describer_trade_session"]
    fn register_table_trade_session();
    #[link_name = "__preinit__20_register_describer_trade_session_snapshot"]
    fn register_table_trade_session_snapshot();
    #[link_name = "__preinit__20_register_describer_trade_session_reaper_schedule"]
    fn register_table_trade_session_reaper_schedule();
    #[link_name = "__preinit__20_register_describer_player_handle"]
    fn register_table_player_handle();
    #[link_name = "__preinit__20_register_describer_module_info"]
    fn register_table_module_info();
    #[link_name = "__preinit__20_register_describer_world_access"]
    fn register_table_world_access();
    #[link_name = "__preinit__20_register_describer_world_admission"]
    fn register_table_world_admission();
    #[link_name = "__preinit__20_register_describer_world_admission_attempt"]
    fn register_table_world_admission_attempt();
    #[link_name = "__preinit__20_register_describer_world_binding"]
    fn register_table_world_binding();
    #[link_name = "__preinit__20_register_describer_world_bind_nonce"]
    fn register_table_world_bind_nonce();
    #[link_name = "__preinit__20_register_describer_world_name"]
    fn register_table_world_name();
    #[link_name = "__preinit__20_register_describer_world_allowlist"]
    fn register_table_world_allowlist();
    #[link_name = "__preinit__20_register_describer_world_account"]
    fn register_table_world_account();
    #[link_name = "__preinit__20_register_describer_world_check_budget"]
    fn register_table_world_check_budget();
    #[link_name = "__preinit__20_register_describer_recheck_schedule"]
    fn register_table_recheck_schedule();
    #[link_name = "__preinit__20_register_describer_world_move"]
    fn register_table_world_move();
    #[link_name = "__preinit__20_register_describer_world_egress"]
    fn register_table_world_egress();
    #[link_name = "__preinit__20_register_describer_host_check_schedule"]
    fn register_table_host_check_schedule();
    /// `vendor/spacetimedb/src/rt.rs:1543` (`#[unsafe(no_mangle)]`).
    fn __call_view__(
        id: usize,
        sender_0: u64,
        sender_1: u64,
        sender_2: u64,
        sender_3: u64,
        args: u32,
        sink: u32,
    ) -> i16;
}

/// Every table describer, in `evals/baselines/table-schemas.json` order (the
/// order is immaterial to the module def; it is a set).
const TABLE_DESCRIBERS: [unsafe extern "C" fn(); 75] = [
    register_table_guest_claim_reaper_schedule,
    register_table_movement_tick_schedule,
    register_table_mr_heartbeat_schedule,
    register_table_playtest_event,
    register_table_playtest_reaper_schedule,
    register_table_battle_summary_reaper_schedule,
    register_table_battle_challenge_reaper_schedule,
    register_table_character,
    register_table_player,
    register_table_move_intent,
    register_table_last_position,
    register_table_config,
    register_table_zone_def,
    register_table_species_row,
    register_table_skill_row,
    register_table_type_relation_row,
    register_table_item_row,
    register_table_shop_row,
    register_table_shop_item_row,
    register_table_encounter,
    register_table_monster,
    register_table_monster_pub,
    register_table_battle,
    register_table_inventory,
    register_table_evolution_path,
    register_table_npc,
    register_table_player_dialogue_state,
    register_table_player_quest,
    register_table_player_conversation,
    register_table_heal_location_row,
    register_table_heal_cooldown,
    register_table_trade_offer,
    register_table_player_wallet,
    register_table_account,
    register_table_guest_claim,
    register_table_profile,
    register_table_leaderboard_top,
    register_table_battle_challenge,
    register_table_trade_offer_reaper_schedule,
    register_table_export_bundle,
    register_table_account_deletion_reaper_schedule,
    register_table_export_bundle_reaper_schedule,
    register_table_player_session,
    register_table_pending_evolution_notice,
    register_table_battle_tactical,
    register_table_battle_unit,
    register_table_battle_queue,
    register_table_battle_deploy,
    register_table_battle_clock,
    register_table_battle_secret,
    register_table_battle_wild_unit,
    register_table_battle_event,
    register_table_battle_summary,
    register_table_player_formation,
    register_table_tactical_deadline_sched,
    register_table_tactical_advance_sched,
    register_table_battle_gc_sched,
    register_table_trade_session,
    register_table_trade_session_snapshot,
    register_table_trade_session_reaper_schedule,
    register_table_player_handle,
    register_table_module_info,
    register_table_world_access,
    register_table_world_admission,
    register_table_world_admission_attempt,
    register_table_world_binding,
    register_table_world_bind_nonce,
    register_table_world_name,
    register_table_world_allowlist,
    register_table_world_account,
    register_table_world_check_budget,
    register_table_recheck_schedule,
    register_table_world_move,
    register_table_world_egress,
    register_table_host_check_schedule,
];

/// Registered in this order, so a view's `VIEWS` id is its index here.
const VIEW_DESCRIBERS: [unsafe extern "C" fn(); 21] = [
    register_view_my_wallet,
    register_view_my_account,
    register_view_my_conversation,
    register_view_my_monster_pub,
    register_view_my_battle,
    register_view_my_pending_evolution_notices,
    register_view_my_export_bundle,
    register_view_my_inventory,
    register_view_my_tactical_battle,
    register_view_my_battle_units,
    register_view_my_battle_events,
    register_view_my_battle_clock,
    register_view_my_battle_queue,
    register_view_my_battle_deploy,
    register_view_my_formation,
    register_view_my_trade_session,
    register_view_my_player_quest,
    register_view_my_world_binding,
    register_view_my_bind_nonce,
    register_view_my_world_account,
    register_view_my_world_move,
];

/// `VIEWS` id of `my_wallet` (its index in [`VIEW_DESCRIBERS`]).
pub(crate) const VIEW_MY_WALLET: usize = 0;

/// `VIEWS` id of `my_account` (its index in [`VIEW_DESCRIBERS`]).
pub(crate) const VIEW_MY_ACCOUNT: usize = 1;

/// `VIEWS` id of `my_conversation` (its index in [`VIEW_DESCRIBERS`]).
pub(crate) const VIEW_MY_CONVERSATION: usize = 2;

/// `VIEWS` id of `my_monster_pub` (its index in [`VIEW_DESCRIBERS`]).
pub(crate) const VIEW_MY_MONSTER_PUB: usize = 3;

/// `VIEWS` id of `my_battle` (its index in [`VIEW_DESCRIBERS`]).
pub(crate) const VIEW_MY_BATTLE: usize = 4;

/// `VIEWS` id of `my_pending_evolution_notices` (its index in [`VIEW_DESCRIBERS`]).
pub(crate) const VIEW_MY_PENDING_EVOLUTION_NOTICES: usize = 5;

/// `VIEWS` id of `my_export_bundle` (its index in [`VIEW_DESCRIBERS`]).
pub(crate) const VIEW_MY_EXPORT_BUNDLE: usize = 6;

/// `VIEWS` id of `my_inventory` (its index in [`VIEW_DESCRIBERS`]).
pub(crate) const VIEW_MY_INVENTORY: usize = 7;

/// `VIEWS` id of `my_tactical_battle` (its index in [`VIEW_DESCRIBERS`]; bt-7).
pub(crate) const VIEW_MY_TACTICAL_BATTLE: usize = 8;

/// `VIEWS` id of `my_battle_units` (bt-7).
pub(crate) const VIEW_MY_BATTLE_UNITS: usize = 9;

/// `VIEWS` id of `my_battle_events` (bt-7).
pub(crate) const VIEW_MY_BATTLE_EVENTS: usize = 10;

/// `VIEWS` id of `my_battle_clock` (bt-7).
pub(crate) const VIEW_MY_BATTLE_CLOCK: usize = 11;

/// `VIEWS` id of `my_battle_queue` (bt-7).
pub(crate) const VIEW_MY_BATTLE_QUEUE: usize = 12;

/// `VIEWS` id of `my_battle_deploy` (bt-7).
pub(crate) const VIEW_MY_BATTLE_DEPLOY: usize = 13;

/// `VIEWS` id of `my_formation` (bt-7).
pub(crate) const VIEW_MY_FORMATION: usize = 14;

/// `VIEWS` id of `my_player_quest` (its index in [`VIEW_DESCRIBERS`]; sr-3).
pub(crate) const VIEW_MY_PLAYER_QUEST: usize = 16;

/// `VIEWS` id of `my_world_binding` (its index in [`VIEW_DESCRIBERS`]).
pub(crate) const VIEW_MY_WORLD_BINDING: usize = 17;

/// `VIEWS` id of `my_bind_nonce` (its index in [`VIEW_DESCRIBERS`]).
pub(crate) const VIEW_MY_BIND_NONCE: usize = 18;

/// `VIEWS` id of `my_world_account` (its index in [`VIEW_DESCRIBERS`]).
pub(crate) const VIEW_MY_WORLD_ACCOUNT: usize = 19;

/// `VIEWS` id of `my_world_move` (its index in [`VIEW_DESCRIBERS`]).
pub(crate) const VIEW_MY_WORLD_MOVE: usize = 20;

/// The bytes `__describe_module__` wrote to [`DESCRIBE_SINK`]: the generated
/// `RawModuleDef` (V10 on 2.16.1, `vendor/spacetimedb/src/rt.rs:1251`), captured once per
/// process so a test can read table access, keys, indexes and the exact view roster from the
/// artifact the host itself consumes — never from source text.
static DESCRIBE_OUT: Mutex<Vec<u8>> = Mutex::new(Vec::new());

const VIEW_SINK: u32 = 0x71E5;

thread_local! {
    /// Bytes the runtime wrote to [`VIEW_SINK`] during one `call_view`.
    static VIEW_OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

impl Fixture {
    /// Run the shipped view registered at `view_id` as `sender` and decode its rows.
    pub(crate) fn call_view<R: DeserializeOwned>(
        &self,
        view_id: usize,
        sender: Identity,
    ) -> Vec<R> {
        ensure_run_as_registered();
        VIEW_OUT.with(|b| b.borrow_mut().clear());
        let [s0, s1, s2, s3] = identity_words(sender);
        // SAFETY: the shipped entry point; args are the INVALID (empty) source (a
        // zero-argument view), and the sink is one `bytes_sink_write` accepts.
        let rc = unsafe { __call_view__(view_id, s0, s1, s2, s3, 0, VIEW_SINK) };
        assert_eq!(
            rc, 2,
            "native_host_tests: __call_view__ must answer with the header ABI (2)"
        );
        let out = VIEW_OUT.with(|b| std::mem::take(&mut *b.borrow_mut()));
        assert_eq!(
            out.first(),
            Some(&0u8),
            "native_host_tests: expected ViewResultHeader::RowData (tag 0), got {out:?}"
        );
        bsatn::from_slice::<Vec<R>>(&out[1..])
            .expect("native_host_tests: view rows must decode as Vec<R>")
    }
}

impl Fixture {
    /// The generated module definition, decoded from the bytes the shipped
    /// `__describe_module__` wrote (a V10 def on 2.16.1; any other version is a
    /// toolchain hop this harness must be re-pointed at, so it panics by name).
    pub(crate) fn module_def(
        &self,
    ) -> spacetimedb::spacetimedb_lib::db::raw_def::v10::RawModuleDefV10 {
        ensure_run_as_registered();
        let bytes = DESCRIBE_OUT
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        match bsatn::from_slice::<spacetimedb::spacetimedb_lib::RawModuleDef>(&bytes)
            .expect("native_host_tests: the describe bytes must decode as a RawModuleDef")
        {
            spacetimedb::spacetimedb_lib::RawModuleDef::V10(def) => def,
            other => panic!("native_host_tests: expected a V10 module def, got {other:?}"),
        }
    }
}

// ---------------------------------------------------------------------------
// sr-4b: the leaderboard membership. Every transaction that writes `profile` (and
// `init` / `sync_content`) ends with a full rescan: it scans `profile`, scans
// `leaderboard_top`, deletes the members that left and inserts the ones that
// entered. A world whose test reaches one of those calls `Fixture::ladder` once.
// ---------------------------------------------------------------------------

impl Fixture {
    /// Opts the leaderboard membership into this fixture: registers `leaderboard_top` on its
    /// `identity` key (writable, scannable, unique) and makes `profile` scannable on its
    /// `identity` key (unique, as its primary key is). Registration is idempotent per index
    /// name and the opt-ins accumulate, so this composes with a world that already registered
    /// `profile` writable. Returns the `leaderboard_top` handle.
    pub(crate) fn ladder(&self) -> Handle<'_, crate::schema::LeaderboardTop> {
        let _ = self
            .table::<crate::schema::Profile>("profile", "identity", |r| r.identity)
            .scannable()
            .unique();
        self.table::<crate::schema::LeaderboardTop>("leaderboard_top", "identity", |r| r.identity)
            .writable()
            .scannable()
            .unique()
    }
}

/// The ladder tests' oracle: the identities of the first `k` of `profiles` in ladder order —
/// rating descending, then name ascending by UTF-16 code units (the client's JS `<`), then
/// identity ascending by its big-endian hex (the u256 value). Sorted here, independently of
/// `ranking::top_identities`; the raw byte array is never compared (`from_byte_array` is
/// little-endian).
pub(crate) fn ladder_oracle(profiles: &[crate::schema::Profile], k: usize) -> Vec<Identity> {
    let mut keyed: Vec<(i32, Vec<u16>, String, Identity)> = profiles
        .iter()
        .map(|p| {
            (
                p.rating,
                p.name.encode_utf16().collect(),
                p.identity.to_hex().to_string(),
                p.identity,
            )
        })
        .collect();
    keyed.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.cmp(&b.1))
            .then_with(|| a.2.cmp(&b.2))
    });
    keyed.into_iter().take(k).map(|(_, _, _, id)| id).collect()
}

/// `ids` as their hex strings, sorted: a membership compared as a multiset (a duplicate
/// member shows up as a duplicate string).
pub(crate) fn sorted_hexes(ids: impl IntoIterator<Item = Identity>) -> Vec<String> {
    let mut out: Vec<String> = ids.into_iter().map(|id| id.to_hex().to_string()).collect();
    out.sort();
    out
}

/// Registers the two trampolines and publishes `REDUCERS`, `PROCEDURES` and `VIEWS`, once per
/// process.
fn ensure_run_as_registered() {
    static READY: OnceLock<()> = OnceLock::new();
    READY.get_or_init(|| {
        spacetimedb::rt::register_reducer::<(), RunAsTrampoline>(run_as_signature);
        spacetimedb::rt::register_procedure::<(), (), ProcedureTrampoline>(procedure_signature);
        // The shipped `#[view]` describers, in `VIEWS` order (see `call_view`). Each is
        // the `pub extern "C"` symbol the view macro exports; calling it pushes the
        // SHIPPED view fn into the module's `views` list, exactly as a host's preinit
        // pass would.
        for register in TABLE_DESCRIBERS.iter().chain(VIEW_DESCRIBERS.iter()) {
            // SAFETY: a macro-generated zero-argument describer; it only appends to the
            // not-yet-described module def.
            unsafe { register() };
        }
        // SAFETY: the shipped describe entry point; the sink is one
        // `bytes_sink_write` below accepts.
        unsafe { __describe_module__(DESCRIBE_SINK) };
    });
}

/// `Table::iter` — real only for a `scannable` table (store order).
unsafe fn table_scan(table_id: u32, out: *mut u32) -> u16 {
    let mut h = host();
    if !h.model.tables.get(&table_id).is_some_and(|t| t.scannable) {
        unmodelled("datastore_table_scan_bsatn")
    }
    let rows = h.rows_of(table_id).to_vec();
    let iter = h.open_read(table_id, rows);
    // SAFETY: `out` points at the bindings' `MaybeUninit<RowIter>` out-param.
    unsafe { out.write(iter) };
    0
}

/// The shared insert (`via_index: None`) / update (`Some(index)`) path.
///
/// Update finds the row to replace by projecting the new row onto the given
/// (registered, same-table) index and replaces it IN PLACE; no match is
/// `NO_SUCH_ROW`. Both run the auto-inc model and write the generated columns
/// back into the caller's buffer (`*row_len` = their length, 0 when none).
///
/// SAFETY: `row_ptr[..*row_len_ptr]` is the caller's BSATN row buffer.
unsafe fn write_row(
    table_id: u32,
    via_index: Option<u32>,
    row_ptr: *mut u8,
    row_len_ptr: *mut usize,
) -> u16 {
    let symbol = if via_index.is_some() {
        "datastore_update_bsatn"
    } else {
        "datastore_insert_bsatn"
    };
    let len = unsafe { row_len_ptr.read() };
    let mut row = unsafe { std::slice::from_raw_parts(row_ptr, len) }.to_vec();
    let mut h = host();
    let h = &mut *h;
    *h.writes.entry(table_id).or_insert(0) += 1;
    let Some(table) = h.model.tables.get_mut(&table_id).filter(|t| t.writable) else {
        unmodelled(symbol)
    };
    let mut generated = Vec::new();
    if let Some(seq) = table.auto_inc.as_mut() {
        let current = (seq.get)(&row);
        if current == 0 {
            seq.last += 1;
            row = (seq.set)(&row, seq.last);
            generated = key_bytes(&seq.last);
        } else {
            seq.last = seq.last.max(current);
        }
    }
    let rows = h.rows.entry(table_id).or_default();
    let replace = match via_index {
        None => None,
        Some(index_id) => {
            let Some(ix) = h
                .index_table
                .get(&index_id)
                .filter(|ix| ix.table_id == table_id)
            else {
                unmodelled("datastore_update_bsatn through an index not registered on its table")
            };
            let key = (ix.extract)(&row);
            match rows.iter().position(|old| (ix.extract)(old) == key) {
                Some(pos) => Some(pos),
                None => return Errno::NO_SUCH_ROW.code(),
            }
        }
    };
    if replace.is_none() && rows.contains(&row) {
        // Set semantics: an exact duplicate insert is a no-op.
        unsafe { row_len_ptr.write(0) };
        return 0;
    }
    for ix in h
        .index_table
        .values()
        .filter(|ix| ix.unique && ix.table_id == table_id)
    {
        let key = (ix.extract)(&row);
        let clash = rows
            .iter()
            .enumerate()
            .any(|(i, old)| Some(i) != replace && (ix.extract)(old) == key);
        if clash {
            return Errno::UNIQUE_ALREADY_EXISTS.code();
        }
    }
    match replace {
        Some(pos) => rows[pos] = row,
        None => rows.push(row),
    }
    assert!(
        generated.len() <= len,
        "native_host_tests: generated columns exceed the row buffer"
    );
    // SAFETY: `generated.len() <= len`, so it fits the caller's buffer.
    unsafe {
        std::ptr::copy_nonoverlapping(generated.as_ptr(), row_ptr, generated.len());
        row_len_ptr.write(generated.len());
    }
    0
}

/// `Table::delete(row)` — real only for a `writable` table; removes every
/// stored row byte-equal to a row of the relation and reports how many went.
///
/// SAFETY: `rel_ptr[..rel_len]` is the caller's BSATN relation buffer.
unsafe fn delete_all_by_eq(
    table_id: u32,
    rel_ptr: *const u8,
    rel_len: usize,
    out: *mut u32,
) -> u16 {
    let relation = unsafe { std::slice::from_raw_parts(rel_ptr, rel_len) };
    let mut h = host();
    let h = &mut *h;
    *h.writes.entry(table_id).or_insert(0) += 1;
    let Some(split) = h
        .model
        .tables
        .get(&table_id)
        .filter(|t| t.writable)
        .and_then(|t| t.split)
    else {
        unmodelled("datastore_delete_all_by_eq_bsatn")
    };
    let doomed = split(relation);
    let rows = h.rows.entry(table_id).or_default();
    let before = rows.len();
    rows.retain(|row| !doomed.contains(row));
    let removed = u32::try_from(before - rows.len()).expect("native_host_tests: count fits a u32");
    // SAFETY: `out` points at the bindings' `MaybeUninit<u32>` out-param.
    unsafe { out.write(removed) };
    0
}

#[no_mangle]
unsafe extern "C" fn datastore_table_row_count(table_id: u32, out: *mut u64) -> u16 {
    let h = host();
    if !h.model.tables.get(&table_id).is_some_and(|t| t.scannable) {
        unmodelled("datastore_table_row_count")
    }
    // SAFETY: `out` points at the bindings' `MaybeUninit<u64>` out-param.
    unsafe { out.write(h.rows_of(table_id).len() as u64) };
    0
}

#[no_mangle]
unsafe extern "C" fn datastore_clear(table_id: u32, out: *mut u64) -> u16 {
    let mut h = host();
    if !h.model.tables.get(&table_id).is_some_and(|t| t.writable) {
        unmodelled("datastore_clear")
    }
    let removed = h.rows.remove(&table_id).map_or(0, |rows| rows.len());
    // SAFETY: `out` points at the bindings' `MaybeUninit<u64>` out-param.
    unsafe { out.write(removed as u64) };
    0
}

/// `ReducerContext::database_identity()` — the fixture's module identity.
#[no_mangle]
unsafe extern "C" fn identity(out_ptr: *mut u8) {
    let id = host().model.database_identity;
    // SAFETY: `out_ptr` points at the bindings' 32-byte out buffer.
    unsafe { std::ptr::copy_nonoverlapping(id.as_ptr(), out_ptr, 32) };
}

/// Accepts writes to the sinks this host hands out, and keeps the describe and view bytes.
#[no_mangle]
unsafe extern "C" fn bytes_sink_write(
    sink: u32,
    buffer_ptr: *const u8,
    len_ptr: *mut usize,
) -> u16 {
    // Returning 0 leaves `*len_ptr` at the full buffer length: all consumed.
    if sink == DESCRIBE_SINK {
        // SAFETY: the runtime hands a valid `buffer_ptr[..*len_ptr]`.
        let bytes = unsafe { std::slice::from_raw_parts(buffer_ptr, *len_ptr) };
        DESCRIBE_OUT
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .extend_from_slice(bytes);
        0
    } else if sink == ERROR_SINK || sink == PROCEDURE_SINK {
        0
    } else if sink == VIEW_SINK {
        // SAFETY: the runtime hands a valid `buffer_ptr[..*len_ptr]`.
        let bytes = unsafe { std::slice::from_raw_parts(buffer_ptr, *len_ptr) };
        VIEW_OUT.with(|b| b.borrow_mut().extend_from_slice(bytes));
        0
    } else {
        unmodelled("bytes_sink_write to a sink this host never handed out")
    }
}

// ---------------------------------------------------------------------------
// THE CONNECTION + JWT MODEL (debloat Phase 2, ST-accounts_tests#auth).
//
// `run_as_conn_at` hands `__call_reducer__` a NON-ZERO connection id, so the
// runtime builds the context's `AuthCtx` over `rt::get_jwt` for that connection
// exactly as a client call does (`lib.rs:1216`): the first `has_jwt()` / `jwt()`
// asks the `get_jwt` syscall for that connection, and a valid bytes source is
// then read through `bytes_source_remaining_length` + `bytes_source_read`
// (`rt.rs:1588-1599`, `read_bytes_source_into` at `rt.rs:1610`). This host serves the JWT
// through ONE source, [`JWT_SOURCE`], holding the claims payload the test chose; `None`
// answers the INVALID source, which the runtime reads as "no JWT" (the anonymous player).
// Reducer and procedure ARGS stay the INVALID source (`run_as` and `run_procedure` pass
// none). The only other sources are the answers to a procedure's HTTP requests (the
// PROCEDURES banner), which the same two syscalls serve.
// ---------------------------------------------------------------------------

/// The bytes source of the current connection's JWT.
const JWT_SOURCE: u32 = 0x0A57;

#[no_mangle]
unsafe extern "C" fn bytes_source_read(
    source: u32,
    buffer_ptr: *mut u8,
    len_ptr: *mut usize,
) -> i16 {
    let mut h = host();
    let model = &mut h.model;
    if let Some((payload, cursor)) = model.answer_sources.get_mut(&source) {
        // SAFETY: as for the JWT source below.
        let exhausted = unsafe { read_source(payload, cursor, buffer_ptr, len_ptr) };
        if exhausted {
            model.answer_sources.remove(&source);
            return -1;
        }
        return 0;
    }
    if source != JWT_SOURCE {
        unmodelled("bytes_source_read of a source this host never handed out")
    }
    let Some(payload) = model.jwt.as_ref() else {
        unmodelled("bytes_source_read of a JWT source with no payload")
    };
    // SAFETY: `len_ptr` is the caller's spare-capacity length and `buffer_ptr`
    // points at that many writable bytes (`read_bytes_source_into`).
    if unsafe { read_source(payload, &mut model.jwt_cursor, buffer_ptr, len_ptr) } {
        -1 // exhausted
    } else {
        0
    }
}

/// Copies as much of `payload[*cursor..]` as the caller's buffer takes, moves the cursor past
/// it, and says whether the payload is now read to its end.
///
/// SAFETY: `len_ptr` holds the capacity of `buffer_ptr[..]`, both live for the call.
unsafe fn read_source(
    payload: &[u8],
    cursor: &mut usize,
    buffer_ptr: *mut u8,
    len_ptr: *mut usize,
) -> bool {
    let rest = &payload[*cursor..];
    let room = unsafe { len_ptr.read() };
    let n = room.min(rest.len());
    unsafe {
        std::ptr::copy_nonoverlapping(rest.as_ptr(), buffer_ptr, n);
        len_ptr.write(n);
    }
    *cursor += n;
    *cursor == payload.len()
}

#[no_mangle]
unsafe extern "C" fn bytes_source_remaining_length(source: u32, out: *mut u32) -> i16 {
    let h = host();
    let (payload, cursor) = match h.model.answer_sources.get(&source) {
        Some((payload, cursor)) => (payload, *cursor),
        None if source != JWT_SOURCE => {
            unmodelled("bytes_source_remaining_length of a source this host never handed out")
        }
        None => match h.model.jwt.as_ref() {
            Some(payload) => (payload, h.model.jwt_cursor),
            None => unmodelled("bytes_source_remaining_length of a JWT source with no payload"),
        },
    };
    let rest = u32::try_from(payload.len() - cursor)
        .expect("native_host_tests: a byte source fits a u32 length");
    // SAFETY: `out` points at the bindings' `u32` out-param.
    unsafe { out.write(rest) };
    0
}

#[no_mangle]
unsafe extern "C" fn get_jwt(connection_id_ptr: *const u8, bytes_source_id: *mut u32) -> u16 {
    // SAFETY: the runtime passes a 16-byte little-endian `ConnectionId`.
    let conn = unsafe { std::slice::from_raw_parts(connection_id_ptr, 16) };
    let mut h = host();
    if conn != h.model.jwt_conn {
        unmodelled("get_jwt for a connection `run_as_conn_at` never opened")
    }
    h.model.jwt_cursor = 0;
    let source = if h.model.jwt.is_some() { JWT_SOURCE } else { 0 };
    // SAFETY: `bytes_source_id` points at the bindings' `BytesSource` (`u32`) out-param.
    unsafe { bytes_source_id.write(source) };
    0
}

/// ST-accounts_tests#auth demonstration: a connection-bearing context carries
/// the connection id, reads back EXACTLY the claims the test served (issuer,
/// audience, subject — through the SDK's own parser), and a `None` payload is
/// the JWT-less connection. The internal `run_as` context has no connection.
#[test]
fn nh_run_as_conn_serves_the_connection_and_its_jwt() {
    let fx = fixture();
    let me = Identity::from_byte_array([7u8; 32]);
    let at = Timestamp::from_micros_since_unix_epoch(1_700_000_000_000_000);
    let claims = r#"{"iss":"issuer.example","aud":["a","b"],"sub":"s-1"}"#;
    let (conn, has, iss, aud, sub) = fx.run_as_conn_at(me, 0xC0FFEE, Some(claims), at, |ctx| {
        let jwt = ctx
            .sender_auth()
            .jwt()
            .expect("the served JWT must be visible");
        (
            ctx.connection_id().map(|c| c.to_u128()),
            ctx.sender_auth().has_jwt(),
            jwt.issuer().to_string(),
            jwt.audience().to_vec(),
            jwt.subject().to_string(),
        )
    });
    assert_eq!(conn, Some(0xC0FFEE));
    assert!(has, "a served payload is a JWT-bearing connection");
    assert_eq!(iss, "issuer.example");
    assert_eq!(aud, vec!["a".to_string(), "b".to_string()]);
    assert_eq!(sub, "s-1");

    let anon = fx.run_as_conn_at(me, 0xC0FFEF, None, at, |ctx| {
        (ctx.connection_id().is_some(), ctx.sender_auth().has_jwt())
    });
    assert_eq!(
        anon,
        (true, false),
        "a None payload is a JWT-less connection"
    );
    assert_eq!(
        fx.run_as(me, |ctx| (ctx.connection_id(), ctx.sender_auth().has_jwt())),
        (None, false),
        "run_as stays the internal, connection-less context"
    );
}

/// ST-native_host_tests demonstration: `run_as_at` lands the chosen sender and
/// timestamp on a real context, and `database_identity()` links and answers
/// the fixture's module identity — each distinct from the dummy context's
/// all-zero sender (== `WILD_IDENTITY`) and epoch clock.
#[test]
fn nh_run_as_sets_sender_time_and_database_identity() {
    let fx = fixture();
    let me = Identity::from_byte_array([7u8; 32]);
    let at = Timestamp::from_micros_since_unix_epoch(1_700_000_000_000_000);
    let (sender, stamp, module) = fx.run_as_at(me, at, |ctx| {
        (ctx.sender(), ctx.timestamp, ctx.database_identity())
    });
    assert_eq!(
        sender, me,
        "run_as_at must hand the closure a context whose sender is `me`"
    );
    assert_ne!(
        sender,
        crate::WILD_IDENTITY,
        "the chosen sender must not be the wild sentinel"
    );
    assert_eq!(
        stamp, at,
        "run_as_at must hand the closure the chosen timestamp"
    );
    assert_eq!(module, Identity::from_byte_array(DEFAULT_DATABASE_IDENTITY));
    assert_ne!(
        module, me,
        "the module identity must differ from the caller"
    );
    assert_ne!(module, crate::WILD_IDENTITY);

    let other = Identity::from_byte_array([8u8; 32]);
    fx.set_database_identity(other);
    assert_eq!(
        fx.ctx().database_identity(),
        other,
        "set_database_identity must take effect"
    );
    assert_eq!(
        fx.ctx_at(at).timestamp,
        at,
        "ctx_at must set the dummy context's clock"
    );
    assert_eq!(
        fx.ctx().sender(),
        crate::WILD_IDENTITY,
        "fx.ctx() stays the all-zero dummy"
    );

    // A panic inside the body surfaces in THIS frame as an ordinary panic.
    let caught = catch_unwind(AssertUnwindSafe(|| fx.run_as(me, |_| panic!("inner"))));
    assert!(
        caught.is_err(),
        "a panic inside run_as must propagate to the caller"
    );
    assert_eq!(
        fx.run_as(other, |ctx| ctx.sender()),
        other,
        "run_as is reusable after a panic"
    );
}

/// ST-native_host_tests demonstration: the opt-in scan, count, delete-by-value
/// and clear paths, driven through the same `spacetimedb::sys` wrappers the
/// generated `.iter()` / `.count()` / `.delete(row)` / `.clear()` call. The row
/// type is a bare `u64` on a scratch table name, so this file still names no
/// schema accessor or row type.
#[test]
fn nh_scannable_writable_table_scans_counts_deletes_and_clears() {
    use spacetimedb::sys;
    let fx = fixture();
    let scratch = fx
        .table_keyed::<u64, u64>("nh_scratch", "id", |r| *r)
        .scannable()
        .writable();
    for row in [3u64, 1, 2] {
        scratch.seed(&row);
    }
    let table = sys::table_id_from_name("nh_scratch").expect("the scratch table resolves");
    assert_eq!(sys::datastore_table_row_count(table).expect("count"), 3);

    let mut iter = sys::datastore_table_scan_bsatn(table).expect("scan opens");
    let mut buf = Vec::new();
    while !iter.is_exhausted() {
        iter.read(&mut buf);
    }
    let scanned: Vec<u64> =
        bsatn::from_slice::<Vec<u64>>(&[&3u32.to_le_bytes()[..], &buf].concat())
            .expect("three u64 rows");
    assert_eq!(
        scanned,
        vec![3, 1, 2],
        "a table scan yields every row in store order"
    );
    assert_eq!(fx.open_iters(), 0, "a drained scan closes its iterator");

    let relation = bsatn::to_vec(&vec![1u64]).expect("relation encodes");
    assert_eq!(
        sys::datastore_delete_all_by_eq_bsatn(table, &relation).expect("delete"),
        1
    );
    assert_eq!(
        scratch.rows(),
        vec![3, 2],
        "delete-by-value removes exactly the equal row"
    );
    assert_eq!(
        sys::datastore_clear(table).expect("clear"),
        2,
        "clear reports what it removed"
    );
    assert!(scratch.rows().is_empty(), "clear empties the table");
}

// ---------------------------------------------------------------------------
// PROCEDURES. `Fixture::run_procedure` runs a closure inside the SHIPPED
// `__call_procedure__` entry point (`vendor/spacetimedb/src/rt.rs:1395`), the only code that
// builds a `ProcedureContext` (its constructor is private, `vendor/spacetimedb/src/lib.rs:1508`).
// A trampoline procedure is registered beside the reducer one and is procedure 0 of the
// fixture's definition, which therefore lists the two trampolines and no shipped procedure.
// The closure calls the procedure under test as a plain function.
//
// * TRANSACTIONS. `with_tx` / `try_with_tx` reach `procedure_start_mut_tx`, which keeps every
//   table's rows and the write counts as it found them, and then `procedure_commit_mut_tx`
//   (the copy is dropped) or `procedure_abort_mut_tx` (both are put back). The crate aborts
//   when the body returns `Err` and, through a drop guard, when it panics. An `#[auto_inc]`
//   sequence is not rewound, as a real one is not, and `rows_read` keeps what it counted.
//   Every transaction reads the run's one time: the clock does not move while a request waits.
//   `Fixture::procedure_commits` counts the transactions that committed, so a test can show
//   that two writes shared one.
// * HTTP. `ctx.http.send` reaches `procedure_http_request`, which records the request in the
//   test's `HttpQueue` and answers with the queue's next `HttpAnswer`: a status and body, or
//   an error. Nothing leaves the process (the test binary holds no HTTP client), and the
//   request's timeout is recorded, never enforced. The answer goes back as byte sources the
//   runtime reads through `bytes_source_read`: the BSATN response head and the body (the
//   INVALID source when the body is empty, which is what the crate reads as an empty body,
//   `vendor/spacetimedb/src/http.rs:555`), or the BSATN error text with the code `HTTP_ERROR`.
// * A REQUEST WITH NO ANSWER LEFT fails the test. The host function runs inside an
//   `extern "C"` frame, where a panic aborts the process, so it answers that request with an
//   error and `run_procedure` panics in the test's frame once the procedure has returned. A
//   second such request in one run is answered with a code the bindings panic on, in the
//   procedure's own frame, so a retry loop stops there instead of hanging the test. A panic
//   inside a `while_waiting` closure is carried out to the test's frame the same way.
// * NOT MODELLED: `sleep_until` (the crate refuses it natively), a connection id or JWT on
//   the context, request and response headers, a failed commit, and the host's refusal of a
//   request or a second start while a transaction is open (the crate's API cannot make either:
//   a transaction's body holds the context's only borrow).
// ---------------------------------------------------------------------------

use spacetimedb::spacetimedb_lib::http as wire;
use spacetimedb::{ProcedureContext, TimeDuration};
use std::any::Any;

/// Who a procedure runs as. Either way `ctx.connection_id()` is `None`.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Caller {
    /// A client: `ctx.sender()` is this identity.
    Sender(Identity),
    /// The database itself, as a scheduled procedure runs: `ctx.sender()` is the fixture's
    /// module identity when the run starts, which `ctx.database_identity()` also answers.
    Database,
}

/// One HTTP request a procedure sent, as the host received it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SentRequest {
    /// The HTTP method's own spelling: `GET`, `POST`, ...
    pub(crate) method: String,
    pub(crate) url: String,
    /// Empty for a request with no body.
    pub(crate) body: Vec<u8>,
    /// The `http::Timeout` the request carried, or `None`. The host answers at once whatever
    /// it says.
    pub(crate) timeout: Option<TimeDuration>,
}

/// One stubbed answer to a procedure's HTTP request.
pub(crate) struct HttpAnswer<'q> {
    /// The status and body, or the text of the error `ctx.http.send` returns.
    outcome: Result<(u16, Vec<u8>), String>,
    while_waiting: Option<Box<dyn FnOnce() + 'q>>,
}

impl<'q> HttpAnswer<'q> {
    /// A response with the status `code` and `body`.
    pub(crate) fn status(code: u16, body: impl Into<Vec<u8>>) -> Self {
        assert!(
            (100..=999).contains(&code),
            "native_host_tests: {code} is not an HTTP status code"
        );
        HttpAnswer {
            outcome: Ok((code, body.into())),
            while_waiting: None,
        }
    }

    /// A request that got no response: `ctx.http.send` returns an `Err` whose text is `message`.
    pub(crate) fn error(message: impl Into<String>) -> Self {
        HttpAnswer {
            outcome: Err(message.into()),
            while_waiting: None,
        }
    }

    /// Runs `change` while the procedure waits for this answer, before the answer is given: the
    /// place for a test to change a row another transaction would have changed meanwhile.
    pub(crate) fn while_waiting(mut self, change: impl FnOnce() + 'q) -> Self {
        self.while_waiting = Some(Box::new(change));
        self
    }
}

/// The stubbed answers a procedure's requests get, in order, and every request it sent.
pub(crate) struct HttpQueue<'q> {
    answers: VecDeque<HttpAnswer<'q>>,
    requests: Vec<SentRequest>,
}

impl<'q> HttpQueue<'q> {
    /// A queue with no answers and no requests.
    pub(crate) fn new() -> Self {
        HttpQueue {
            answers: VecDeque::new(),
            requests: Vec::new(),
        }
    }

    /// Adds `answer` behind the ones already queued.
    pub(crate) fn push(&mut self, answer: HttpAnswer<'q>) -> &mut Self {
        self.answers.push_back(answer);
        self
    }

    /// Every request sent through this queue, oldest first, across every run it was given to;
    /// a request that found no answer left is among them.
    pub(crate) fn requests(&self) -> &[SentRequest] {
        &self.requests
    }
}

type ProcedureBody = *mut (dyn FnMut(&mut ProcedureContext) + 'static);

/// What one [`Fixture::run_procedure`] call keeps while the runtime runs its body.
struct ProcedureRun {
    /// The closure the trampoline runs.
    body: ProcedureBody,
    /// The time the procedure runs at; each of its transactions reads it.
    at_micros: i64,
    /// The test's queue.
    http: *mut HttpQueue<'static>,
    /// The first request that found no answer left, as `<METHOD> <url>`.
    unanswered: Option<String>,
    /// The panic of a `while_waiting` closure.
    waiting_panic: Option<Box<dyn Any + Send>>,
}

thread_local! {
    /// The run in progress on this thread, if any.
    static PROCEDURE_RUN: RefCell<Option<ProcedureRun>> = const { RefCell::new(None) };
}

/// Applies `f` to the run in progress; `None` when no procedure is running.
fn with_procedure_run<T>(f: impl FnOnce(&mut ProcedureRun) -> T) -> Option<T> {
    PROCEDURE_RUN.with(|slot| slot.borrow_mut().as_mut().map(f))
}

/// The `BytesSink` a procedure's result is written to (and discarded: the trampoline returns
/// nothing, and `run_procedure` hands the closure's value back itself).
const PROCEDURE_SINK: u32 = 0x9C0C;

/// HTTP answer sources are numbered from here, clear of [`JWT_SOURCE`] and the INVALID `0`.
const ANSWER_SOURCE_BASE: u32 = 0x4000_0000;

unsafe extern "C" {
    /// `vendor/spacetimedb/src/rt.rs:1395` (`#[unsafe(no_mangle)]`).
    fn __call_procedure__(
        id: usize,
        sender_0: u64,
        sender_1: u64,
        sender_2: u64,
        sender_3: u64,
        conn_id_0: u64,
        conn_id_1: u64,
        timestamp: u64,
        args: u32,
        result_sink: u32,
    ) -> i16;
}

/// The trampoline procedure's registration metadata (what `#[procedure]` would generate). Not
/// a module procedure: this file only exists in the test binary.
struct ProcedureTrampoline;

impl spacetimedb::rt::ExplicitNames for ProcedureTrampoline {}

impl spacetimedb::rt::FnInfo for ProcedureTrampoline {
    type Invoke = spacetimedb::rt::ProcedureFn;
    type FnKind = spacetimedb::rt::FnKindProcedure<()>;
    const NAME: &'static str = "native_host_run_procedure";
    const ARG_NAMES: &'static [Option<&'static str>] = &[];
    const INVOKE: Self::Invoke = procedure_trampoline;
}

/// Type witness for `register_procedure` (the zero-argument, unit-returning procedure shape).
fn procedure_signature(_ctx: &mut ProcedureContext) {}

fn procedure_trampoline(ctx: &mut ProcedureContext, _args: &[u8]) -> spacetimedb::ProcedureResult {
    let body = with_procedure_run(|run| run.body)
        .expect("native_host_tests: the procedure trampoline was called outside run_procedure");
    // SAFETY: `run_procedure` keeps the pointee alive for this whole call (see there).
    unsafe { (*body)(ctx) };
    Vec::new()
}

impl Fixture {
    /// Runs `f` with a real `ProcedureContext` whose sender is `caller` and whose `timestamp`
    /// is `at` (at or after the Unix epoch), answering its HTTP requests from `http`. See the
    /// PROCEDURES banner for the mechanism.
    ///
    /// Returns what `f` returns. Once the procedure has returned, the first of these that
    /// happened is raised here, in the caller's frame: a panic inside a `while_waiting`
    /// closure; a request that found no answer left in `http`; a panic in `f`.
    pub(crate) fn run_procedure<T>(
        &self,
        caller: Caller,
        at: Timestamp,
        http: &mut HttpQueue<'_>,
        f: impl FnOnce(&mut ProcedureContext) -> T,
    ) -> T {
        ensure_run_as_registered();
        let sender = match caller {
            Caller::Sender(sender) => sender,
            Caller::Database => Identity::from_byte_array(host().model.database_identity),
        };
        let at_micros = at.to_micros_since_unix_epoch();
        let micros = u64::try_from(at_micros).expect(
            "native_host_tests: run_procedure needs a timestamp at or after the Unix epoch",
        );
        let mut f = Some(f);
        let mut out: Option<std::thread::Result<T>> = None;
        let mut body = |ctx: &mut ProcedureContext| {
            let f = f
                .take()
                .expect("native_host_tests: the run_procedure body runs once");
            out = Some(catch_unwind(AssertUnwindSafe(|| f(ctx))));
        };
        let body_ref: &mut (dyn FnMut(&mut ProcedureContext) + '_) = &mut body;
        // SAFETY: only lifetimes are erased, of the closure here and of the queue below. The
        // trampoline and `procedure_http_request` use the two pointers during the
        // `__call_procedure__` call below, and the slot is emptied right after it, while
        // `body` and `http` are still alive and otherwise unused.
        let body: ProcedureBody = unsafe {
            std::mem::transmute(body_ref as *mut (dyn FnMut(&mut ProcedureContext) + '_))
        };
        let http: *mut HttpQueue<'static> = std::ptr::from_mut(http).cast();
        PROCEDURE_RUN.with(|slot| {
            let mut slot = slot.borrow_mut();
            assert!(
                slot.is_none(),
                "native_host_tests: run_procedure called while a procedure is running"
            );
            *slot = Some(ProcedureRun {
                body,
                at_micros,
                http,
                unanswered: None,
                waiting_panic: None,
            });
        });
        let [s0, s1, s2, s3] = identity_words(sender);
        // SAFETY: the shipped entry point; procedure 0 is the trampoline (the only registered
        // procedure), there is no connection, args are the INVALID (empty) source, and the
        // result sink is one `bytes_sink_write` accepts.
        unsafe { __call_procedure__(0, s0, s1, s2, s3, 0, 0, micros, 0, PROCEDURE_SINK) };
        let run = PROCEDURE_RUN
            .with(|slot| slot.borrow_mut().take())
            .expect("native_host_tests: the procedure run left its slot during the call");
        if let Some(panic) = run.waiting_panic {
            resume_unwind(panic);
        }
        if let Some(request) = run.unanswered {
            panic!(
                "native_host_tests: the procedure sent `{request}` with no stubbed HTTP answer left"
            );
        }
        match out.expect("native_host_tests: __call_procedure__ never ran the run_procedure body") {
            Ok(value) => value,
            Err(panic) => resume_unwind(panic),
        }
    }
}

/// Starts a procedure's transaction: keeps what an abort puts back, and answers the run's time.
#[no_mangle]
unsafe extern "C" fn procedure_start_mut_tx(out: *mut i64) -> u16 {
    let Some(at_micros) = with_procedure_run(|run| run.at_micros) else {
        unmodelled("procedure_start_mut_tx outside `Fixture::run_procedure`")
    };
    let mut h = host();
    h.model.tx = Some(TxStart {
        rows: h.rows.clone(),
        writes: h.writes.clone(),
    });
    // SAFETY: `out` points at the bindings' `MaybeUninit<i64>` out-param.
    unsafe { out.write(at_micros) };
    0
}

/// Commits a procedure's transaction: its writes stay.
#[no_mangle]
unsafe extern "C" fn procedure_commit_mut_tx() -> u16 {
    let mut h = host();
    match h.model.tx.take() {
        Some(_) => {
            h.model.procedure_commits += 1;
            0
        }
        None => Errno::TRANSACTION_NOT_ANONYMOUS.code(),
    }
}

/// Aborts a procedure's transaction: the rows and the write counts are what they were when
/// it started.
#[no_mangle]
unsafe extern "C" fn procedure_abort_mut_tx() -> u16 {
    let mut h = host();
    let Some(start) = h.model.tx.take() else {
        return Errno::TRANSACTION_NOT_ANONYMOUS.code();
    };
    h.rows = start.rows;
    h.writes = start.writes;
    0
}

/// Hands `bytes` to the runtime as a byte source and returns its id.
fn open_answer_source(bytes: Vec<u8>) -> u32 {
    let mut h = host();
    let model = &mut h.model;
    model.answer_sources_opened += 1;
    let id = ANSWER_SOURCE_BASE + model.answer_sources_opened;
    model.answer_sources.insert(id, (bytes, 0));
    id
}

/// Answers a request with the error `message`: one source holding its BSATN, and `HTTP_ERROR`.
///
/// SAFETY: `out` points at the bindings' `[BytesSource; 2]` out-param.
unsafe fn answer_with_error(out: *mut [u32; 2], message: &str) -> u16 {
    let message = bsatn::to_vec(&message).expect("native_host_tests: a string BSATN-encodes");
    let source = open_answer_source(message);
    unsafe { out.write([source, 0]) };
    Errno::HTTP_ERROR.code()
}

/// The HTTP method's own spelling.
fn method_name(method: wire::Method) -> String {
    let name = match method {
        wire::Method::Get => "GET",
        wire::Method::Head => "HEAD",
        wire::Method::Post => "POST",
        wire::Method::Put => "PUT",
        wire::Method::Delete => "DELETE",
        wire::Method::Connect => "CONNECT",
        wire::Method::Options => "OPTIONS",
        wire::Method::Trace => "TRACE",
        wire::Method::Patch => "PATCH",
        wire::Method::Extension(name) => return name,
    };
    name.to_string()
}

/// Records the request and answers it with the next stubbed answer of the run's queue (see
/// the PROCEDURES banner). It opens no connection.
#[no_mangle]
unsafe extern "C" fn procedure_http_request(
    request_ptr: *const u8,
    request_len: u32,
    body_ptr: *const u8,
    body_len: u32,
    out: *mut [u32; 2],
) -> u16 {
    // SAFETY: `request_ptr[..request_len]` and `body_ptr[..body_len]` are the caller's
    // serialised request and its body, live for the call's duration.
    let request = unsafe { std::slice::from_raw_parts(request_ptr, request_len as usize) };
    let body = unsafe { std::slice::from_raw_parts(body_ptr, body_len as usize) };
    let Ok(request) = bsatn::from_slice::<wire::Request>(request) else {
        return Errno::BSATN_DECODE_ERROR.code();
    };
    let sent = SentRequest {
        method: method_name(request.method),
        url: request.uri,
        body: body.to_vec(),
        timeout: request.timeout,
    };
    let line = format!("{} {}", sent.method, sent.url);
    // The run is borrowed only for this step, so a `while_waiting` closure may use the fixture.
    let next = with_procedure_run(|run| {
        // SAFETY: `run_procedure` keeps the queue alive and otherwise unused for the call.
        let queue = unsafe { &mut *run.http };
        queue.requests.push(sent);
        let answer = queue.answers.pop_front();
        let had_unanswered = run.unanswered.is_some();
        if answer.is_none() && !had_unanswered {
            run.unanswered = Some(line.clone());
        }
        (answer, had_unanswered)
    });
    let Some((answer, had_unanswered)) = next else {
        unmodelled("procedure_http_request outside `Fixture::run_procedure`")
    };
    let Some(answer) = answer else {
        if had_unanswered {
            // Any code but `HTTP_ERROR` makes the bindings panic in the procedure's frame
            // (`vendor/spacetimedb-bindings-sys/src/lib.rs:1961`), which ends the run.
            return Errno::HOST_CALL_FAILURE.code();
        }
        let message = format!("native_host_tests: no stubbed HTTP answer left for `{line}`");
        // SAFETY: `out` is the bindings' out-param.
        return unsafe { answer_with_error(out, &message) };
    };
    if let Some(change) = answer.while_waiting {
        if let Err(panic) = catch_unwind(AssertUnwindSafe(change)) {
            with_procedure_run(|run| {
                run.waiting_panic.get_or_insert(panic);
            });
            let message = "native_host_tests: a `while_waiting` closure panicked";
            // SAFETY: `out` is the bindings' out-param.
            return unsafe { answer_with_error(out, message) };
        }
    }
    match answer.outcome {
        Ok((code, body)) => {
            let head = wire::Response {
                headers: std::iter::empty().collect(),
                version: wire::Version::Http11,
                code,
            };
            let head = bsatn::to_vec(&head).expect("native_host_tests: a response BSATN-encodes");
            let head = open_answer_source(head);
            let body = if body.is_empty() {
                0
            } else {
                open_answer_source(body)
            };
            // SAFETY: `out` points at the bindings' `[BytesSource; 2]` out-param.
            unsafe { out.write([head, body]) };
            0
        }
        // SAFETY: `out` is the bindings' out-param.
        Err(message) => unsafe { answer_with_error(out, &message) },
    }
}

// ---------------------------------------------------------------------------
// THE VENDORED CRATES. `spacetimedb` and `spacetimedb-bindings-sys` build from the copies
// under `vendor/` (the root `Cargo.toml` `[patch.crates-io]`): their crates.io packages,
// patched in `#[cfg]` attributes only, so that off wasm the table backend, a procedure's
// transactions and its HTTP client call the host ABI above and the vendor's native stubs
// compile out. On wasm every patched attribute selects what the original selected, so the
// module ships the vendor's code.
// ---------------------------------------------------------------------------

use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// The provenance of the code the module ships, which no behaviour test can see: an edit
/// inside a vendored copy that only wasm compiles passes every native test. Undoing
/// `vendor/native-host.patch` strictly, hunk by hunk, must give back each file whose sha256
/// `vendor/PRISTINE.sha256` records from the crates.io package. The copies hold exactly the
/// files the manifest lists, none executable; every changed line is a `#[cfg]` attribute that,
/// on wasm32 under every feature assignment, selects what the original selected; the manifest,
/// each copy's `Cargo.toml` and the workspace pin name one version; `[patch.crates-io]` points
/// the two crates, and nothing else, at their copies; and no other root-manifest table and no
/// `.cargo/` config can patch or wrap the build behind them.
#[test]
fn nh_vendored_crates_are_the_crates_io_release_plus_the_patch() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let root_manifest = std::fs::read_to_string(root.join("Cargo.toml"))
        .unwrap_or_else(|e| panic!("native_host_tests: ../Cargo.toml cannot be read: {e}"));
    let vendor = root.join("vendor");
    check(&vendor, &root_manifest).unwrap_or_else(|e| panic!("native_host_tests: {e}"));
}

/// The guard's checks over `vendor/` and the root `Cargo.toml` (`root_manifest`), in order.
/// The first that fails is the error, naming the file, the hunk or the path it is about. Its
/// helpers come first, the checks after them.
fn check(vendor: &Path, root_manifest: &str) -> Result<(), String> {
    const MANIFEST: &str = "vendor/PRISTINE.sha256";
    const PATCH: &str = "vendor/native-host.patch";
    // The crates the native host needs patched, and so the only ones vendored.
    const CRATES: [&str; 2] = ["spacetimedb", "spacetimedb-bindings-sys"];
    // What `vendor/` holds beside the crate directories.
    const TOP_FILES: [&str; 3] = ["PRISTINE.sha256", "README.md", "native-host.patch"];

    // `vendor/PRISTINE.sha256`, parsed. Paths are relative to `vendor/`.
    struct Pristine {
        // Crate name (its directory under `vendor/`) -> version.
        crates: BTreeMap<String, String>,
        // A file a copy holds -> its sha256 as published.
        held: BTreeMap<String, String>,
        // A file the package holds and its copy leaves out.
        omitted: BTreeSet<String>,
    }

    // One `@@` hunk. A body line is its kind byte (` `, `-` or `+`) and the file's line,
    // `\n` included.
    struct Hunk {
        header: String,
        old_start: usize,
        new_start: usize,
        body: Vec<(u8, Vec<u8>)>,
    }

    // The hunks the patch holds for one file, in order.
    struct FilePatch {
        path: String,
        hunks: Vec<Hunk>,
    }

    // A cfg predicate over the two keys a patched attribute may name.
    enum Cfg {
        All(Vec<Cfg>),
        Any(Vec<Cfg>),
        Not(Box<Cfg>),
        TargetArch(String),
        Feature(String),
    }

    impl Cfg {
        // The value when compiling for wasm32 with exactly the features in `on`.
        fn on_wasm(&self, on: &BTreeSet<&str>) -> bool {
            match self {
                Cfg::All(all) => all.iter().all(|cfg| cfg.on_wasm(on)),
                Cfg::Any(any) => any.iter().any(|cfg| cfg.on_wasm(on)),
                Cfg::Not(not) => !not.on_wasm(on),
                Cfg::TargetArch(arch) => arch == "wasm32",
                Cfg::Feature(feature) => on.contains(feature.as_str()),
            }
        }

        // Adds every feature the predicate names to `out`.
        fn features<'a>(&'a self, out: &mut BTreeSet<&'a str>) {
            match self {
                Cfg::All(list) | Cfg::Any(list) => {
                    for cfg in list {
                        cfg.features(out);
                    }
                }
                Cfg::Not(not) => not.features(out),
                Cfg::TargetArch(_) => {}
                Cfg::Feature(feature) => {
                    out.insert(feature.as_str());
                }
            }
        }
    }

    fn is_lower_hex(byte: u8) -> bool {
        byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
    }

    fn is_sha256(hex: &str) -> bool {
        hex.len() == 64 && hex.bytes().all(is_lower_hex)
    }

    // A byte of a crate name, of a cfg string or of a bare TOML key.
    fn is_name_byte(byte: u8) -> bool {
        byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
    }

    fn is_version_byte(byte: u8) -> bool {
        is_name_byte(byte) || byte == b'.' || byte == b'+'
    }

    fn is_path_part(part: &str) -> bool {
        !part.is_empty() && part != "." && part != ".."
    }

    // A `/` path below a crate directory: relative, no empty, `.` or `..` part, no `\`.
    fn is_vendor_path(path: &str) -> bool {
        path.contains('/') && !path.contains('\\') && path.split('/').all(is_path_part)
    }

    // The crate directory a path is in: its first part.
    fn crate_of(path: &str) -> &str {
        path.split_once('/').map_or(path, |(name, _)| name)
    }

    // `<name> <version> <cksum>` (what follows `crate `) -> the name and the version.
    fn crate_line(rest: &str) -> Option<(&str, &str)> {
        let fields: Vec<&str> = rest.split(' ').collect();
        let &[name, version, cksum] = fields.as_slice() else {
            return None;
        };
        let name_ok = !name.is_empty() && name.bytes().all(is_name_byte);
        let version_ok = !version.is_empty() && version.bytes().all(is_version_byte);
        (name_ok && version_ok && is_sha256(cksum)).then_some((name, version))
    }

    // `<sha256>  <path>` -> the hash and the path.
    fn hash_and_path(rest: &str) -> Option<(&str, &str)> {
        let (hash, path) = rest.split_once("  ")?;
        (is_sha256(hash) && is_vendor_path(path)).then_some((hash, path))
    }

    fn read(vendor: &Path, rel: &str) -> Result<Vec<u8>, String> {
        let path = vendor.join(rel);
        std::fs::read(path).map_err(|e| format!("vendor/{rel}: cannot be read: {e}"))
    }

    fn read_text(vendor: &Path, rel: &str) -> Result<String, String> {
        let bytes = read(vendor, rel)?;
        String::from_utf8(bytes).map_err(|_| format!("vendor/{rel}: is not UTF-8"))
    }

    // The manifest: blank and `#` lines skipped, every other line a `crate` line, a held file
    // or an `omitted` file, no path twice, at least one crate and one held file.
    fn parse_pristine(text: &str) -> Result<Pristine, String> {
        let mut crates = BTreeMap::new();
        let mut held = BTreeMap::new();
        let mut omitted = BTreeSet::new();
        let mut paths = BTreeSet::new();
        for (index, line) in text.split('\n').enumerate() {
            let at = index + 1;
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(rest) = line.strip_prefix("crate ") {
                let (name, version) = crate_line(rest)
                    .ok_or_else(|| format!("{MANIFEST}:{at}: a malformed `crate` line"))?;
                let earlier = crates.insert(name.to_string(), version.to_string());
                if earlier.is_some() {
                    return Err(format!("{MANIFEST}:{at}: `{name}` declared twice"));
                }
                continue;
            }
            let is_omitted = line.starts_with("omitted ");
            let rest = line.strip_prefix("omitted ").unwrap_or(line);
            let (hash, path) = hash_and_path(rest)
                .ok_or_else(|| format!("{MANIFEST}:{at}: a malformed file line"))?;
            if !paths.insert(path) {
                return Err(format!("{MANIFEST}:{at}: `{path}` listed twice"));
            }
            if is_omitted {
                omitted.insert(path.to_string());
            } else {
                held.insert(path.to_string(), hash.to_string());
            }
        }
        if crates.is_empty() || held.is_empty() {
            return Err(format!("{MANIFEST}: no `crate` line or no file line"));
        }
        Ok(Pristine {
            crates,
            held,
            omitted,
        })
    }

    // Whether a file's mode has an execute bit; no file of a crates.io package has one.
    #[cfg(unix)]
    fn is_executable(meta: &std::fs::Metadata) -> bool {
        use std::os::unix::fs::PermissionsExt;
        (meta.permissions().mode() & 0o111) != 0
    }

    // Off unix a file's metadata carries no execute bits to read.
    #[cfg(not(unix))]
    fn is_executable(_: &std::fs::Metadata) -> bool {
        false
    }

    // Adds to `found` every file under `vendor/<rel>`, as a path relative to `vendor/`. An
    // entry that is neither a regular file nor a directory (a symlink, say) fails, and so does
    // a file with an execute bit.
    fn walk(vendor: &Path, rel: &str, found: &mut BTreeSet<String>) -> Result<(), String> {
        let listing = std::fs::read_dir(vendor.join(rel));
        let listing = listing.map_err(|e| format!("vendor/{rel}: cannot be listed: {e}"))?;
        for entry in listing {
            let entry = entry.map_err(|e| format!("vendor/{rel}: cannot be listed: {e}"))?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                return Err(format!("vendor/{rel}: holds a name that is not UTF-8"));
            };
            let path = format!("{rel}/{name}");
            let kind = entry.file_type();
            let kind = kind.map_err(|e| format!("vendor/{path}: {e}"))?;
            if kind.is_dir() {
                walk(vendor, &path, found)?;
            } else if kind.is_file() {
                let meta = entry.metadata();
                let meta = meta.map_err(|e| format!("vendor/{path}: {e}"))?;
                if is_executable(&meta) {
                    return Err(format!("vendor/{path}: has an execute bit set"));
                }
                found.insert(path);
            } else {
                return Err(format!("vendor/{path}: neither file nor directory"));
            }
        }
        Ok(())
    }

    // The entries of `dir` (`shown` in messages): each name, then `/` for a directory, nothing
    // for a regular file and `?` for anything else (a symlink, say).
    fn entries(dir: &Path, shown: &str) -> Result<BTreeSet<String>, String> {
        let listing = std::fs::read_dir(dir);
        let listing = listing.map_err(|e| format!("{shown}: cannot be listed: {e}"))?;
        let mut names = BTreeSet::new();
        for entry in listing {
            let entry = entry.map_err(|e| format!("{shown}: cannot be listed: {e}"))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let kind = entry.file_type();
            let kind = kind.map_err(|e| format!("{shown}{name}: {e}"))?;
            let mark = match (kind.is_dir(), kind.is_file()) {
                (true, _) => "/",
                (_, true) => "",
                _ => "?",
            };
            names.insert(format!("{name}{mark}"));
        }
        Ok(names)
    }

    // Whether the byte at `i`, if there is one, would continue a bare TOML key.
    fn continues_key(bytes: &[u8], i: Option<usize>) -> bool {
        let byte = i.and_then(|i| bytes.get(i));
        byte.is_some_and(|&b| is_name_byte(b))
    }

    // Whether `line` holds `key` as a whole TOML key, bare or quoted, rather than inside a
    // longer bare key (`dispatch` does not name `patch`).
    fn names_key(line: &str, key: &str) -> bool {
        let bytes = line.as_bytes();
        let whole = |at: usize| {
            let before = continues_key(bytes, at.checked_sub(1));
            !before && !continues_key(bytes, Some(at + key.len()))
        };
        line.match_indices(key).any(|(at, _)| whole(at))
    }

    // The path that a `--- a/<path>` line and the `+++ b/<path>` line after it both name.
    fn file_header(minus: &[u8], plus: Option<&[u8]>) -> Option<String> {
        let minus = std::str::from_utf8(minus).ok()?;
        let plus = std::str::from_utf8(plus?).ok()?;
        let path = minus.strip_prefix("--- a/")?.strip_suffix('\n')?;
        let same = plus.strip_prefix("+++ b/")?.strip_suffix('\n')? == path;
        same.then(|| path.to_string())
    }

    // Whether `lines[i]` starts a hunk (`@@`) or a file (a `--- ` line, then a `+++ ` line).
    // A cfg-only patch holds no changed line that could be read as either.
    fn starts_section(lines: &[&[u8]], i: usize) -> bool {
        let next_is_plus = lines.get(i + 1).is_some_and(|n| n.starts_with(b"+++ "));
        lines[i].starts_with(b"@@") || (lines[i].starts_with(b"--- ") && next_is_plus)
    }

    // `@@ -<start>,<count> +<start>,<count> @@` with nothing after it -> the four numbers.
    fn hunk_header(line: &[u8]) -> Option<(usize, usize, usize, usize)> {
        let line = std::str::from_utf8(line).ok()?;
        let ranges = line.strip_prefix("@@ -")?.strip_suffix(" @@\n")?;
        let (old, new) = ranges.split_once(" +")?;
        let (os, oc) = old.split_once(',')?;
        let (ns, nc) = new.split_once(',')?;
        Some((number(os)?, number(oc)?, number(ns)?, number(nc)?))
    }

    // One to nine decimal digits and nothing else (no sign).
    fn number(text: &str) -> Option<usize> {
        if text.is_empty() || text.len() > 9 || !text.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        text.parse().ok()
    }

    // The patch, parsed strictly. Per file: `--- a/<path>`, `+++ b/<path>` naming a file the
    // manifest holds, then its hunks, each body (up to the next hunk or file) exactly as long
    // as its header says; `undo` holds the hunks to ascending and apart. Any other line
    // (`\ No newline at end of file`, `diff `, `index `, a line with no `\n`) fails, and so
    // does a patch that changes no file.
    fn parse_patch(bytes: &[u8], pristine: &Pristine) -> Result<Vec<FilePatch>, String> {
        if bytes.last().is_some_and(|&b| b != b'\n') {
            return Err(format!("{PATCH}: its last line has no newline"));
        }
        let lines: Vec<&[u8]> = bytes.split_inclusive(|&b| b == b'\n').collect();
        let mut files: Vec<FilePatch> = Vec::new();
        let mut i = 0;
        while i < lines.len() {
            let at = i + 1;
            let Some(path) = file_header(lines[i], lines.get(i + 1).copied()) else {
                return Err(format!(
                    "{PATCH}:{at}: expected `--- a/<path>` then `+++ b/<path>`"
                ));
            };
            if !pristine.held.contains_key(&path) {
                return Err(format!("{PATCH}: `{path}` is not in {MANIFEST}"));
            }
            if files.iter().any(|file| file.path == path) {
                return Err(format!("{PATCH}: `{path}` has two file headers"));
            }
            i += 2;
            let mut hunks = Vec::new();
            while i < lines.len() && lines[i].starts_with(b"@@") {
                let at = i + 1;
                let header = String::from_utf8_lossy(lines[i]).trim_end().to_string();
                let Some((os, oc, ns, nc)) = hunk_header(lines[i]) else {
                    return Err(format!("{PATCH}:{at}: `{header}` is not a hunk header"));
                };
                i += 1;
                let mut body = Vec::new();
                while i < lines.len() && !starts_section(&lines, i) {
                    if !matches!(lines[i][0], b' ' | b'-' | b'+') {
                        let at = i + 1;
                        return Err(format!("{PATCH}:{at}: not a line of `{header}`"));
                    }
                    body.push((lines[i][0], lines[i][1..].to_vec()));
                    i += 1;
                }
                let old_count = body.iter().filter(|(kind, _)| *kind != b'+').count();
                let new_count = body.iter().filter(|(kind, _)| *kind != b'-').count();
                if (old_count, new_count) != (oc, nc) {
                    return Err(format!(
                        "{PATCH}:{at}: the line counts of `{header}` disagree with its body"
                    ));
                }
                hunks.push(Hunk {
                    header,
                    old_start: os,
                    new_start: ns,
                    body,
                });
            }
            if hunks.is_empty() {
                return Err(format!("{PATCH}: `{path}` has no hunk"));
            }
            files.push(FilePatch { path, hunks });
        }
        if files.is_empty() {
            return Err(format!("{PATCH}: changes no file"));
        }
        Ok(files)
    }

    // One side of a hunk, `\n` included: every body line but those of kind `skip`.
    fn side(hunk: &Hunk, skip: u8) -> Vec<&[u8]> {
        let lines = hunk.body.iter().filter(|(kind, _)| *kind != skip);
        lines.map(|(_, line)| line.as_slice()).collect()
    }

    // The file as published. Each hunk starts after the one before it on both sides; its new
    // side (context and `+` lines) must be the tree's lines from its new start, exactly, and
    // is replaced by its old side (context and `-`), which must land on its old start.
    fn undo(file: &FilePatch, tree: &[u8]) -> Result<Vec<u8>, String> {
        let lines: Vec<&[u8]> = tree.split_inclusive(|&b| b == b'\n').collect();
        let mut old: Vec<u8> = Vec::with_capacity(tree.len());
        let mut old_lines = 0;
        let mut next = 0;
        for hunk in &file.hunks {
            let at = format!("vendor/{} {}", file.path, hunk.header);
            let new_side = side(hunk, b'-');
            let start = hunk.new_start.saturating_sub(1);
            let end = start + new_side.len();
            if hunk.new_start == 0 || start < next {
                return Err(format!("{at}: starts at 0 or in the hunk before it"));
            }
            if lines.get(start..end) != Some(new_side.as_slice()) {
                let ns = hunk.new_start;
                return Err(format!(
                    "{at}: the file does not hold the hunk's new lines at line {ns}"
                ));
            }
            let kept = &lines[next..start];
            for line in kept {
                old.extend_from_slice(line);
            }
            old_lines += kept.len();
            if hunk.old_start != old_lines + 1 {
                return Err(format!(
                    "{at}: its old start is not the line its old side lands on"
                ));
            }
            let old_side = side(hunk, b'+');
            for line in &old_side {
                old.extend_from_slice(line);
            }
            old_lines += old_side.len();
            next = end;
        }
        for line in &lines[next..] {
            old.extend_from_slice(line);
        }
        Ok(old)
    }

    fn is_context(line: &(u8, Vec<u8>)) -> bool {
        line.0 == b' '
    }

    // The hunk changes at least one line, and each run of changed lines is k `-` lines then
    // k `+` lines, the i-th `-` paired with the i-th `+`, each pair one patched `#[cfg]`.
    fn check_shape(hunk: &Hunk) -> Result<(), String> {
        let body = &hunk.body;
        let mut pairs = 0;
        for run in body.chunk_by(|a, b| is_context(a) == is_context(b)) {
            if is_context(&run[0]) {
                continue;
            }
            let k = run.iter().take_while(|line| line.0 == b'-').count();
            let pluses = run[k..].iter().all(|line| line.0 == b'+');
            if k == 0 || run.len() != 2 * k || !pluses {
                return Err("a run is not k `-` then k `+` lines".to_string());
            }
            for (old, new) in run[..k].iter().zip(&run[k..]) {
                check_pair(&old.1, &new.1)?;
            }
            pairs += k;
        }
        if pairs == 0 {
            return Err("it changes no line".to_string());
        }
        Ok(())
    }

    // `-<ws>#[cfg(<A>)]` and `+<ws>#[cfg(<B>)] // monster-realm: was #[cfg(<A>)]`, the same
    // `<ws>`, nothing else on either line, and `<A>`, `<B>` cfg predicates that agree on wasm32.
    fn check_pair(old: &[u8], new: &[u8]) -> Result<(), String> {
        let (Ok(old), Ok(new)) = (std::str::from_utf8(old), std::str::from_utf8(new)) else {
            return Err("a changed line is not UTF-8".to_string());
        };
        let attr = old.trim_start_matches([' ', '\t']);
        let ws = &old[..old.len() - attr.len()];
        let original = attr
            .strip_prefix("#[cfg(")
            .and_then(|rest| rest.strip_suffix(")]\n"));
        let Some(original) = original else {
            return Err(format!("not one whole `#[cfg(...)]`: {old:?}"));
        };
        let notice = format!(")] // monster-realm: was #[cfg({original})]\n");
        let patched = new
            .strip_prefix(ws)
            .and_then(|rest| rest.strip_prefix("#[cfg("))
            .and_then(|rest| rest.strip_suffix(notice.as_str()));
        let Some(patched) = patched else {
            return Err(format!("not `#[cfg(...)]` and the notice: {new:?}"));
        };
        let Some(a) = parse_cfg(original) else {
            return Err(format!("`{original}`: not a cfg predicate"));
        };
        let Some(b) = parse_cfg(patched) else {
            return Err(format!("`{patched}`: not a cfg predicate"));
        };
        same_on_wasm(&a, &b).map_err(|e| format!("`{original}` became `{patched}`: {e}"))
    }

    fn skip_spaces(text: &str, at: &mut usize) {
        while text.as_bytes().get(*at) == Some(&b' ') {
            *at += 1;
        }
    }

    // Consumes `byte` after any spaces; false if it is not there.
    fn eat(text: &str, at: &mut usize, byte: u8) -> bool {
        skip_spaces(text, at);
        let found = text.as_bytes().get(*at) == Some(&byte);
        if found {
            *at += 1;
        }
        found
    }

    // Consumes the longest run of bytes `keep` accepts (all ASCII) and returns it.
    fn take<'t>(text: &'t str, at: &mut usize, keep: fn(u8) -> bool) -> &'t str {
        let start = *at;
        while text.as_bytes().get(*at).is_some_and(|&b| keep(b)) {
            *at += 1;
        }
        &text[start..*at]
    }

    // `all(…)` / `any(…)` over comma-separated predicates (none allowed), `not(…)` over
    // exactly one, `target_arch = "…"` or `feature = "…"` over `[A-Za-z0-9_-]*`, spaces allowed
    // between tokens. Anything else, an unbalanced paren or a `]` included, is `None`.
    fn parse_predicate(text: &str, at: &mut usize, depth: usize) -> Option<Cfg> {
        if depth > 8 {
            return None;
        }
        skip_spaces(text, at);
        let key = take(text, at, |b| b.is_ascii_lowercase() || b == b'_');
        match key {
            "all" | "any" | "not" => {
                if !eat(text, at, b'(') {
                    return None;
                }
                let mut list = Vec::new();
                if !eat(text, at, b')') {
                    loop {
                        list.push(parse_predicate(text, at, depth + 1)?);
                        if eat(text, at, b')') {
                            break;
                        }
                        if !eat(text, at, b',') {
                            return None;
                        }
                    }
                }
                match key {
                    "all" => Some(Cfg::All(list)),
                    "any" => Some(Cfg::Any(list)),
                    _ if list.len() == 1 => list.pop().map(|one| Cfg::Not(Box::new(one))),
                    _ => None,
                }
            }
            "target_arch" | "feature" => {
                if !eat(text, at, b'=') || !eat(text, at, b'"') {
                    return None;
                }
                let value = take(text, at, is_name_byte).to_string();
                if text.as_bytes().get(*at) != Some(&b'"') {
                    return None;
                }
                *at += 1;
                if key == "feature" {
                    Some(Cfg::Feature(value))
                } else {
                    Some(Cfg::TargetArch(value))
                }
            }
            _ => None,
        }
    }

    // The whole of `text` as one predicate, or `None`.
    fn parse_cfg(text: &str) -> Option<Cfg> {
        let mut at = 0;
        let cfg = parse_predicate(text, &mut at, 0)?;
        skip_spaces(text, &mut at);
        (at == text.len()).then_some(cfg)
    }

    // `a` and `b` agree on wasm32 under every on/off assignment of the features either names.
    fn same_on_wasm(a: &Cfg, b: &Cfg) -> Result<(), String> {
        let mut names = BTreeSet::new();
        a.features(&mut names);
        b.features(&mut names);
        let names: Vec<&str> = names.into_iter().collect();
        let count = names.len();
        if count > 12 {
            return Err(format!("{count} features: too many to enumerate"));
        }
        let assignments = 1u32 << count;
        for mask in 0..assignments {
            let on: BTreeSet<&str> = names
                .iter()
                .enumerate()
                .filter(|&(bit, _)| (mask >> bit) & 1 == 1)
                .map(|(_, name)| *name)
                .collect();
            if a.on_wasm(&on) != b.on_wasm(&on) {
                return Err(format!("on wasm32 with features {on:?}, they differ"));
            }
        }
        Ok(())
    }

    // Lowercase hex of the sha256 of `bytes`.
    fn sha256_hex(bytes: &[u8]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let digest = Sha256::digest(bytes);
        let mut hex = String::with_capacity(64);
        for &byte in &digest[..] {
            hex.push(char::from(HEX[usize::from(byte >> 4)]));
            hex.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
        hex
    }

    // The lines of a TOML table: from the line after `header` to the next table header.
    fn table<'t>(text: &'t str, header: &'t str) -> impl Iterator<Item = &'t str> {
        let mut lines = text.split('\n');
        for line in lines.by_ref() {
            if line == header {
                break;
            }
        }
        lines.take_while(|line| !line.trim_start().starts_with('['))
    }

    // The key of a `key = value` line (trimmed), or "".
    fn toml_key(line: &str) -> &str {
        line.split_once('=').map_or("", |(key, _)| key.trim())
    }

    // The version in a cargo-normalised manifest: the first line of its `[package]` table
    // that sets `version`, which must be `version = "<v>"`.
    fn package_version(manifest: &str) -> Option<&str> {
        let line = table(manifest, "[package]").find(|line| line.starts_with("version"))?;
        line.strip_prefix("version = \"")?.strip_suffix('"')
    }

    // The manifest parses, and every path it names is inside a crate it declares.
    let pristine = parse_pristine(&read_text(vendor, "PRISTINE.sha256")?)?;
    for path in pristine.held.keys().chain(&pristine.omitted) {
        if !pristine.crates.contains_key(crate_of(path)) {
            return Err(format!("{MANIFEST}: `{path}` is in no declared crate"));
        }
    }

    // Each copy holds exactly the files the manifest lists for it, every one a regular file,
    // and none it marks omitted.
    for name in pristine.crates.keys() {
        let dir = std::fs::symlink_metadata(vendor.join(name));
        if !dir.is_ok_and(|dir| dir.is_dir()) {
            return Err(format!("vendor/{name}: not a directory"));
        }
        let mut found = BTreeSet::new();
        walk(vendor, name, &mut found)?;
        let listed: BTreeSet<String> = pristine
            .held
            .keys()
            .filter(|path| crate_of(path) == name.as_str())
            .cloned()
            .collect();
        if found != listed {
            let unlisted: Vec<&String> = found.difference(&listed).collect();
            let missing: Vec<&String> = listed.difference(&found).collect();
            return Err(format!(
                "vendor/{name}: unlisted {unlisted:?}, missing {missing:?}"
            ));
        }
    }
    for path in &pristine.omitted {
        if std::fs::symlink_metadata(vendor.join(path)).is_ok() {
            return Err(format!("vendor/{path}: omitted, yet present"));
        }
    }

    // The patch parses strictly and changes only files the manifest lists.
    let patch = parse_patch(&read(vendor, "native-host.patch")?, &pristine)?;

    // Undone hunk by hunk, strictly, each patched file is back to its published bytes, and
    // each hunk is runs of `#[cfg]` pairs, each selecting on wasm32 what its original did.
    let mut restored: BTreeMap<&str, Vec<u8>> = BTreeMap::new();
    for file in &patch {
        let tree = read(vendor, &file.path)?;
        restored.insert(file.path.as_str(), undo(file, &tree)?);
        for hunk in &file.hunks {
            let at = format!("vendor/{} {}", file.path, hunk.header);
            check_shape(hunk).map_err(|e| format!("{at}: {e}"))?;
        }
    }

    // Every held file, with the patch undone where it applies, hashes to its manifest line.
    for (path, want) in &pristine.held {
        let bytes = match restored.remove(path.as_str()) {
            Some(bytes) => bytes,
            None => read(vendor, path)?,
        };
        let got = sha256_hex(&bytes);
        if got != *want {
            return Err(format!(
                "vendor/{path}: sha256 {got}, but {MANIFEST} records {want}"
            ));
        }
    }

    // One version: every `crate` line names the same one (the crates move together), each
    // copy's `[package]` has it, and the workspace pins `spacetimedb` to exactly it, in the one
    // line that also turns on the crate's `unstable` feature.
    let versions: BTreeSet<&str> = pristine.crates.values().map(String::as_str).collect();
    if versions.len() != 1 {
        return Err(format!("{MANIFEST}: versions {versions:?}, not one"));
    }
    for (name, version) in &pristine.crates {
        let rel = format!("{name}/Cargo.toml");
        let manifest = read_text(vendor, &rel)?;
        if package_version(&manifest) != Some(version.as_str()) {
            return Err(format!("vendor/{rel}: the package is not {version}"));
        }
    }
    let Some(version) = pristine.crates.get("spacetimedb") else {
        return Err(format!("{MANIFEST}: declares no crate `spacetimedb`"));
    };
    let pin = format!("spacetimedb = {{ version = \"={version}\", features = [\"unstable\"] }}");
    let pins: Vec<&str> = table(root_manifest, "[workspace.dependencies]")
        .filter(|line| toml_key(line) == "spacetimedb")
        .collect();
    if pins != [pin.as_str()] {
        return Err(format!(
            "Cargo.toml [workspace.dependencies]: {pins:?}, not exactly [{pin:?}]"
        ));
    }

    // What cargo builds is what this guard covers: the crates are the two the native host
    // patches; `vendor/` holds their directories and the three files beside them; `.cargo/`
    // holds no cargo config; and the root manifest has one patch table, `[patch.crates-io]`,
    // which points each crate at its copy and names nothing else.
    let names: Vec<&str> = pristine.crates.keys().map(String::as_str).collect();
    if names != CRATES {
        return Err(format!("{MANIFEST}: crates {names:?}, not {CRATES:?}"));
    }
    let expected: BTreeSet<String> = names
        .iter()
        .map(|name| format!("{name}/"))
        .chain(TOP_FILES.map(String::from))
        .collect();
    let top = entries(vendor, "vendor/")?;
    if top != expected {
        return Err(format!(
            "vendor/ holds {top:?}, not {expected:?} (`/` is a directory)"
        ));
    }
    let root = vendor.parent().ok_or("vendor/ has no parent directory")?;
    let dot_cargo = entries(&root.join(".cargo"), ".cargo/")?;
    if dot_cargo != BTreeSet::from(["mutants.toml".to_string()]) {
        return Err(format!(
            ".cargo/ holds {dot_cargo:?}, not only the file mutants.toml: a cargo config there \
             could patch or wrap the build behind the guard's back"
        ));
    }
    let mut patch_tables = 0;
    for (index, line) in root_manifest.split('\n').enumerate() {
        let at = index + 1;
        if line.contains("'''") || line.contains("\"\"\"") || line.contains('\\') {
            return Err(format!(
                "Cargo.toml:{at}: a multi-line string or a `\\` could hide a patch table"
            ));
        }
        if line.trim_start().starts_with('#') {
            continue;
        }
        if names_key(line, "replace") {
            return Err(format!(
                "Cargo.toml:{at}: `{line}` names `replace`, a source override like `[patch]`"
            ));
        }
        if !names_key(line, "patch") {
            continue;
        }
        if line.trim() != "[patch.crates-io]" {
            return Err(format!(
                "Cargo.toml:{at}: `{line}` names `patch` and is not `[patch.crates-io]`"
            ));
        }
        patch_tables += 1;
    }
    if patch_tables != 1 {
        return Err(format!(
            "Cargo.toml: {patch_tables} `[patch.crates-io]` lines, not exactly one"
        ));
    }
    let entry = |name: &&str| format!("{name} = {{ path = \"vendor/{name}\" }}");
    let mut want: Vec<String> = names.iter().map(entry).collect();
    want.sort_unstable();
    let mut got: Vec<&str> = table(root_manifest, "[patch.crates-io]")
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect();
    got.sort_unstable();
    if got != want {
        return Err(format!(
            "Cargo.toml [patch.crates-io]: {got:?}, not exactly {want:?}"
        ));
    }
    Ok(())
}

/// Running a procedure on this host: stubbed HTTP answers, recorded requests, transactions that
/// commit or roll back, rows changed during a wait, and the caller and clock a procedure sees.
mod procedure_tests {
    use super::*;
    use spacetimedb::http::{Error as HttpError, Request, Response, Timeout};
    use spacetimedb::sys;
    use spacetimedb::{ProcedureContext, TimeDuration};
    use std::io::ErrorKind;
    use std::net::TcpListener;

    /// The scratch table every test here seeds and its procedures write: bare `u64` rows.
    const TABLE: &str = "nh_proc_rows";

    /// What a procedure saw of one HTTP request: the status and body bytes, or the error text.
    type Outcome = Result<(u16, Vec<u8>), String>;

    fn me() -> Identity {
        Identity::from_byte_array([7u8; 32])
    }

    fn at() -> Timestamp {
        Timestamp::from_micros_since_unix_epoch(1_700_000_000_000_000)
    }

    fn proc_rows(fx: &Fixture) -> Handle<'_, u64, u64> {
        fx.table_keyed::<u64, u64>(TABLE, "id", |r| *r)
            .writable()
            .scannable()
    }

    /// A second scratch table of bare `u64` rows, for transactions that write two tables.
    const OTHER: &str = "nh_proc_other";

    fn other_rows(fx: &Fixture) -> Handle<'_, u64, u64> {
        fx.table_keyed::<u64, u64>(OTHER, "id", |r| *r)
            .writable()
            .scannable()
    }

    /// An identity whose 32 bytes all differ: `first`, `first + 1`, ... `first + 31`.
    fn distinct_identity(first: u8) -> Identity {
        Identity::from_byte_array(std::array::from_fn(|i| {
            first.wrapping_add(u8::try_from(i).expect("an identity byte index fits a u8"))
        }))
    }

    /// Inserts `n` into the scratch table through the insert syscall.
    fn insert(n: u64) {
        insert_into(TABLE, n);
    }

    /// Inserts `n` into the table named `name` through the insert syscall.
    fn insert_into(name: &str, n: u64) {
        let table = sys::table_id_from_name(name).expect("the scratch table resolves");
        let mut row = bsatn::to_vec(&n).expect("a u64 row encodes");
        sys::datastore_insert_bsatn(table, &mut row).expect("the insert succeeds");
    }

    /// Deletes every row equal to `n`; returns how many went.
    fn delete(n: u64) -> u32 {
        delete_from(TABLE, n)
    }

    /// Deletes every row equal to `n` from the table named `name`; returns how many went.
    fn delete_from(name: &str, n: u64) -> u32 {
        let table = sys::table_id_from_name(name).expect("the scratch table resolves");
        let relation = bsatn::to_vec(&vec![n]).expect("the relation encodes");
        sys::datastore_delete_all_by_eq_bsatn(table, &relation).expect("the delete succeeds")
    }

    /// Empties the scratch table; returns how many rows went.
    fn clear() -> u64 {
        let table = sys::table_id_from_name(TABLE).expect("the scratch table resolves");
        sys::datastore_clear(table).expect("the clear succeeds")
    }

    /// Every row of the scratch table, in store order, through a full-table scan.
    fn scan() -> Vec<u64> {
        scan_of(TABLE)
    }

    /// Every row of the table named `name`, in store order, through a full-table scan.
    fn scan_of(name: &str) -> Vec<u64> {
        let table = sys::table_id_from_name(name).expect("the scratch table resolves");
        let mut iter = sys::datastore_table_scan_bsatn(table).expect("the scan opens");
        let mut buf = Vec::new();
        while !iter.is_exhausted() {
            iter.read(&mut buf);
        }
        buf.as_chunks::<8>()
            .0
            .iter()
            .map(|c| u64::from_le_bytes(*c))
            .collect()
    }

    fn build(
        method: &str,
        uri: &str,
        body: Vec<u8>,
        timeout: Option<TimeDuration>,
    ) -> Request<Vec<u8>> {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(t) = timeout {
            builder = builder.extension(Timeout::from(t));
        }
        builder.body(body).expect("the request builds")
    }

    fn outcome(sent: Result<Response, HttpError>) -> Outcome {
        sent.map(|response| {
            let (parts, body) = response.into_parts();
            (parts.status.as_u16(), body.into_bytes().to_vec())
        })
        .map_err(|e| e.to_string())
    }

    fn panic_text(payload: Box<dyn std::any::Any + Send>) -> String {
        if let Some(s) = payload.downcast_ref::<String>() {
            return s.clone();
        }
        if let Some(s) = payload.downcast_ref::<&'static str>() {
            return (*s).to_string();
        }
        "<a panic payload that is not text>".to_string()
    }

    /// A test-only procedure: reads the table, waits on one GET, reads the table again.
    fn read_wait_read(ctx: &mut ProcedureContext) -> (Vec<u64>, Outcome, Vec<u64>) {
        let before = ctx.with_tx(|_tx| scan());
        let answer = outcome(ctx.http.get("https://accounts.invalid/wait"));
        let after = ctx.with_tx(|_tx| scan());
        (before, answer, after)
    }

    #[test]
    fn stubbed_answers_reach_the_procedure_in_order_with_their_exact_bodies_lpw41_1() {
        let fx = fixture();
        let mut http = HttpQueue::new();
        http.push(HttpAnswer::status(200, "first"))
            .push(HttpAnswer::status(404, Vec::<u8>::new()))
            .push(HttpAnswer::status(201, vec![0u8, 255, 7]));
        let got = fx.run_procedure(Caller::Sender(me()), at(), &mut http, |ctx| {
            vec![
                outcome(ctx.http.get("https://accounts.invalid/one")),
                outcome(ctx.http.send(build(
                    "POST",
                    "https://accounts.invalid/two",
                    b"2".to_vec(),
                    None,
                ))),
                outcome(ctx.http.get("https://accounts.invalid/three")),
            ]
        });
        assert_eq!(
            got,
            vec![
                Ok((200, b"first".to_vec())),
                Ok((404, Vec::new())),
                Ok((201, vec![0u8, 255, 7])),
            ],
            "each request gets the next stubbed status and exactly its body bytes"
        );
    }

    #[test]
    fn a_stubbed_error_reaches_the_procedure_as_err_with_its_text_lpw41_1() {
        let fx = fixture();
        let mut http = HttpQueue::new();
        http.push(HttpAnswer::error("the stub refused the connection"))
            .push(HttpAnswer::status(200, "after"));
        let got = fx.run_procedure(Caller::Sender(me()), at(), &mut http, |ctx| {
            (
                outcome(ctx.http.get("https://accounts.invalid/down")),
                outcome(ctx.http.get("https://accounts.invalid/up")),
            )
        });
        assert_eq!(
            got,
            (
                Err("the stub refused the connection".to_string()),
                Ok((200, b"after".to_vec())),
            ),
            "a stubbed error is an Err with exactly its text, and the next answer follows it"
        );
    }

    #[test]
    fn each_sent_request_is_recorded_with_its_method_url_body_and_timeout_lpw41_1() {
        let fx = fixture();
        let mut http = HttpQueue::new();
        http.push(HttpAnswer::status(200, "a"))
            .push(HttpAnswer::status(202, "b"))
            .push(HttpAnswer::status(204, Vec::<u8>::new()));
        let first = fx.run_procedure(Caller::Sender(me()), at(), &mut http, |ctx| {
            (
                outcome(ctx.http.send(build(
                    "POST",
                    "https://accounts.invalid/redeem?ticket=abc",
                    b"hello".to_vec(),
                    Some(TimeDuration::from_micros(3_000_000)),
                ))),
                outcome(ctx.http.send(build(
                    "PATCH",
                    "https://accounts.invalid/patch",
                    Vec::new(),
                    Some(TimeDuration::from_micros(250_000)),
                ))),
            )
        });
        let second = fx.run_procedure(Caller::Database, at(), &mut http, |ctx| {
            outcome(ctx.http.get("https://accounts.invalid/status"))
        });
        assert_eq!(
            first,
            (Ok((200, b"a".to_vec())), Ok((202, b"b".to_vec()))),
            "the first run's requests got their stubbed answers"
        );
        assert_eq!(
            second,
            Ok((204, Vec::new())),
            "the second run's request got the next stubbed answer"
        );
        assert_eq!(
            http.requests(),
            &[
                SentRequest {
                    method: "POST".to_string(),
                    url: "https://accounts.invalid/redeem?ticket=abc".to_string(),
                    body: b"hello".to_vec(),
                    timeout: Some(TimeDuration::from_micros(3_000_000)),
                },
                SentRequest {
                    method: "PATCH".to_string(),
                    url: "https://accounts.invalid/patch".to_string(),
                    body: Vec::new(),
                    timeout: Some(TimeDuration::from_micros(250_000)),
                },
                SentRequest {
                    method: "GET".to_string(),
                    url: "https://accounts.invalid/status".to_string(),
                    body: Vec::new(),
                    timeout: None,
                },
            ][..],
            "the record holds every request of both runs, oldest first, as sent"
        );
    }

    #[test]
    fn a_request_to_a_listening_local_port_gets_the_stub_and_opens_no_socket_lpw41_1() {
        let fx = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").expect("a local port binds");
        listener
            .set_nonblocking(true)
            .expect("the listener goes non-blocking");
        let port = listener.local_addr().expect("the bound address").port();
        let url = format!("http://127.0.0.1:{port}/probe");
        let mut http = HttpQueue::new();
        http.push(HttpAnswer::status(200, "stubbed"));
        let got = fx.run_procedure(Caller::Sender(me()), at(), &mut http, |ctx| {
            outcome(ctx.http.get(url.as_str()))
        });
        assert_eq!(
            got,
            Ok((200, b"stubbed".to_vec())),
            "the stubbed answer reached the procedure"
        );
        match listener.accept() {
            Err(e) => assert_eq!(
                e.kind(),
                ErrorKind::WouldBlock,
                "nothing connected to the listener"
            ),
            Ok((_, peer)) => panic!("a connection from {peer} reached the listener"),
        }
        assert_eq!(
            http.requests()
                .iter()
                .map(|r| r.url.clone())
                .collect::<Vec<_>>(),
            vec![url],
            "the request is recorded with the local URL"
        );
    }

    #[test]
    fn a_request_with_no_answer_left_fails_the_run_when_the_procedure_returns_the_error_lpw41_2() {
        let fx = fixture();
        let mut http = HttpQueue::new();
        let seen: RefCell<Option<String>> = RefCell::new(None);
        let caught = catch_unwind(AssertUnwindSafe(|| {
            fx.run_procedure(Caller::Sender(me()), at(), &mut http, |ctx| {
                let sent = ctx.http.send(build(
                    "POST",
                    "https://accounts.invalid/redeem",
                    b"t".to_vec(),
                    None,
                ));
                let text = sent.map(|_| ()).map_err(|e| e.to_string());
                *seen.borrow_mut() = text.clone().err();
                text
            })
        }));
        let text = panic_text(caught.expect_err("a request with no answer left fails the run"));
        assert!(
            text.contains(
                "the procedure sent `POST https://accounts.invalid/redeem` with no stubbed HTTP answer left"
            ),
            "the failure names the request and says no answer is left: {text}"
        );
        let seen = seen
            .into_inner()
            .expect("the procedure got an Err for the request");
        assert!(
            seen.contains("no stubbed HTTP answer left"),
            "the procedure's own Err says no answer is left: {seen}"
        );
        assert_eq!(
            http.requests(),
            &[SentRequest {
                method: "POST".to_string(),
                url: "https://accounts.invalid/redeem".to_string(),
                body: b"t".to_vec(),
                timeout: None,
            }][..],
            "the unanswered request is recorded"
        );
    }

    #[test]
    fn a_request_with_no_answer_left_fails_the_run_when_the_procedure_swallows_the_error_lpw41_2() {
        let fx = fixture();
        let mut http = HttpQueue::new();
        let caught = catch_unwind(AssertUnwindSafe(|| {
            fx.run_procedure(Caller::Database, at(), &mut http, |ctx| {
                let swallowed = ctx
                    .http
                    .send(build(
                        "POST",
                        "https://accounts.invalid/quiet",
                        Vec::new(),
                        None,
                    ))
                    .is_err();
                u32::from(swallowed) + 41
            })
        }));
        let text = panic_text(
            caught.expect_err("a swallowed request with no answer left still fails the run"),
        );
        assert!(
            text.contains(
                "the procedure sent `POST https://accounts.invalid/quiet` with no stubbed HTTP answer left"
            ),
            "the failure names the request and says no answer is left: {text}"
        );
        assert_eq!(
            http.requests()
                .iter()
                .map(|r| r.url.clone())
                .collect::<Vec<_>>(),
            vec!["https://accounts.invalid/quiet".to_string()],
            "the unanswered request is recorded"
        );
    }

    #[test]
    fn a_second_request_after_the_only_answer_fails_the_run_lpw41_2() {
        let fx = fixture();
        let mut http = HttpQueue::new();
        http.push(HttpAnswer::status(200, "only"));
        let seen: RefCell<Option<(Outcome, Outcome)>> = RefCell::new(None);
        let caught = catch_unwind(AssertUnwindSafe(|| {
            fx.run_procedure(Caller::Sender(me()), at(), &mut http, |ctx| {
                let first = outcome(ctx.http.get("https://accounts.invalid/first"));
                let second = outcome(ctx.http.send(build(
                    "POST",
                    "https://accounts.invalid/second",
                    b"two".to_vec(),
                    None,
                )));
                *seen.borrow_mut() = Some((first, second));
            })
        }));
        let text = panic_text(caught.expect_err("the second request found no answer left"));
        assert!(
            text.contains(
                "the procedure sent `POST https://accounts.invalid/second` with no stubbed HTTP answer left"
            ),
            "the failure names the second request: {text}"
        );
        let (first, second) = seen.into_inner().expect("the procedure ran to its end");
        assert_eq!(
            first,
            Ok((200, b"only".to_vec())),
            "the first request got the one answer"
        );
        let second = second.expect_err("the second request got an Err");
        assert!(
            second.contains("no stubbed HTTP answer left"),
            "the second request's Err says no answer is left: {second}"
        );
        assert_eq!(
            http.requests()
                .iter()
                .map(|r| r.url.clone())
                .collect::<Vec<_>>(),
            vec![
                "https://accounts.invalid/first".to_string(),
                "https://accounts.invalid/second".to_string(),
            ],
            "both requests are recorded, the unanswered one included"
        );
    }

    #[test]
    fn a_transaction_body_that_returns_keeps_its_writes_lpw41_3() {
        let fx = fixture();
        let rows = proc_rows(&fx);
        rows.seed(&1);
        let mut http = HttpQueue::new();
        let (inside, tried, next) =
            fx.run_procedure(Caller::Sender(me()), at(), &mut http, |ctx| {
                let inside = ctx.with_tx(|_tx| {
                    insert(2);
                    let removed = delete(1);
                    (removed, scan())
                });
                let tried = ctx.try_with_tx(|_tx| -> Result<Vec<u64>, String> {
                    insert(3);
                    Ok(scan())
                });
                let next = ctx.with_tx(|_tx| scan());
                (inside, tried, next)
            });
        assert_eq!(
            inside,
            (1, vec![2]),
            "the with_tx body inserted and deleted"
        );
        assert_eq!(
            tried,
            Ok(vec![2, 3]),
            "the try_with_tx body saw the earlier commit and its own insert"
        );
        assert_eq!(next, vec![2, 3], "the next transaction sees both commits");
        assert_eq!(rows.rows(), vec![2, 3], "the store keeps both commits");
        let later = fx.run_procedure(Caller::Sender(me()), at(), &mut http, |ctx| {
            ctx.with_tx(|_tx| scan())
        });
        assert_eq!(later, vec![2, 3], "the next run sees both commits");
    }

    #[test]
    fn a_try_with_tx_body_that_returns_err_keeps_none_of_its_writes_lpw41_3() {
        let fx = fixture();
        let rows = proc_rows(&fx);
        rows.seed(&10);
        rows.seed(&20);
        let mut http = HttpQueue::new();
        let (aborted, next) = fx.run_procedure(Caller::Sender(me()), at(), &mut http, |ctx| {
            ctx.with_tx(|_tx| insert(30));
            let aborted = ctx.try_with_tx(|_tx| -> Result<(), (u32, Vec<u64>, u32)> {
                insert(40);
                let removed = delete(10);
                Err((removed, scan(), fx.writes_to(TABLE)))
            });
            let next = ctx.with_tx(|_tx| scan());
            (aborted, next)
        });
        assert_eq!(
            aborted,
            Err((1, vec![20, 30, 40], 3)),
            "the body ran: it deleted a seeded row, saw its own insert, and its Err came back"
        );
        assert_eq!(
            next,
            vec![10, 20, 30],
            "the next transaction sees the earlier commit and none of the aborted writes"
        );
        assert_eq!(
            rows.rows(),
            vec![10, 20, 30],
            "the store holds the seeded rows and the earlier commit, the deleted row back"
        );
        assert_eq!(
            fx.writes_to(TABLE),
            1,
            "the write count is back at what it read when the aborted transaction started"
        );
    }

    #[test]
    fn a_transaction_body_that_panics_keeps_none_of_its_writes_lpw41_3() {
        let fx = fixture();
        let rows = proc_rows(&fx);
        rows.seed(&5);
        rows.seed(&6);
        let mut http = HttpQueue::new();
        let caught = catch_unwind(AssertUnwindSafe(|| {
            fx.run_procedure(Caller::Sender(me()), at(), &mut http, |ctx| {
                ctx.with_tx(|_tx| insert(7));
                ctx.with_tx(|_tx| {
                    insert(8);
                    let cleared = clear();
                    insert(9);
                    let seen = scan();
                    if !seen.is_empty() {
                        panic!("rolled-back body cleared {cleared} and saw {seen:?}");
                    }
                    seen.len()
                })
            })
        }));
        let text = panic_text(caught.expect_err("the body's panic reaches the test"));
        assert_eq!(
            text, "rolled-back body cleared 4 and saw [9]",
            "the panic that reaches the test is the body's own, after its clear and inserts"
        );
        assert_eq!(
            rows.rows(),
            vec![5, 6, 7],
            "the store holds the seeded rows and the earlier commit, none of the panicked writes"
        );
        assert_eq!(
            fx.writes_to(TABLE),
            1,
            "the write count is back at what it read when the panicked transaction started"
        );
        let mut again = HttpQueue::new();
        let later = fx.run_procedure(Caller::Sender(me()), at(), &mut again, |ctx| {
            ctx.with_tx(|_tx| scan())
        });
        assert_eq!(later, vec![5, 6, 7], "the next run sees the same rows");
    }

    #[test]
    fn a_row_changed_while_the_procedure_waits_is_what_its_next_transaction_reads_lpw41_4() {
        let fx = fixture();
        let rows = proc_rows(&fx);
        rows.seed(&100);
        let mut http = HttpQueue::new();
        http.push(HttpAnswer::status(200, "ok").while_waiting(|| {
            assert_eq!(rows.remove(100), 1, "the wait removes the seeded row");
            rows.seed(&200);
        }));
        let (before, answer, after) =
            fx.run_procedure(Caller::Sender(me()), at(), &mut http, read_wait_read);
        assert_eq!(
            before,
            vec![100],
            "the first transaction reads the seeded row"
        );
        assert_eq!(
            answer,
            Ok((200, b"ok".to_vec())),
            "the answer arrived after the wait"
        );
        assert_eq!(
            after,
            vec![200],
            "the next transaction reads the row the test changed during the wait"
        );
    }

    #[test]
    fn a_row_left_alone_while_the_procedure_waits_reads_the_same_in_its_next_transaction_lpw41_4() {
        let fx = fixture();
        let rows = proc_rows(&fx);
        rows.seed(&100);
        let mut http = HttpQueue::new();
        http.push(HttpAnswer::status(200, "ok"));
        let (before, answer, after) =
            fx.run_procedure(Caller::Sender(me()), at(), &mut http, read_wait_read);
        assert_eq!(
            before,
            vec![100],
            "the first transaction reads the seeded row"
        );
        assert_eq!(answer, Ok((200, b"ok".to_vec())), "the answer arrived");
        assert_eq!(
            after, before,
            "with no change during the wait the second read equals the first"
        );
        assert_eq!(rows.rows(), vec![100], "the store is unchanged");
    }

    #[test]
    fn run_procedure_as_a_sender_lands_the_sender_and_the_time() {
        let fx = fixture();
        let mut http = HttpQueue::new();
        let (sender, module, connection, stamp, tx_stamps) =
            fx.run_procedure(Caller::Sender(me()), at(), &mut http, |ctx| {
                let first = ctx.with_tx(|tx| tx.timestamp);
                let second = ctx.with_tx(|tx| tx.timestamp);
                (
                    ctx.sender(),
                    ctx.database_identity(),
                    ctx.connection_id(),
                    ctx.timestamp,
                    (first, second),
                )
            });
        assert_eq!(sender, me(), "the sender is the chosen identity");
        assert_eq!(module, Identity::from_byte_array(DEFAULT_DATABASE_IDENTITY));
        assert!(connection.is_none(), "a procedure run has no connection id");
        assert_eq!(stamp, at(), "the procedure's timestamp is the chosen time");
        assert_eq!(
            tx_stamps,
            (at(), at()),
            "each transaction reads the chosen time"
        );
    }

    #[test]
    fn run_procedure_as_the_database_makes_the_sender_the_database_identity() {
        let fx = fixture();
        let mut http = HttpQueue::new();
        let probe = |ctx: &mut ProcedureContext| {
            let tx_stamp = ctx.with_tx(|tx| tx.timestamp);
            (
                ctx.sender(),
                ctx.database_identity(),
                ctx.connection_id().is_none(),
                ctx.timestamp,
                tx_stamp,
            )
        };
        let default_module = Identity::from_byte_array(DEFAULT_DATABASE_IDENTITY);
        assert_eq!(
            fx.run_procedure(Caller::Database, at(), &mut http, probe),
            (default_module, default_module, true, at(), at()),
            "the database caller is the default module identity"
        );
        let other = Identity::from_byte_array([8u8; 32]);
        fx.set_database_identity(other);
        assert_eq!(
            fx.run_procedure(Caller::Database, at(), &mut http, probe),
            (other, other, true, at(), at()),
            "the database caller follows set_database_identity"
        );
    }

    #[test]
    fn a_panic_inside_while_waiting_fails_the_caller_with_its_own_payload() {
        let fx = fixture();
        let rows = proc_rows(&fx);
        let mut http = HttpQueue::new();
        http.push(HttpAnswer::status(200, "unused").while_waiting(|| {
            rows.seed(&77);
            panic!("the wait's own check failed on row 77");
        }));
        let caught = catch_unwind(AssertUnwindSafe(|| {
            fx.run_procedure(Caller::Sender(me()), at(), &mut http, |ctx| {
                let swallowed = ctx.http.get("https://accounts.invalid/wait").is_ok();
                u32::from(swallowed)
            })
        }));
        let text = panic_text(caught.expect_err("the closure's panic fails the run"));
        assert_eq!(
            text, "the wait's own check failed on row 77",
            "the panic that reaches the test is the closure's own"
        );
        assert_eq!(
            rows.rows(),
            vec![77],
            "the closure ran: the row it seeded before panicking is in the store"
        );
        assert_eq!(
            http.requests(),
            &[SentRequest {
                method: "GET".to_string(),
                url: "https://accounts.invalid/wait".to_string(),
                body: Vec::new(),
                timeout: None,
            }][..],
            "the request whose wait panicked is recorded"
        );
        let mut again = HttpQueue::new();
        again.push(HttpAnswer::status(200, "next"));
        let later = fx.run_procedure(Caller::Sender(me()), at(), &mut again, |ctx| {
            let answer = outcome(ctx.http.get("https://accounts.invalid/next"));
            (answer, ctx.with_tx(|_tx| scan()))
        });
        assert_eq!(
            later,
            (Ok((200, b"next".to_vec())), vec![77]),
            "a following run on the same fixture gets its answer and reads the store normally"
        );
    }

    #[test]
    fn a_panic_inside_while_waiting_wins_over_the_body_panic_it_causes() {
        let fx = fixture();
        let mut http = HttpQueue::new();
        http.push(HttpAnswer::status(200, "unused").while_waiting(|| {
            panic!("the wait's check failed before the body's");
        }));
        let caught = catch_unwind(AssertUnwindSafe(|| {
            fx.run_procedure(Caller::Sender(me()), at(), &mut http, |ctx| -> u32 {
                let reply = ctx.http.get("https://accounts.invalid/wait-then-panic");
                panic!("the body panics on its reply, ok = {}", reply.is_ok())
            })
        }));
        let text = panic_text(caught.expect_err("the run fails"));
        assert_eq!(
            text, "the wait's check failed before the body's",
            "the closure's panic reaches the test ahead of the body's own"
        );
        assert_eq!(
            http.requests()
                .iter()
                .map(|r| r.url.clone())
                .collect::<Vec<_>>(),
            vec!["https://accounts.invalid/wait-then-panic".to_string()],
            "the request whose wait panicked is recorded"
        );
    }

    #[test]
    fn run_procedure_hands_over_every_byte_of_the_sender_and_the_database_identity() {
        let fx = fixture();
        let mut http = HttpQueue::new();
        let client = distinct_identity(1);
        let module = distinct_identity(101);
        fx.set_database_identity(module);
        let ids = |ctx: &mut ProcedureContext| {
            (
                ctx.sender().to_byte_array(),
                ctx.database_identity().to_byte_array(),
            )
        };
        assert_eq!(
            fx.run_procedure(Caller::Sender(client), at(), &mut http, ids),
            (client.to_byte_array(), module.to_byte_array()),
            "a client sender and the module identity arrive byte for byte"
        );
        assert_eq!(
            fx.run_procedure(Caller::Database, at(), &mut http, ids),
            (module.to_byte_array(), module.to_byte_array()),
            "the database sender is the module identity byte for byte"
        );
    }

    #[test]
    fn a_large_body_travels_both_ways_byte_for_byte_lpw41_1() {
        let fx = fixture();
        let big: Vec<u8> = (0u32..200_000)
            .map(|i| ((i % 251) ^ (i / 251)).to_le_bytes()[0])
            .collect();
        let mut http = HttpQueue::new();
        http.push(HttpAnswer::status(200, big.clone()));
        let got = fx.run_procedure(Caller::Sender(me()), at(), &mut http, |ctx| {
            outcome(ctx.http.send(build(
                "POST",
                "https://accounts.invalid/upload",
                big.clone(),
                None,
            )))
        });
        let (status, body) = got.expect("the large answer arrived");
        assert_eq!(status, 200, "the large answer's status arrived");
        assert_eq!(body.len(), big.len(), "the whole answer body arrived");
        assert!(
            body == big,
            "the answer body arrived exactly; the first differing byte is at {:?}",
            body.iter().zip(&big).position(|(a, b)| a != b)
        );
        let sent = &http.requests()[0].body;
        assert_eq!(sent.len(), big.len(), "the whole request body is recorded");
        assert!(
            *sent == big,
            "the request body is recorded exactly; the first differing byte is at {:?}",
            sent.iter().zip(&big).position(|(a, b)| a != b)
        );
    }

    #[test]
    fn every_method_is_recorded_exactly_as_spelled_lpw41_1() {
        const METHODS: [&str; 8] = [
            "GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "PURGE",
        ];
        let fx = fixture();
        let mut http = HttpQueue::new();
        for method in METHODS {
            http.push(HttpAnswer::status(200, method));
        }
        let got = fx.run_procedure(Caller::Sender(me()), at(), &mut http, |ctx| {
            METHODS
                .iter()
                .map(|method| {
                    let url = format!("https://accounts.invalid/{method}");
                    outcome(ctx.http.send(build(method, &url, Vec::new(), None)))
                })
                .collect::<Vec<_>>()
        });
        assert_eq!(
            got,
            METHODS
                .iter()
                .map(|method| Ok((200, method.as_bytes().to_vec())))
                .collect::<Vec<Outcome>>(),
            "each request got its own answer, in order"
        );
        assert_eq!(
            http.requests()
                .iter()
                .map(|r| (r.method.clone(), r.url.clone()))
                .collect::<Vec<_>>(),
            METHODS
                .iter()
                .map(|method| (
                    method.to_string(),
                    format!("https://accounts.invalid/{method}")
                ))
                .collect::<Vec<_>>(),
            "each request's method is recorded exactly as spelled"
        );
    }

    #[test]
    fn two_unanswered_requests_fail_the_run_naming_the_first_lpw41_2() {
        let fx = fixture();
        let mut http = HttpQueue::new();
        let first_seen: RefCell<Option<String>> = RefCell::new(None);
        let caught = catch_unwind(AssertUnwindSafe(|| {
            fx.run_procedure(Caller::Sender(me()), at(), &mut http, |ctx| {
                let first = outcome(ctx.http.send(build(
                    "POST",
                    "https://accounts.invalid/first-unanswered",
                    b"1".to_vec(),
                    None,
                )));
                *first_seen.borrow_mut() = first.err();
                let second = outcome(ctx.http.send(build(
                    "PUT",
                    "https://accounts.invalid/second-unanswered",
                    b"2".to_vec(),
                    None,
                )));
                second.is_ok()
            })
        }));
        let text = panic_text(caught.expect_err("unanswered requests fail the run"));
        assert!(
            text.contains(
                "the procedure sent `POST https://accounts.invalid/first-unanswered` with no stubbed HTTP answer left"
            ),
            "the failure names the first unanswered request: {text}"
        );
        let first = first_seen
            .into_inner()
            .expect("the first unanswered request got an Err");
        assert!(
            first.contains("no stubbed HTTP answer left"),
            "the first unanswered request's Err says no answer is left: {first}"
        );
        assert_eq!(
            http.requests()
                .iter()
                .map(|r| (r.method.clone(), r.url.clone()))
                .collect::<Vec<_>>(),
            vec![
                (
                    "POST".to_string(),
                    "https://accounts.invalid/first-unanswered".to_string()
                ),
                (
                    "PUT".to_string(),
                    "https://accounts.invalid/second-unanswered".to_string()
                ),
            ],
            "both unanswered requests are recorded, in order"
        );
    }

    #[test]
    fn a_retry_loop_against_an_empty_queue_ends_at_its_second_request_lpw41_2() {
        let fx = fixture();
        let mut http = HttpQueue::new();
        let caught = catch_unwind(AssertUnwindSafe(|| {
            fx.run_procedure(Caller::Sender(me()), at(), &mut http, |ctx| {
                let mut tries = 0u32;
                while tries < 1_000 && ctx.http.get("https://accounts.invalid/retry").is_err() {
                    tries += 1;
                }
                tries
            })
        }));
        let text = panic_text(caught.expect_err("the retry loop's run fails"));
        assert!(
            text.contains(
                "the procedure sent `GET https://accounts.invalid/retry` with no stubbed HTTP answer left"
            ),
            "the failure names the unanswered request: {text}"
        );
        assert_eq!(
            http.requests().len(),
            2,
            "the second unanswered request stops the procedure"
        );
    }

    #[test]
    fn an_aborted_transaction_restores_every_table_it_wrote_lpw41_3() {
        let fx = fixture();
        let rows = proc_rows(&fx);
        let other = other_rows(&fx);
        rows.seed(&1);
        rows.seed(&2);
        other.seed(&50);
        let mut http = HttpQueue::new();
        let (aborted, next) = fx.run_procedure(Caller::Sender(me()), at(), &mut http, |ctx| {
            ctx.with_tx(|_tx| {
                insert_into(TABLE, 3);
                insert_into(OTHER, 51);
            });
            let aborted = ctx.try_with_tx(|_tx| -> Result<(), (Vec<u64>, u32, Vec<u64>)> {
                insert_into(TABLE, 4);
                let removed = delete_from(OTHER, 50);
                insert_into(OTHER, 52);
                Err((scan_of(TABLE), removed, scan_of(OTHER)))
            });
            let next = ctx.with_tx(|_tx| (scan_of(TABLE), scan_of(OTHER)));
            (aborted, next)
        });
        assert_eq!(
            aborted,
            Err((vec![1, 2, 3, 4], 1, vec![51, 52])),
            "the body ran: it wrote both tables and its Err came back"
        );
        assert_eq!(
            next,
            (vec![1, 2, 3], vec![50, 51]),
            "the next transaction sees both tables as the aborted one found them"
        );
        assert_eq!(
            rows.rows(),
            vec![1, 2, 3],
            "the first table is back exactly"
        );
        assert_eq!(
            other.rows(),
            vec![50, 51],
            "the second table is back exactly, its deleted row included"
        );
    }
}
