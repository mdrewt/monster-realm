//! `native_host_tests` — a test-only, in-memory implementation of the
//! SpacetimeDB host syscalls that the `#[table]`-generated accessor code calls,
//! so the SHIPPED reducer-side helpers can run against REAL rows inside an
//! ordinary native `cargo test` binary (rb-41, ADR-0222 amendment; the
//! ADR-0224 migration of the guest-claim-integrity exists-half check).
//!
//! HOW THE PIECES FIT. `spacetimedb::ReducerContext::__dummy()` (crate 2.8.1,
//! `src/lib.rs:1043`, `#[doc(hidden)] pub`) yields a context whose `db` is the
//! real `Local {}` accessor type, so `ctx.db.<table>().<index>().find(..)` in a
//! production helper compiles and runs unchanged. That generated code bottoms
//! out in the `extern "C"` host imports declared by `spacetimedb-bindings-sys`
//! (`#[link(wasm_import_module = "spacetime_10.x")]`), which the native
//! test target leaves UNDEFINED — until now the crate linked only because two
//! test files defined aborting `#[no_mangle]` stubs for them. This module defines every
//! one of those ELEVEN symbols ONCE (a `#[no_mangle]` symbol is one-definition-per-binary)
//! and implements SEVEN of them: the two name lookups, the index point scan and the index
//! RANGE scan, the row iterator's advance and close, and the index-point DELETE on an index
//! a fixture registered. The other FOUR stay loudly unmodelled — the table scan, insert,
//! update and delete_all_by_eq. A full-table `.iter()` is the shape this repo bans in
//! owner-scoped readers, so a predicate that reaches for one must fail here, not pass — and
//! tests seed rows through [`Fixture::table`] / [`Fixture::table_keyed`] instead, which
//! sidesteps the auto_inc write-back decode, the monster dual-write pairing scan and the
//! single-stack inventory scan (all of which read test files) without touching any of them.
//!
//! NAMING IS LOAD-BEARING. The module name ends in `tests` because the
//! `accounts_tests.rs` module census (`m22_declared_mod_names`) exempts only
//! `*tests` names from its "every declared mod has a scanned production file"
//! rule; the file name ends in `_tests.rs` because that suffix is what the
//! `_tests.rs`-exempting cross-file eval scanners key on. The declaring `mod`
//! line in `lib.rs` carries the cfg(test) attribute, and THIS file deliberately
//! never spells that attribute out: the monster-privacy `[SCOPE]` clause first
//! looks for the literal in the excluded file's raw text (prose included) and
//! only then checks the parent declaration — so a file that mentions the
//! attribute self-certifies — and its parent branch accepts ANY such literal
//! within 160 characters above the declaration, so the gated module declared
//! just above this one vouches for it too (both MEASURED in rb-41). The guard
//! that actually keeps this module out of the published wasm is the compiler:
//! any non-test reference to it fails the publish build with E0433.
//!
//! SCAN HYGIENE. This file never names a table accessor, a row type or a table
//! attribute: table and index names arrive from the caller as plain strings
//! and rows arrive already typed, so no accessor-token scanner (currency
//! integrity, dual-write, single-stack, ...) has anything to match here.
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

/// BSATN bytes of the indexed column value (an `Identity` for the owner-keyed
/// tables; a `u64` for an auto-inc primary key since rb-47's `table_keyed`).
/// BSATN is canonical, so byte equality IS value equality.
type Key = Vec<u8>;
/// BSATN bytes of one whole row, exactly as the generated insert path encodes
/// it (`bsatn::to_vec` is the same encoder `IterBuf::serialize_into` uses).
type Row = Vec<u8>;

#[derive(Default)]
struct Host {
    /// Table name (the `accessor`) -> id. Never reset (see module doc).
    table_ids: HashMap<String, u32>,
    /// Canonical index name (`{table}_{col}_idx_btree`) -> id. Never reset.
    index_ids: HashMap<String, u32>,
    /// index id -> (table id, key comparator), bound only for indexes a fixture
    /// registered. Process-lifetime like the ids (never reset — a binding is a
    /// pure function of two names). An index the generated code asks about but
    /// no test registered resolves to an id with NO table behind it, and READS
    /// over it yield no rows — which is what lets `account_has_game_data` visit
    /// all six tables while a test registers only its own (a WRITE aborts, D5).
    index_table: HashMap<u32, (u32, KeyCmp)>,
    /// table id -> live rows, reset by every [`fixture`].
    rows: HashMap<u32, Vec<(Key, Row)>>,
    /// Open row iterators: rows not yet handed to the caller.
    iters: HashMap<u32, VecDeque<Row>>,
    /// Every index name the generated code asked for since the last reset —
    /// surfaced by [`Fixture::requested_indexes`] so a mis-spelled registration
    /// prints the real name instead of a bare `false`. Note the memoisation
    /// caveat in the module doc: a name is asked for once per PROCESS.
    requested_indexes: Vec<String>,
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

    fn rows_of(&self, table_id: u32) -> &[(Key, Row)] {
        self.rows.get(&table_id).map_or(&[], Vec::as_slice)
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

/// BSATN bytes of one index key. Generic since rb-47: the generated point scan
/// hands this host the BSATN of whatever the indexed column's type is (an
/// `Identity` for the owner-keyed tables, a `u64` for an auto-inc primary key),
/// and byte equality on canonical BSATN is value equality for every one of them.
fn key_bytes<K: Serialize>(key: &K) -> Key {
    bsatn::to_vec(key).expect("native_host_tests: an index key always BSATN-encodes")
}

/// One test's exclusive view of the in-memory host: rows are empty on
/// construction and the process-wide serialisation lock is held until drop.
pub(crate) struct Fixture {
    _serial: MutexGuard<'static, ()>,
}

/// Acquire the host for one test: serialise against every other fixture user,
/// then wipe rows, open iterators and the requested-index log (ids survive).
pub(crate) fn fixture() -> Fixture {
    let serial = FIXTURE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    {
        let mut h = host();
        h.rows.clear();
        h.iters.clear();
        h.requested_indexes.clear();
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
    /// pass (red-team, rb-41). Idempotent per name. A test registers exactly
    /// the one table its predicate owns; the shim models no constraints, so a
    /// duplicate unique key seeded by mistake surfaces as the bindings' own
    /// `cannot return more than one row` assertion inside `find`.
    pub(crate) fn table<'a, R: Serialize>(
        &'a self,
        table: &str,
        column: &str,
        owner_of: fn(&R) -> Identity,
    ) -> Handle<'a, R> {
        self.table_keyed(table, column, owner_of)
    }

    /// The same registration for a table whose single-column index is keyed by
    /// a non-`Identity` column — a `u64` auto-inc primary key, say — so a reducer
    /// whose FIRST statement is a point read on such a key can be executed here
    /// at all (rb-47; before this every such reducer stopped at "not found" in
    /// every state, which made a behavioural test of it vacuous). Same
    /// derived-name rule, same idempotence, same no-constraints caveat as
    /// [`Fixture::table`], which is now a thin `Identity`-keyed alias of this.
    /// The write wall MOVED but still stands: an update, or a delete through an
    /// index no fixture registered, still aborts (rb-109; the EOF banner, D5).
    pub(crate) fn table_keyed<'a, R: Serialize, K: Serialize + DeserializeOwned + Ord>(
        &'a self,
        table: &str,
        column: &str,
        key_of: fn(&R) -> K,
    ) -> Handle<'a, R, K> {
        let index = format!("{table}_{column}_idx_btree");
        let mut h = host();
        let table_id = h.table_id(table);
        let index_id = h.index_id(&index);
        h.index_table.insert(index_id, (table_id, cmp_keys::<K>));
        Handle {
            table_id,
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
        host()
            .rows
            .entry(self.table_id)
            .or_default()
            .push((key, bytes));
    }

    /// Remove every row whose indexed key is `key`; returns how many went, so
    /// a test can assert it actually removed something.
    pub(crate) fn remove(&self, key: K) -> usize {
        let key = key_bytes(&key);
        let mut h = host();
        let rows = h.rows.entry(self.table_id).or_default();
        let before = rows.len();
        rows.retain(|(k, _)| *k != key);
        before - rows.len()
    }
}

// ---------------------------------------------------------------------------
// The host ABI. Signatures mirror the `spacetimedb-bindings-sys` 2.8.1 raw
// externs with the `repr(transparent)` `TableId` / `IndexId` / `RowIter`
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
        "native_host_tests: `{symbol}` is not modelled — this host serves single-column index \
         point and range reads and index-point deletes on registered indexes only; seed rows \
         with `Fixture::table(..).seed(..)` and `Handle::remove(..)`, never the db handle"
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
    let matching: Vec<Row> = match h.index_table.get(&index_id) {
        Some(&(table_id, _)) => h
            .rows_of(table_id)
            .iter()
            .filter(|(key, _)| key.as_slice() == point)
            .map(|(_, row)| row.clone())
            .collect(),
        None => Vec::new(),
    };
    let iter = h.open_iter(matching);
    // SAFETY: `out` points at the bindings' `MaybeUninit<RowIter>` out-param.
    unsafe { out.write(iter) };
    0
}

#[no_mangle]
unsafe extern "C" fn datastore_table_scan_bsatn(_table_id: u32, _out: *mut u32) -> u16 {
    unmodelled("datastore_table_scan_bsatn")
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
    _table_id: u32,
    _row_ptr: *mut u8,
    _row_len_ptr: *mut usize,
) -> u16 {
    unmodelled("datastore_insert_bsatn")
}

#[no_mangle]
unsafe extern "C" fn datastore_update_bsatn(
    _table_id: u32,
    _index_id: u32,
    _row_ptr: *mut u8,
    _row_len_ptr: *mut usize,
) -> u16 {
    unmodelled("datastore_update_bsatn")
}

#[no_mangle]
unsafe extern "C" fn datastore_delete_all_by_eq_bsatn(
    _table_id: u32,
    _rel_ptr: *const u8,
    _rel_len: usize,
    _out: *mut u32,
) -> u16 {
    unmodelled("datastore_delete_all_by_eq_bsatn")
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
    let Some(&(table_id, _)) = h.index_table.get(&index_id) else {
        unmodelled("datastore_delete_by_index_scan_point_bsatn on an unregistered index")
    };
    let rows = h.rows.entry(table_id).or_default();
    let before = rows.len();
    rows.retain(|(key, _)| key.as_slice() != point);
    let removed = before - rows.len();
    let removed = u32::try_from(removed).expect("native_host_tests: a delete count fits a u32");
    // SAFETY: `out` points at the bindings' `MaybeUninit<u32>` out-param, which
    // `sys::call` `assume_init`s on every `0` return — so every `0`-returning
    // path here writes it, and writes EXACTLY a `u32` (bindings-sys `:1059`).
    unsafe { out.write(removed) };
    0
}

// ---------------------------------------------------------------------------
// rb-109 — THE RANGE MODEL: what the scan below reads off the wire, what it
// decides for itself, and which of its answers is a MODEL rather than an
// observation. (ADR-0222 amendment; the value oracles are the `rb109_` tests.)
//
// THE WIRE FORMAT. Each side of a range arrives as the BSATN of a `Bound<T>`:
// tag byte 0 `Included` followed by the BSATN of the payload, 1 `Excluded`
// followed by the payload, 2 `Unbounded` with no payload at all
// (`spacetimedb-sats-2.8.1/src/ser/impls.rs:124-128`). The bindings pack both
// sides into one buffer and hand out two slices over it
// (`spacetimedb-2.8.1/src/table.rs:1069-1078`), and `prefix_elems` is a
// `repr(transparent)` `ColId(pub u16)`, so the raw parameter is a `u16`
// (`spacetimedb-primitives-2.8.1/src/ids.rs:125`). The parse is an EXPLICIT tag
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
// D6 — A BOTH-`Unbounded` RANGE ABORTS. It is a sorted full scan: the `.iter()`
// shape this host refuses, wearing a range. Refusing it here keeps the wall
// SHAPE-based rather than spelling-based.
//
// D5 — THE WRITE WALL IS ASYMMETRIC, on purpose. A READ through an index no
// fixture registered yields nothing, so a predicate that visits several tables
// still runs against the one table its test owns. A WRITE through such an index
// ABORTS. Insert, update and delete_all_by_eq abort unconditionally; the table
// scan aborts; the index-point delete aborts unless the fixture registered the
// index. Eleven symbols, seven implemented, four unmodelled.
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

/// The btree range scan: every row of the registered table whose key clears
/// both bounds, handed back ASCENDING by decoded key with ties in store order.
///
/// An index no fixture registered opens an EMPTY iterator and returns `0`,
/// exactly as the point scan above does — an unregistered table reads as empty,
/// it does not abort. A multi-column prefix and a both-`Unbounded` range do
/// abort (D6). The whole call takes the host lock ONCE; the comparator runs
/// inside it and re-enters nothing.
#[no_mangle]
unsafe extern "C" fn datastore_index_scan_range_bsatn(
    index_id: u32,
    _prefix_ptr: *const u8,
    _prefix_len: usize,
    prefix_elems: u16,
    rstart_ptr: *const u8,
    rstart_len: usize,
    rend_ptr: *const u8,
    rend_len: usize,
    out: *mut u32,
) -> u16 {
    if prefix_elems != 0 {
        unmodelled("datastore_index_scan_range_bsatn over a multi-column index prefix");
    }
    // SAFETY: each `ptr[..len]` is a live slice of the bindings' packed range
    // buffer, owned by the caller for the call's duration.
    let rstart = unsafe { std::slice::from_raw_parts(rstart_ptr, rstart_len) };
    let rend = unsafe { std::slice::from_raw_parts(rend_ptr, rend_len) };
    let (low, high) = (parse_bound(rstart), parse_bound(rend));
    if matches!((low, high), (RangeBound::Unbounded, RangeBound::Unbounded)) {
        unmodelled("datastore_index_scan_range_bsatn over a both-unbounded range (a sorted scan)");
    }
    let mut h = host();
    let matching: Vec<Row> = match h.index_table.get(&index_id) {
        Some(&(table_id, cmp)) => {
            let mut hits: Vec<&(Key, Row)> = h
                .rows_of(table_id)
                .iter()
                .filter(|(key, _)| {
                    low.admits_low(key.as_slice(), cmp) && high.admits_high(key.as_slice(), cmp)
                })
                .collect();
            // STABLE, so equal keys keep the order `Handle::seed` stored them in.
            hits.sort_by(|a, b| cmp(&a.0, &b.0));
            hits.into_iter().map(|(_, row)| row.clone()).collect()
        }
        None => Vec::new(),
    };
    let iter = h.open_iter(matching);
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
    /// THE LOCK RULE (ADR-0222 amendment, D9). [`host`] is a plain,
    /// NON-REENTRANT `Mutex`: a call made from inside a host syscall — from a
    /// comparator, say — would deadlock. A live `ctx.db..filter(..)` iterator
    /// holds no lock BETWEEN syscalls, so calling this between two `next()`
    /// calls does not hang; it is banned anyway, because that iterator was
    /// handed its rows when it opened and a seed or a delete underneath it
    /// leaves a reader looking at a store that has moved. COLLECT first, assert
    /// afterwards — which is what every `rb109_` test does.
    pub(crate) fn rows(&self) -> Vec<R>
    where
        R: DeserializeOwned,
    {
        host()
            .rows_of(self.table_id)
            .iter()
            .map(|(_, row)| {
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
    /// is a real datastore resource an hourly job would strand once an hour.
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
