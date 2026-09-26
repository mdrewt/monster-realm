//! rb-45 — the [DEL-06] crate-wide deletion-gate census (ADR-0258).
//!
//! EARS under gate. (rb-45) WHEN a reducer writes any manifest-classified table
//! without the gate call or `STATE_TRANSITION_OWNERS` membership THE SYSTEM
//! SHALL fail CI. (rb-49, [DEL-06]) WHEN a reducer writes any manifest-classified
//! table outside `STATE_TRANSITION_OWNERS` THE SYSTEM SHALL require a preceding
//! deletion-guard call — a `require_*` wrapper over the rejection predicate,
//! spelled as ADR-0248 D1 pins it — mechanically enforced.
//!
//! OWNERSHIP SPLIT. The `rb45_*` tests and the rosters below are GATING: they are
//! revised from ADR-0258 and the slice plan, NEVER edited to fit an engine. The
//! `census` module is the implementation half; the rest of the file is its contract.
//!
//! FIXTURE HYGIENE — MANDATORY for every future editor. Several eval scripts
//! concatenate the `*_tests.rs` files and scan them as TEXT with string-unaware
//! comment strippers, so a contiguous production marker here reds an unrelated CI
//! gate. Therefore, in this file:
//!   - every production-looking marker inside a fixture is assembled from
//!     `concat!` pieces, spelled ONCE in a `fixture_*` helper or a const near the
//!     top (reducer and table attributes, the accessor spelling, write calls, the
//!     guard paths, the pending predicate, macro and impl-block shapes, the
//!     table-handle type, cfg and path attributes);
//!   - no forward slash inside ANY string literal, no block comment, no raw
//!     string, no include macro, no macro metavariable splice;
//!   - lines stay inside 100 columns and the file stays rustfmt-clean.

use std::collections::BTreeSet;

// ---------------------------------------------------------------------------
// The census engine (implementation half — frozen API, bodies land in T3)
// ---------------------------------------------------------------------------

mod census {
    use std::collections::btree_map::Entry;
    use std::collections::{BTreeMap, BTreeSet, VecDeque};
    use syn::visit::Visit;
    use syn::{Expr, Item, Pat, Stmt};

    pub(super) const WRITE_VERBS: &[&str] = &[
        "insert",
        "try_insert",
        "update",
        "delete",
        "clear",
        "insert_or_update",
        "try_insert_or_update",
    ];

    // --- Vocabulary ---------------------------------------------------------
    // Every name below is compared against an AST ident or path segment. The
    // engine never searches source text: a shape the parser cannot classify is
    // a hard error, never an approximation (ADR-0258 D1).

    const ROOT: &str = "crate";
    const GUARD_MODULE: &str = "guards";
    const ACCOUNT_MODULE: &str = "accounts";
    const SELF_SEGMENT: &str = "self";
    const REQUIRE_NOT_DELETING: &str = "require_not_deleting";
    const REQUIRE_SUBJECT: &str = "require_subject_not_deleting";
    const REQUIRE_COMMITMENT: &str = "require_commitment_predates_deletion";
    const PENDING_PREDICATE: &str = concat!("is_pending_", "deletion");
    const REJECT_PREDICATE: &str = concat!("should_reject_", "for_deletion");
    /// The only three wrapper spellings ADR-0248 D1 pins as gate shape (a).
    const GATE_WRAPPERS: &[&str] = &[REQUIRE_NOT_DELETING, REQUIRE_SUBJECT, REQUIRE_COMMITMENT];
    /// Guard-family fn names that may only be DEFINED in guards or accounts.
    const GUARD_FN_NAMES: &[&str] = &[
        REQUIRE_NOT_DELETING,
        REQUIRE_SUBJECT,
        REQUIRE_COMMITMENT,
        PENDING_PREDICATE,
        REJECT_PREDICATE,
    ];
    const LIFECYCLE_ARGS: &[&str] = &["init", "client_connected", "client_disconnected"];
    /// Chain methods that turn a table handle into rows, so a binding of such a
    /// chain is a row, never a handle alias.
    const ROW_METHODS: &[&str] = &["iter", "count", "len"];
    const HANDLE_SUFFIX: &str = concat!("Table", "Handle");
    const TABLE_TRAIT: &str = "Table";
    const CTX_TYPE: &str = "ReducerContext";
    const SENDER_METHOD: &str = "sender";
    const HOST_IDENTITY_METHOD: &str = concat!("database_", "identity");
    const OK_VARIANT: &str = "Ok";
    const TEST_CFG: &str = "test";
    const CFG_ATTR: &str = "cfg";
    const DOC_ATTR: &str = "doc";
    const REDUCER_ATTR: &str = "reducer";
    const TABLE_ATTR: &str = "table";
    const PROCEDURE_ATTR: &str = "procedure";
    const SCHEDULED_ARG: &str = "scheduled";
    const WILDCARD: &str = "_";
    const LIB_STEM: &str = "lib";
    const SRC_DIR: &str = "src";

    /// Manifest tables whose `DeletionPolicy` is not `NotOwned`, read from the
    /// real `crate::schema::DATA_LIFECYCLE_MANIFEST`.
    pub(super) fn classified_tables() -> BTreeSet<&'static str> {
        crate::schema::DATA_LIFECYCLE_MANIFEST
            .iter()
            .filter(|entry| !matches!(entry.policy, crate::schema::DeletionPolicy::NotOwned))
            .map(|entry| entry.table)
            .collect()
    }

    /// The real corpus: `[("crate", lib.rs source), (module, module source)…]`,
    /// derived by parsing lib.rs and read through `env!("CARGO_MANIFEST_DIR")`.
    pub(super) fn real_sources() -> Result<Vec<(String, String)>, CensusError> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(SRC_DIR);
        let root_source = read_module(&dir, LIB_STEM, ROOT)?;
        let root_file = parse_module(ROOT, &root_source)?;
        let mut out = vec![(String::from(ROOT), root_source)];
        for item in &root_file.items {
            let Item::Mod(item_mod) = item else { continue };
            if let RootMod::Scanned = classify_root_mod(item_mod)? {
                let name = item_mod.ident.to_string();
                let source = read_module(&dir, &name, &name)?;
                out.push((name, source));
            }
        }
        Ok(out)
    }

    pub(super) fn census(
        sources: &[(String, String)],
        classified: &BTreeSet<&str>,
        owners: &[&str],
    ) -> Result<Report, CensusError> {
        let mut files: Vec<(&str, syn::File)> = Vec::with_capacity(sources.len());
        for (module, source) in sources {
            files.push((module.as_str(), parse_module(module, source)?));
        }
        let corpus = Corpus::collect(&files)?;
        let tables: BTreeSet<String> = classified.iter().map(|t| (*t).to_string()).collect();
        Ok(Report {
            verdicts: corpus.verdicts(&tables, owners)?,
            modules: sources.iter().map(|(name, _)| name.clone()).collect(),
        })
    }

    #[derive(Debug)]
    pub(super) struct Report {
        pub verdicts: BTreeMap<String, Verdict>,
        pub modules: Vec<String>,
    }

    impl Report {
        pub(super) fn ungated(&self) -> BTreeSet<&str> {
            self.names_with(|verdict| matches!(verdict, Verdict::Ungated { .. }))
        }

        pub(super) fn names_with(&self, pred: impl Fn(&Verdict) -> bool) -> BTreeSet<&str> {
            self.verdicts
                .iter()
                .filter(|(_, verdict)| pred(verdict))
                .map(|(name, _)| name.as_str())
                .collect()
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(super) enum Verdict {
        Owner,
        Lifecycle,
        Scheduled,
        NoClassifiedWrites,
        Gated {
            gate_stmt: usize,
            first_write_stmt: usize,
        },
        Ungated {
            writes: BTreeSet<String>,
            first_write_stmt: usize,
            gate_stmt: Option<usize>,
            via: Vec<String>,
        },
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(super) enum CensusError {
        Parse { module: String, msg: String },
        MissingModuleFile { module: String },
        DuplicateReducer { name: String },
        UnsupportedShape { module: String, what: String },
    }

    // --- Source access ------------------------------------------------------

    /// A module file that is simply absent is `MissingModuleFile`; any other io
    /// failure (a permission error, a non-UTF-8 byte) reports its real cause
    /// rather than masquerading as an absent module.
    fn read_module(dir: &std::path::Path, stem: &str, module: &str) -> Result<String, CensusError> {
        std::fs::read_to_string(dir.join(format!("{stem}.rs"))).map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                CensusError::MissingModuleFile {
                    module: String::from(module),
                }
            } else {
                CensusError::Parse {
                    module: String::from(module),
                    msg: err.to_string(),
                }
            }
        })
    }

    fn parse_module(module: &str, source: &str) -> Result<syn::File, CensusError> {
        syn::parse_file(source).map_err(|err| CensusError::Parse {
            module: String::from(module),
            msg: err.to_string(),
        })
    }

    fn shape(module: &str, what: String) -> CensusError {
        CensusError::UnsupportedShape {
            module: String::from(module),
            what,
        }
    }

    // --- Crate-root module roster ------------------------------------------

    enum RootMod {
        Scanned,
        Skipped,
    }

    /// A crate-root `mod` is SKIPPED when any of its attributes is exactly a
    /// test cfg, and SCANNED when it declares a file and carries nothing but
    /// doc comments. Every other attribute set, and every inline body, is
    /// refused rather than guessed.
    fn classify_root_mod(item_mod: &syn::ItemMod) -> Result<RootMod, CensusError> {
        let ident = item_mod.ident.to_string();
        let mut other_cfg = false;
        for attr in &item_mod.attrs {
            if attr_name(attr).as_deref() == Some(CFG_ATTR) {
                if is_test_cfg(attr) {
                    return Ok(RootMod::Skipped);
                }
                other_cfg = true;
            }
        }
        if other_cfg {
            let what = format!("module {ident} carries a cfg attribute other than the test one");
            return Err(shape(ROOT, what));
        }
        if item_mod
            .attrs
            .iter()
            .any(|attr| attr_name(attr).as_deref() != Some(DOC_ATTR))
        {
            let what =
                format!("module {ident} carries an unsupported attribute set at the crate root");
            return Err(shape(ROOT, what));
        }
        if item_mod.content.is_some() {
            let what = format!("inline module {ident} at the crate root");
            return Err(shape(ROOT, what));
        }
        Ok(RootMod::Scanned)
    }

    // --- Attribute helpers --------------------------------------------------

    fn attr_name(attr: &syn::Attribute) -> Option<String> {
        attr.path().segments.last().map(|s| s.ident.to_string())
    }

    fn attr_ident_arg(attr: &syn::Attribute) -> Option<String> {
        match &attr.meta {
            syn::Meta::List(list) => syn::parse2::<syn::Ident>(list.tokens.clone())
                .ok()
                .map(|ident| ident.to_string()),
            _ => None,
        }
    }

    fn is_test_cfg(attr: &syn::Attribute) -> bool {
        attr_ident_arg(attr).is_some_and(|arg| arg == TEST_CFG)
    }

    fn carries_test_cfg(attrs: &[syn::Attribute]) -> bool {
        attrs
            .iter()
            .any(|attr| attr_name(attr).as_deref() == Some(CFG_ATTR) && is_test_cfg(attr))
    }

    fn carries_attr(attrs: &[syn::Attribute], name: &str) -> bool {
        attrs
            .iter()
            .any(|attr| attr_name(attr).as_deref() == Some(name))
    }

    /// `Some(attribute argument)` when the item carries a reducer attribute;
    /// the inner `None` is the argument-less spelling.
    fn reducer_arg(attrs: &[syn::Attribute]) -> Option<Option<String>> {
        attrs
            .iter()
            .find(|attr| attr_name(attr).as_deref() == Some(REDUCER_ATTR))
            .map(attr_ident_arg)
    }

    fn path_segments(path: &syn::Path) -> Vec<String> {
        path.segments
            .iter()
            .map(|segment| segment.ident.to_string())
            .collect()
    }

    fn path_tail(path: &syn::Path) -> String {
        path.segments
            .last()
            .map_or_else(|| String::from("an unnamed path"), |s| s.ident.to_string())
    }

    /// The alias an import binds, if any. `use x as _;` binds no name and is
    /// therefore not a rename.
    fn use_rename(tree: &syn::UseTree) -> Option<String> {
        match tree {
            syn::UseTree::Path(inner) => use_rename(&inner.tree),
            syn::UseTree::Group(group) => group.items.iter().find_map(use_rename),
            syn::UseTree::Rename(rename) if rename.rename != WILDCARD => {
                Some(rename.rename.to_string())
            }
            _ => None,
        }
    }

    fn extern_rename(item: &syn::ItemExternCrate) -> Option<String> {
        item.rename
            .as_ref()
            .map(|(_, ident)| ident)
            .filter(|ident| *ident != WILDCARD)
            .map(ToString::to_string)
    }

    // --- Type probes --------------------------------------------------------

    /// Does a signature, bound or type alias name the reducer context or a
    /// table handle? A mention inside a bare fn type's PARAMETER list does not
    /// count: such a type aliases a callback, not a context or a handle, and
    /// the crate's own `ExportRows` registry is exactly that shape.
    #[derive(Default)]
    struct TypeProbe {
        context: bool,
        handle: bool,
        opaque: usize,
        callback: usize,
    }

    impl<'ast> Visit<'ast> for TypeProbe {
        fn visit_type_impl_trait(&mut self, node: &'ast syn::TypeImplTrait) {
            self.opaque += 1;
            syn::visit::visit_type_impl_trait(self, node);
            self.opaque -= 1;
        }

        fn visit_type_bare_fn(&mut self, node: &'ast syn::TypeBareFn) {
            self.callback += 1;
            for input in &node.inputs {
                self.visit_bare_fn_arg(input);
            }
            self.callback -= 1;
            self.visit_return_type(&node.output);
        }

        fn visit_path_segment(&mut self, segment: &'ast syn::PathSegment) {
            if self.callback == 0 {
                let ident = segment.ident.to_string();
                if ident == CTX_TYPE {
                    self.context = true;
                }
                if ident.ends_with(HANDLE_SUFFIX) {
                    self.handle = true;
                }
                let parameterised =
                    matches!(segment.arguments, syn::PathArguments::AngleBracketed(_));
                if ident == TABLE_TRAIT && (self.opaque > 0 || parameterised) {
                    self.handle = true;
                }
            }
            syn::visit::visit_path_segment(self, segment);
        }
    }

    fn probe_signature(sig: &syn::Signature) -> TypeProbe {
        let mut probe = TypeProbe::default();
        probe.visit_signature(sig);
        probe
    }

    fn probe_type(ty: &syn::Type) -> TypeProbe {
        let mut probe = TypeProbe::default();
        probe.visit_type(ty);
        probe
    }

    // --- Corpus collection --------------------------------------------------

    struct FnBody {
        module: String,
        name: String,
        block: syn::Block,
        reducer: Option<Option<String>>,
        bindings: BTreeSet<String>,
    }

    /// Every ident a fn binds as a VALUE — parameters, `let`s, closure and
    /// match patterns. A bare path naming one of them is that binding, never
    /// the fn item of the same name: Rust resolves the binding first, and a
    /// struct-literal field shorthand (`PlaytestEvent { hp_permille }`) is
    /// exactly that shape next to a same-module `fn hp_permille`.
    #[derive(Default)]
    struct BindingScan {
        names: BTreeSet<String>,
    }

    impl<'ast> Visit<'ast> for BindingScan {
        fn visit_pat_ident(&mut self, binding: &'ast syn::PatIdent) {
            self.names.insert(binding.ident.to_string());
            syn::visit::visit_pat_ident(self, binding);
        }
    }

    fn value_bindings(item_fn: &syn::ItemFn) -> BTreeSet<String> {
        let mut scan = BindingScan::default();
        scan.visit_signature(&item_fn.sig);
        scan.visit_block(&item_fn.block);
        scan.names
    }

    struct Corpus {
        fns: Vec<FnBody>,
        module_set: BTreeSet<String>,
        scheduled: BTreeSet<String>,
        reducers: BTreeSet<String>,
    }

    impl Corpus {
        fn collect(files: &[(&str, syn::File)]) -> Result<Self, CensusError> {
            let mut corpus = Corpus {
                fns: Vec::new(),
                module_set: files.iter().map(|(name, _)| (*name).to_string()).collect(),
                scheduled: BTreeSet::new(),
                reducers: BTreeSet::new(),
            };
            for (module, file) in files {
                for item in &file.items {
                    corpus.scan_item(module, item)?;
                }
            }
            Ok(corpus)
        }

        fn scan_item(&mut self, module: &str, item: &Item) -> Result<(), CensusError> {
            match item {
                Item::Macro(item_macro) => Err(shape(module, macro_refusal(item_macro))),
                Item::Mod(item_mod) => scan_mod(module, item_mod),
                Item::Use(item_use) => match use_rename(&item_use.tree) {
                    Some(alias) => Err(shape(module, format!("use as rename binding {alias}"))),
                    None => Ok(()),
                },
                Item::ExternCrate(item_extern) => match extern_rename(item_extern) {
                    Some(alias) => Err(shape(
                        module,
                        format!("extern crate use as rename binding {alias}"),
                    )),
                    None => Ok(()),
                },
                Item::Type(item_type) => {
                    let subject = format!("type alias {}", item_type.ident);
                    refuse_named(module, &probe_type(&item_type.ty), &subject)
                }
                Item::Impl(item_impl) => {
                    for inner in &item_impl.items {
                        if let syn::ImplItem::Fn(method) = inner {
                            let subject =
                                format!("an implementation block fn {}", method.sig.ident);
                            refuse_named(module, &probe_signature(&method.sig), &subject)?;
                        }
                    }
                    Ok(())
                }
                Item::Struct(item_struct) => {
                    self.collect_schedule_targets(&item_struct.attrs);
                    Ok(())
                }
                Item::Fn(item_fn) => self.scan_fn(module, item_fn),
                _ => Ok(()),
            }
        }

        fn scan_fn(&mut self, module: &str, item_fn: &syn::ItemFn) -> Result<(), CensusError> {
            let name = item_fn.sig.ident.to_string();
            if carries_attr(&item_fn.attrs, PROCEDURE_ATTR) {
                return Err(shape(module, format!("procedure attribute on {name}")));
            }
            if probe_signature(&item_fn.sig).handle {
                let what = format!("fn {name} has a table handle in its signature");
                return Err(shape(module, what));
            }
            if GUARD_FN_NAMES.contains(&name.as_str())
                && module != GUARD_MODULE
                && module != ACCOUNT_MODULE
            {
                let what = format!("shadow definition of the guard fn {name}");
                return Err(shape(module, what));
            }
            let reducer = reducer_arg(&item_fn.attrs);
            if reducer.is_some() && !self.reducers.insert(name.clone()) {
                return Err(CensusError::DuplicateReducer { name });
            }
            self.fns.push(FnBody {
                module: String::from(module),
                name,
                block: (*item_fn.block).clone(),
                reducer,
                bindings: value_bindings(item_fn),
            });
            Ok(())
        }

        /// The scheduled reducer roster: the ident inside the schedule argument
        /// of any table attribute in the corpus (never the parameter type).
        fn collect_schedule_targets(&mut self, attrs: &[syn::Attribute]) {
            for attr in attrs {
                if attr_name(attr).as_deref() != Some(TABLE_ATTR) {
                    continue;
                }
                let parsed = attr.parse_args_with(
                    syn::punctuated::Punctuated::<syn::Meta, syn::Token![,]>::parse_terminated,
                );
                let Ok(args) = parsed else { continue };
                for meta in args {
                    let syn::Meta::List(list) = meta else {
                        continue;
                    };
                    if !list.path.is_ident(SCHEDULED_ARG) {
                        continue;
                    }
                    if let Ok(ident) = syn::parse2::<syn::Ident>(list.tokens.clone()) {
                        self.scheduled.insert(ident.to_string());
                    }
                }
            }
        }
    }

    /// A signature or type alias that names the reducer context or a table
    /// handle hides exactly what the walker reads structurally, so it is
    /// refused in the words of whatever spelled it.
    fn refuse_named(module: &str, probe: &TypeProbe, subject: &str) -> Result<(), CensusError> {
        if probe.context {
            return Err(shape(module, format!("{subject} names a reducer context")));
        }
        if probe.handle {
            return Err(shape(module, format!("{subject} names a table handle")));
        }
        Ok(())
    }

    fn macro_refusal(item_macro: &syn::ItemMacro) -> String {
        match &item_macro.ident {
            Some(ident) => format!("macro definition {ident} at item position"),
            None => format!(
                "macro invocation {} at item position",
                path_tail(&item_macro.mac.path)
            ),
        }
    }

    fn scan_mod(module: &str, item_mod: &syn::ItemMod) -> Result<(), CensusError> {
        if module == ROOT {
            classify_root_mod(item_mod)?;
            return Ok(());
        }
        if carries_test_cfg(&item_mod.attrs) {
            return Ok(());
        }
        let what = format!("nested module {} without a test attribute", item_mod.ident);
        Err(shape(module, what))
    }

    // --- Crate-local call resolution ---------------------------------------

    struct Resolver {
        index: BTreeMap<(String, String), Vec<usize>>,
        by_name: BTreeMap<String, Vec<usize>>,
        modules: BTreeSet<String>,
    }

    impl Resolver {
        fn build(fns: &[FnBody], modules: &BTreeSet<String>) -> Self {
            let mut index: BTreeMap<(String, String), Vec<usize>> = BTreeMap::new();
            let mut by_name: BTreeMap<String, Vec<usize>> = BTreeMap::new();
            for (idx, entry) in fns.iter().enumerate() {
                index
                    .entry((entry.module.clone(), entry.name.clone()))
                    .or_default()
                    .push(idx);
                by_name.entry(entry.name.clone()).or_default().push(idx);
            }
            Resolver {
                index,
                by_name,
                modules: modules.clone(),
            }
        }

        /// EVERY fn of that name in that module — a cfg-paired twin is a second
        /// definition, and dropping one of them loses its writes.
        fn in_module(&self, module: &str, name: &str) -> &[usize] {
            self.index
                .get(&(String::from(module), String::from(name)))
                .map_or(&[], Vec::as_slice)
        }

        /// Resolution that never guesses: a bare name binds inside its own
        /// module, and every other form names its module explicitly. This is
        /// the fn-pointer tripwire's vocabulary, where a by-name sweep would
        /// fire on any local that happens to share a name with some fn.
        fn resolve_qualified(&self, module: &str, segments: &[String]) -> &[usize] {
            let Some(name) = segments.last() else {
                return &[];
            };
            match segments.len() {
                1 => self.in_module(module, name),
                2 if segments[0] == SELF_SEGMENT => self.in_module(module, name),
                2 if segments[0] == ROOT => self.in_module(ROOT, name),
                2 if self.modules.contains(segments[0].as_str()) => {
                    self.in_module(&segments[0], name)
                }
                3 if segments[0] == ROOT && self.modules.contains(segments[1].as_str()) => {
                    self.in_module(&segments[1], name)
                }
                _ => &[],
            }
        }

        /// Call resolution: as above, plus the fail-closed fallback that a bare
        /// name with no same-module definition means EVERY crate fn of that
        /// name. Zero matches is a closure, an `Fn` parameter or a foreign call.
        fn resolve(&self, module: &str, segments: &[String]) -> &[usize] {
            let found = self.resolve_qualified(module, segments);
            if !found.is_empty() || segments.len() != 1 {
                return found;
            }
            self.by_name.get(&segments[0]).map_or(&[], Vec::as_slice)
        }
    }

    // --- Receiver chains ----------------------------------------------------

    /// Which question a receiver-chain walk is asking.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Chain {
        /// Is this expression a TABLE HANDLE — a chain of zero-argument calls
        /// reaching a classified accessor (or a bound alias), none of which
        /// turns the handle into rows or writes it?
        Handle,
        /// Does a write's receiver chain reach a classified accessor?
        Accessor,
        /// Is a write's receiver chain rooted in a bound handle alias, through
        /// `&` and parentheses only — a field base is a row, not a handle.
        Alias,
    }

    fn chain_table(
        expr: &Expr,
        mode: Chain,
        classified: &BTreeSet<String>,
        aliases: &BTreeMap<String, String>,
    ) -> Option<String> {
        let mut found: Option<String> = None;
        let mut cursor = expr;
        loop {
            match cursor {
                Expr::MethodCall(call) => {
                    let method = call.method.to_string();
                    match mode {
                        Chain::Handle => {
                            if !call.args.is_empty()
                                || ROW_METHODS.contains(&method.as_str())
                                || WRITE_VERBS.contains(&method.as_str())
                            {
                                return None;
                            }
                            if found.is_none() && classified.contains(method.as_str()) {
                                found = Some(method);
                            }
                        }
                        Chain::Accessor => {
                            if call.args.is_empty() && classified.contains(method.as_str()) {
                                return Some(method);
                            }
                        }
                        Chain::Alias => {}
                    }
                    cursor = &call.receiver;
                }
                Expr::Field(field) if mode != Chain::Alias => cursor = &field.base,
                Expr::Try(attempt) if mode != Chain::Alias => cursor = &attempt.expr,
                Expr::Reference(reference) => cursor = &reference.expr,
                Expr::Paren(paren) => cursor = &paren.expr,
                Expr::Path(path) => {
                    if mode != Chain::Accessor && found.is_none() {
                        if let Some(ident) = path.path.get_ident() {
                            found = aliases.get(&ident.to_string()).cloned();
                        }
                    }
                    return found;
                }
                _ => return found,
            }
        }
    }

    fn write_target(
        receiver: &Expr,
        classified: &BTreeSet<String>,
        aliases: &BTreeMap<String, String>,
    ) -> Option<String> {
        chain_table(receiver, Chain::Accessor, classified, aliases)
            .or_else(|| chain_table(receiver, Chain::Alias, classified, aliases))
    }

    // --- Handle aliases -----------------------------------------------------

    fn bare_binding(local: &syn::Local) -> Option<(&syn::Ident, &Expr)> {
        let Pat::Ident(binding) = &local.pat else {
            return None;
        };
        if binding.subpat.is_some() {
            return None;
        }
        let init = local.init.as_ref()?;
        Some((&binding.ident, &init.expr))
    }

    struct AliasScan<'s> {
        classified: &'s BTreeSet<String>,
        known: &'s BTreeMap<String, String>,
        found: BTreeMap<String, String>,
    }

    impl<'ast, 's> Visit<'ast> for AliasScan<'s> {
        fn visit_local(&mut self, local: &'ast syn::Local) {
            if let Some((ident, init)) = bare_binding(local) {
                if let Some(table) = chain_table(init, Chain::Handle, self.classified, self.known) {
                    self.found.insert(ident.to_string(), table);
                }
            }
            syn::visit::visit_local(self, local);
        }
    }

    fn collect_aliases(
        block: &syn::Block,
        classified: &BTreeSet<String>,
    ) -> BTreeMap<String, String> {
        let mut known: BTreeMap<String, String> = BTreeMap::new();
        loop {
            let found = {
                let mut scan = AliasScan {
                    classified,
                    known: &known,
                    found: BTreeMap::new(),
                };
                scan.visit_block(block);
                scan.found
            };
            let mut grew = false;
            for (name, table) in found {
                if let Entry::Vacant(slot) = known.entry(name) {
                    slot.insert(table);
                    grew = true;
                }
            }
            if !grew {
                return known;
            }
        }
    }

    // --- One pass per fn: writes, calls and refused body shapes -------------

    struct ScanCtx<'s> {
        classified: &'s BTreeSet<String>,
        aliases: &'s BTreeMap<String, String>,
        bindings: &'s BTreeSet<String>,
        resolver: &'s Resolver,
        module: &'s str,
        fn_name: &'s str,
    }

    #[derive(Default)]
    struct BodyFacts {
        writes: BTreeSet<String>,
        calls: BTreeSet<usize>,
        refusals: Vec<String>,
    }

    /// A table handle is only readable where the walker can SEE what it is: as
    /// a method receiver, or as the init of a plain `let`. Anywhere else — a
    /// tuple element, a call argument, a deferred assignment, a block tail — it
    /// escapes into a value the census cannot follow, so it is refused.
    struct BodyScan<'s> {
        ctx: &'s ScanCtx<'s>,
        facts: BodyFacts,
        sanctioned: BTreeSet<usize>,
        callees: BTreeSet<usize>,
    }

    fn node_id(expr: &Expr) -> usize {
        std::ptr::from_ref(expr) as usize
    }

    impl<'s> BodyScan<'s> {
        fn new(ctx: &'s ScanCtx<'s>) -> Self {
            BodyScan {
                ctx,
                facts: BodyFacts::default(),
                sanctioned: BTreeSet::new(),
                callees: BTreeSet::new(),
            }
        }

        fn refuse(&mut self, what: String) {
            self.facts.refusals.push(what);
        }

        /// Mark a sanctioned position, and the same expression through the `&`
        /// and parentheses that may wrap it.
        fn sanction(&mut self, expr: &Expr) {
            let mut cursor = expr;
            loop {
                self.sanctioned.insert(node_id(cursor));
                match cursor {
                    Expr::Reference(reference) => cursor = &reference.expr,
                    Expr::Paren(paren) => cursor = &paren.expr,
                    Expr::Group(group) => cursor = &group.expr,
                    _ => return,
                }
            }
        }
    }

    impl<'ast, 's> Visit<'ast> for BodyScan<'s> {
        fn visit_expr(&mut self, expr: &'ast Expr) {
            let id = node_id(expr);
            if !self.sanctioned.contains(&id)
                && chain_table(expr, Chain::Handle, self.ctx.classified, self.ctx.aliases).is_some()
            {
                let what = format!(
                    "unseeable table handle expression in fn {}",
                    self.ctx.fn_name
                );
                self.refuse(what);
            }
            if let Expr::Path(path) = expr {
                if !self.callees.contains(&id) {
                    let segments = path_segments(&path.path);
                    let shadowed = segments.len() == 1 && self.ctx.bindings.contains(&segments[0]);
                    if !shadowed
                        && !self
                            .ctx
                            .resolver
                            .resolve_qualified(self.ctx.module, &segments)
                            .is_empty()
                    {
                        let what = format!(
                            "fn-pointer reference to {} in fn {}",
                            path_tail(&path.path),
                            self.ctx.fn_name
                        );
                        self.refuse(what);
                    }
                }
            }
            syn::visit::visit_expr(self, expr);
        }

        fn visit_expr_method_call(&mut self, call: &'ast syn::ExprMethodCall) {
            let method = call.method.to_string();
            if WRITE_VERBS.contains(&method.as_str()) {
                if let Some(table) =
                    write_target(&call.receiver, self.ctx.classified, self.ctx.aliases)
                {
                    self.facts.writes.insert(table);
                }
            }
            self.sanction(&call.receiver);
            syn::visit::visit_expr_method_call(self, call);
        }

        fn visit_expr_call(&mut self, call: &'ast syn::ExprCall) {
            self.callees.insert(node_id(&call.func));
            if let Expr::Path(path) = &*call.func {
                let segments = path_segments(&path.path);
                let tail = path_tail(&path.path);
                let qualified = path.qself.is_some() || segments.len() >= 2;
                if qualified && WRITE_VERBS.contains(&tail.as_str()) {
                    let what = format!("ufcs write call {tail} in fn {}", self.ctx.fn_name);
                    self.refuse(what);
                } else if path.qself.is_none() && segments.len() > 3 && segments[0] == ROOT {
                    let what = format!(
                        "nested module call path to {tail} in fn {}",
                        self.ctx.fn_name
                    );
                    self.refuse(what);
                }
                if path.qself.is_none() {
                    for idx in self.ctx.resolver.resolve(self.ctx.module, &segments) {
                        self.facts.calls.insert(*idx);
                    }
                }
            }
            syn::visit::visit_expr_call(self, call);
        }

        fn visit_local(&mut self, local: &'ast syn::Local) {
            if let Some((_, init)) = bare_binding(local) {
                self.sanction(init);
            }
            syn::visit::visit_local(self, local);
        }

        fn visit_item_macro(&mut self, item_macro: &'ast syn::ItemMacro) {
            let what = format!(
                "{} inside fn {}",
                macro_refusal(item_macro),
                self.ctx.fn_name
            );
            self.refuse(what);
            syn::visit::visit_item_macro(self, item_macro);
        }

        fn visit_item_use(&mut self, item_use: &'ast syn::ItemUse) {
            if let Some(alias) = use_rename(&item_use.tree) {
                let what = format!(
                    "use as rename binding {alias} inside fn {}",
                    self.ctx.fn_name
                );
                self.refuse(what);
            }
            syn::visit::visit_item_use(self, item_use);
        }

        fn visit_item_extern_crate(&mut self, item_extern: &'ast syn::ItemExternCrate) {
            if let Some(alias) = extern_rename(item_extern) {
                let what = format!(
                    "extern crate use as rename binding {alias} inside fn {}",
                    self.ctx.fn_name
                );
                self.refuse(what);
            }
            syn::visit::visit_item_extern_crate(self, item_extern);
        }
    }

    /// One pass over a whole body, or over a single depth-0 statement when the
    /// caller only wants that statement's writes and calls.
    fn scan(block: &syn::Block, stmt: Option<&Stmt>, ctx: &ScanCtx) -> BodyFacts {
        let mut scan = BodyScan::new(ctx);
        match stmt {
            Some(one) => scan.visit_stmt(one),
            None => scan.visit_block(block),
        }
        scan.facts
    }

    // --- Gate shapes --------------------------------------------------------

    fn call_path(expr: &Expr) -> Option<&syn::ExprPath> {
        let Expr::Call(call) = expr else { return None };
        let Expr::Path(path) = &*call.func else {
            return None;
        };
        if path.qself.is_some() {
            return None;
        }
        Some(path)
    }

    fn wrapper_call(expr: &Expr) -> bool {
        let Some(path) = call_path(expr) else {
            return false;
        };
        let segments = path_segments(&path.path);
        segments.len() == 3
            && segments[0] == ROOT
            && segments[1] == GUARD_MODULE
            && GATE_WRAPPERS.contains(&segments[2].as_str())
    }

    /// Shape (b)'s condition is EXACTLY the pending-deletion call. A compound
    /// condition decides on something else as well, so the branch no longer
    /// means "pending deletion" and is not a gate.
    fn pending_call(expr: &Expr, module: &str) -> bool {
        let Some(path) = call_path(expr) else {
            return false;
        };
        let segments = path_segments(&path.path);
        let qualified = segments.len() == 3
            && segments[0] == ROOT
            && segments[1] == ACCOUNT_MODULE
            && segments[2] == PENDING_PREDICATE;
        let bare =
            segments.len() == 1 && segments[0] == PENDING_PREDICATE && module == ACCOUNT_MODULE;
        qualified || bare
    }

    /// A gate's branch must REFUSE. `return Ok(())` is a silent commit.
    fn refusing_return(stmt: Option<&Stmt>) -> bool {
        let Some(Stmt::Expr(Expr::Return(returned), _)) = stmt else {
            return false;
        };
        match &returned.expr {
            Some(expr) => call_path(expr).is_none_or(|path| path_tail(&path.path) != OK_VARIANT),
            None => true,
        }
    }

    /// The two gate shapes, at the reducer body's depth 0 and nowhere else.
    fn is_gate(stmt: &Stmt, module: &str) -> bool {
        match stmt {
            Stmt::Expr(Expr::Try(attempt), Some(_)) => wrapper_call(&attempt.expr),
            Stmt::Expr(Expr::If(branch), _) => {
                pending_call(&branch.cond, module)
                    && refusing_return(branch.then_branch.stmts.last())
            }
            _ => false,
        }
    }

    // --- The scheduler-identity guard ---------------------------------------

    fn zero_arg_method(expr: &Expr) -> Option<(String, String)> {
        let Expr::MethodCall(call) = expr else {
            return None;
        };
        if !call.args.is_empty() {
            return None;
        }
        let Expr::Path(path) = &*call.receiver else {
            return None;
        };
        let receiver = path.path.get_ident()?;
        Some((receiver.to_string(), call.method.to_string()))
    }

    /// The Scheduled exemption rests on "a player can never be the caller", so
    /// it is only earned by a reducer whose FIRST statement refuses one.
    fn opens_with_scheduler_guard(block: &syn::Block) -> bool {
        let Some(Stmt::Expr(Expr::If(branch), _)) = block.stmts.first() else {
            return false;
        };
        let Expr::Binary(comparison) = &*branch.cond else {
            return false;
        };
        if !matches!(comparison.op, syn::BinOp::Ne(_)) {
            return false;
        }
        let (Some(left), Some(right)) = (
            zero_arg_method(&comparison.left),
            zero_arg_method(&comparison.right),
        ) else {
            return false;
        };
        if left.0 != right.0 {
            return false;
        }
        let pair: BTreeSet<&str> = [left.1.as_str(), right.1.as_str()].into_iter().collect();
        let want: BTreeSet<&str> = [SENDER_METHOD, HOST_IDENTITY_METHOD].into_iter().collect();
        pair == want && refusing_return(branch.then_branch.stmts.last())
    }

    // --- The census ---------------------------------------------------------

    struct VerdictInput<'s> {
        idx: usize,
        entry: &'s FnBody,
        argument: Option<&'s str>,
        owners: &'s [&'s str],
        ctx: &'s ScanCtx<'s>,
        facts: &'s [BodyFacts],
        reachable: &'s [BTreeSet<String>],
    }

    impl Corpus {
        fn verdicts(
            &self,
            classified: &BTreeSet<String>,
            owners: &[&str],
        ) -> Result<BTreeMap<String, Verdict>, CensusError> {
            let resolver = Resolver::build(&self.fns, &self.module_set);
            let aliases: Vec<BTreeMap<String, String>> = self
                .fns
                .iter()
                .map(|entry| collect_aliases(&entry.block, classified))
                .collect();
            let contexts: Vec<ScanCtx> = self
                .fns
                .iter()
                .enumerate()
                .map(|(idx, entry)| ScanCtx {
                    classified,
                    aliases: &aliases[idx],
                    bindings: &entry.bindings,
                    resolver: &resolver,
                    module: &entry.module,
                    fn_name: &entry.name,
                })
                .collect();
            let mut facts: Vec<BodyFacts> = Vec::with_capacity(self.fns.len());
            for (idx, entry) in self.fns.iter().enumerate() {
                facts.push(scan(&entry.block, None, &contexts[idx]));
            }
            for (idx, entry) in self.fns.iter().enumerate() {
                if let Some(what) = facts[idx].refusals.first() {
                    return Err(shape(&entry.module, what.clone()));
                }
            }
            let reachable = transitive_writes(&facts);

            let mut verdicts = BTreeMap::new();
            for (idx, entry) in self.fns.iter().enumerate() {
                let Some(argument) = &entry.reducer else {
                    continue;
                };
                let name = entry.name.as_str();
                let owned = owners.contains(&name);
                if self.scheduled.contains(name)
                    && !owned
                    && !reachable[idx].is_empty()
                    && !opens_with_scheduler_guard(&entry.block)
                {
                    let what = format!("scheduler guard missing from the scheduled reducer {name}");
                    return Err(shape(&entry.module, what));
                }
                let verdict = self.verdict_of(VerdictInput {
                    idx,
                    entry,
                    argument: argument.as_deref(),
                    owners,
                    ctx: &contexts[idx],
                    facts: &facts,
                    reachable: &reachable,
                });
                verdicts.insert(entry.name.clone(), verdict);
            }
            Ok(verdicts)
        }

        fn verdict_of(&self, input: VerdictInput) -> Verdict {
            let name = input.entry.name.as_str();
            if input.owners.contains(&name) {
                return Verdict::Owner;
            }
            if input
                .argument
                .is_some_and(|arg| LIFECYCLE_ARGS.contains(&arg))
            {
                return Verdict::Lifecycle;
            }
            if self.scheduled.contains(name) {
                return Verdict::Scheduled;
            }
            let writes = &input.reachable[input.idx];
            if writes.is_empty() {
                return Verdict::NoClassifiedWrites;
            }
            let stmts = &input.entry.block.stmts;
            let first_write_stmt = stmts
                .iter()
                .position(|stmt| {
                    let facts = scan(&input.entry.block, Some(stmt), input.ctx);
                    !facts.writes.is_empty()
                        || facts
                            .calls
                            .iter()
                            .any(|callee| !input.reachable[*callee].is_empty())
                })
                .unwrap_or(0);
            let gate_stmt = stmts
                .iter()
                .position(|stmt| is_gate(stmt, &input.entry.module));
            match gate_stmt {
                Some(gate) if gate < first_write_stmt => Verdict::Gated {
                    gate_stmt: gate,
                    first_write_stmt,
                },
                _ => Verdict::Ungated {
                    writes: writes.clone(),
                    first_write_stmt,
                    gate_stmt,
                    via: self.via_chain(input.idx, input.facts, input.reachable),
                },
            }
        }

        /// The resolved helper chain from a reducer to the first fn that writes
        /// a classified table itself. Empty when the reducer writes directly.
        fn via_chain(
            &self,
            start: usize,
            facts: &[BodyFacts],
            reachable: &[BTreeSet<String>],
        ) -> Vec<String> {
            if !facts[start].writes.is_empty() {
                return Vec::new();
            }
            let mut seen: BTreeSet<usize> = BTreeSet::new();
            seen.insert(start);
            let mut queue: VecDeque<(usize, Vec<String>)> = facts[start]
                .calls
                .iter()
                .map(|callee| (*callee, vec![self.fns[*callee].name.clone()]))
                .collect();
            while let Some((idx, chain)) = queue.pop_front() {
                if !seen.insert(idx) {
                    continue;
                }
                if !facts[idx].writes.is_empty() {
                    return chain;
                }
                if reachable[idx].is_empty() {
                    continue;
                }
                for callee in &facts[idx].calls {
                    let mut next = chain.clone();
                    next.push(self.fns[*callee].name.clone());
                    queue.push_back((*callee, next));
                }
            }
            Vec::new()
        }
    }

    /// Writes(f) = own writes ∪ writes of every crate fn f calls, as a fixpoint
    /// over sets so a call cycle terminates.
    fn transitive_writes(facts: &[BodyFacts]) -> Vec<BTreeSet<String>> {
        let mut reachable: Vec<BTreeSet<String>> =
            facts.iter().map(|entry| entry.writes.clone()).collect();
        loop {
            let mut grew = false;
            for idx in 0..facts.len() {
                let mut merged = reachable[idx].clone();
                for callee in &facts[idx].calls {
                    merged.extend(reachable[*callee].iter().cloned());
                }
                if merged.len() != reachable[idx].len() {
                    reachable[idx] = merged;
                    grew = true;
                }
            }
            if !grew {
                return reachable;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Roster 1 — the declared exemptions (ADR-0258 D6)
//
// Every reducer the census reports as UNGATED must appear here with a basis, and
// every row here must still be ungated: the comparison is exact in BOTH
// directions, never a count and never a floor. Paying the debt down is a
// conscious edit of this roster, and so is widening it.
//
// rb-128 (ADR-0273) paid class (iv) down in full: its thirteen KNOWN-GAP rows
// now open with the caller-only deletion gate and moved to EXPECTED_GATED
// below (25 rows became 12; the gated set grew from 14 to 27). The partition of
// the 54-reducer corpus is 3 owner + 3 lifecycle + 8 scheduled + 27 gated + 1
// no-writes + 12 rostered.
// ---------------------------------------------------------------------------

const DELIBERATE_EXEMPTIONS: &[(&str, &str)] = &[
    // (i) acts on an already-open commitment, which PRV1-10 and ADR-0227 D5 keep
    // completable while a deletion is pending. Every one of these reaches two
    // INSERT-IF-ABSENT helpers on the way out -- economy::grant_currency
    // (player_wallet) and evolution::check_and_evolve (pending_evolution_notice).
    // That is accepted under PRV1-10: during the grace window nothing has been
    // erased yet, so the update arm runs, and any row a helper does mint is swept
    // by the cascade at terminal time. The post-terminal case -- a battle still
    // Ongoing after the cascade ran -- is a REGISTERED RESIDUAL, not a claim of
    // safety.
    (
        "submit_attack",
        "acts on an already-open battle commitment (PRV1-10, ADR-0227 D5); on the way out it \
         reaches the insert-if-absent helpers economy::grant_currency and \
         evolution::check_and_evolve, whose minted rows the cascade sweeps",
    ),
    (
        "swap_active",
        "acts on an already-open battle commitment (PRV1-10, ADR-0227 D5); on the way out it \
         reaches the insert-if-absent helpers economy::grant_currency and \
         evolution::check_and_evolve, whose minted rows the cascade sweeps",
    ),
    (
        "flee",
        "unwinds an already-open battle commitment (PRV1-10, ADR-0227 D5); on the way out it \
         reaches the insert-if-absent helpers economy::grant_currency and \
         evolution::check_and_evolve, whose minted rows the cascade sweeps",
    ),
    (
        "use_battle_item",
        "acts on an already-open battle commitment (PRV1-10, ADR-0227 D5); on the way out it \
         reaches the insert-if-absent helpers economy::grant_currency and \
         evolution::check_and_evolve, whose minted rows the cascade sweeps",
    ),
    (
        "submit_pvp_action",
        "acts on an already-open PvP commitment (PRV1-10, ADR-0227 D5); on the way out it \
         reaches the insert-if-absent helpers economy::grant_currency and \
         evolution::check_and_evolve, whose minted rows the cascade sweeps",
    ),
    (
        "cancel_trade",
        "unwinds an already-open trade commitment (PRV1-10, ADR-0227 D5); on the way out it \
         reaches the insert-if-absent helpers economy::grant_currency and \
         evolution::check_and_evolve, whose minted rows the cascade sweeps",
    ),
    (
        "confirm_trade",
        "closes an already-open trade commitment (PRV1-10, ADR-0227 D5); on the way out it \
         reaches the insert-if-absent helpers economy::grant_currency and \
         evolution::check_and_evolve, whose minted rows the cascade sweeps",
    ),
    (
        "cancel_challenge",
        "unwinds an already-open challenge (PRV1-10, ADR-0227 D5); on the way out it reaches \
         the insert-if-absent helpers economy::grant_currency and \
         evolution::check_and_evolve, whose minted rows the cascade sweeps",
    ),
    (
        "decline_challenge",
        "unwinds an already-open challenge (PRV1-10, ADR-0227 D5); on the way out it reaches \
         the insert-if-absent helpers economy::grant_currency and \
         evolution::check_and_evolve, whose minted rows the cascade sweeps",
    ),
    // (ii) the decline arm runs before the stamp-aware accept gate by design.
    (
        "respond_trade",
        "the decline arm unwinds the offer BEFORE the stamp-aware accept gate (ADR-0237)",
    ),
    // (iii) operator-only surface, unreachable by a player caller.
    (
        "sync_content",
        "operator-only behind the module-owner identity guard; no player caller exists",
    ),
    // (iv) — drained by rb-128 (ADR-0273). Its thirteen KNOWN-GAP rows are gated
    // and listed in EXPECTED_GATED; the class stays EMPTY. A reducer that creates
    // or mutates the caller's assets without a gate fails this census until a
    // deliberate roster row WITH A BASIS is added -- never a silent new row.
    //
    // (v) acts ONLY on rows the caller already owns, minting nothing new. Open BY
    // DECISION (ADR-0254 keeps the evolution banner dismissable during grace),
    // not debt: ADR-0273 left it ungated on purpose.
    (
        "ack_evolution_notices",
        "acts only on the caller's own existing notice queue (find sender then update, never \
         an insert); ADR-0254 keeps the evolution banner dismissable during grace by decision, \
         not by omission",
    ),
];

// ---------------------------------------------------------------------------
// Roster 2 — the structural facts of the REAL crate (ADR-0258 D2, D5)
//
// The corpus is lib.rs plus every bare `mod x;` it declares, in declaration
// order; the two structural exemption sets are pinned EXACTLY so a new free ride
// is a conscious edit rather than a silent widening.
// ---------------------------------------------------------------------------

const EXPECTED_MODULES: &[&str] = &[
    "crate",
    "accounts",
    "battle",
    "content",
    "content_cache",
    "economy",
    "evolution",
    "guards",
    "inventory",
    "marshal",
    "monster_mgmt",
    "movement",
    "npc",
    "observability",
    "playtest",
    "privacy",
    "pvp",
    "raising",
    "ranking",
    "schema",
    "taming",
    "trading",
];

const EXPECTED_LIFECYCLE: &[&str] = &["init", "on_connect", "on_disconnect"];

const EXPECTED_SCHEDULED: &[&str] = &[
    "battle_challenge_reaper",
    "export_bundle_reaper",
    "guest_claim_reaper",
    "movement_tick",
    "mr_heartbeat",
    "playtest_reaper",
    "pvp_deadline_reaper",
    "trade_offer_reaper",
];

/// Every reducer that carries a depth-0 gate before its first write today. Pinned
/// as a SET in both directions: losing a gate is as much a regression as a new
/// ungated writer, and it is the half the exemption roster cannot see.
const EXPECTED_GATED: &[&str] = &[
    "accept_challenge",
    "advance_dialogue",
    "attempt_recruit",
    "buy",
    "care",
    "challenge_pvp",
    "clear_queue",
    "complete_guest_claim",
    "consume_crystalized_essence",
    "dismiss_dialogue",
    "enqueue_move",
    "essence_train",
    "evolve",
    "grant_bait",
    "heal_party",
    "join_game",
    "propose_trade",
    "request_data_export",
    "sell",
    "set_move",
    "set_nickname",
    "set_party_slot",
    "set_profile_name",
    "start_battle",
    "start_wild_battle",
    "talk",
    "train",
];

/// Reducers that reach no classified write at all.
const EXPECTED_NO_WRITES: &[&str] = &["start_guest_claim"];

/// Vacuity floor for the manifest-derived classified set (24 tables at rb-45):
/// the set itself is derived in the test from `DATA_LIFECYCLE_MANIFEST`, so this
/// only refuses a manifest that shrank to nothing.
const CLASSIFIED_TABLE_FLOOR: usize = 24;

/// Reducer floor for the real corpus (54 at rb-45), so the per-reducer verdict
/// pin cannot be satisfied by an engine that finds almost none of them.
const REDUCER_FLOOR: usize = 54;

// ---------------------------------------------------------------------------
// Pure comparison helpers (test-side, never part of the engine)
// ---------------------------------------------------------------------------

/// Compare the census's ungated set against the declared roster in BOTH
/// directions and reject duplicate or basis-less roster rows. The failure
/// message prints each unrostered reducer's write set and helper chain, so a
/// widening is visible in review (ADR-0258 D6: the roster pins WHICH reducers
/// are ungated, not WHAT they write).
fn roster_mismatch(report: &census::Report, roster: &[(&str, &str)]) -> Result<(), String> {
    let rostered: BTreeSet<&str> = roster.iter().map(|&(name, _)| name).collect();
    let duplicates: BTreeSet<&str> = roster
        .iter()
        .map(|&(name, _)| name)
        .filter(|n| roster.iter().filter(|&&(m, _)| m == *n).count() > 1)
        .collect();
    let blank_basis: BTreeSet<&str> = roster
        .iter()
        .filter(|&&(_, basis)| basis.trim().is_empty())
        .map(|&(name, _)| name)
        .collect();
    let ungated = report.ungated();
    let unrostered: Vec<&str> = ungated
        .iter()
        .copied()
        .filter(|n| !rostered.contains(n))
        .collect();
    let stale: Vec<&str> = rostered
        .iter()
        .copied()
        .filter(|n| !ungated.contains(n))
        .collect();
    if duplicates.is_empty() && blank_basis.is_empty() && unrostered.is_empty() && stale.is_empty()
    {
        return Ok(());
    }
    let mut msg = String::from("the deletion-gate census does not match DELIBERATE_EXEMPTIONS");
    if !duplicates.is_empty() {
        msg.push_str(&format!("\n  duplicate roster rows: {duplicates:?}"));
    }
    if !blank_basis.is_empty() {
        msg.push_str(&format!(
            "\n  roster rows with an empty basis: {blank_basis:?}"
        ));
    }
    for name in &unrostered {
        msg.push_str(&format!(
            "\n  UNGATED and unrostered: {name} -- {}",
            describe_verdict(report, name)
        ));
    }
    for name in &stale {
        msg.push_str(&format!(
            "\n  rostered but no longer ungated: {name} -- {}",
            describe_verdict(report, name)
        ));
    }
    Err(msg)
}

/// One reducer's verdict rendered for the roster-failure message.
fn describe_verdict(report: &census::Report, name: &str) -> String {
    match report.verdicts.get(name) {
        Some(census::Verdict::Ungated {
            writes,
            first_write_stmt,
            gate_stmt,
            via,
        }) => {
            let writes: Vec<&str> = writes.iter().map(String::as_str).collect();
            let via: Vec<&str> = via.iter().map(String::as_str).collect();
            format!(
                "writes {writes:?}, first write-reaching statement {first_write_stmt}, \
                 gate statement {gate_stmt:?}, reached via {via:?}"
            )
        }
        Some(other) => format!("{other:?}"),
        None => String::from("no verdict at all"),
    }
}

fn classified_of(names: &[&'static str]) -> BTreeSet<&'static str> {
    names.iter().copied().collect()
}

fn census_of(sources: Vec<(String, String)>, classified: &[&'static str]) -> census::Report {
    let classified = classified_of(classified);
    census::census(&sources, &classified, game_core::STATE_TRANSITION_OWNERS)
        .unwrap_or_else(|e| panic!("the synthetic corpus must census cleanly, got {e:?}"))
}

fn census_one(module: &str, source: String, classified: &[&'static str]) -> census::Report {
    census_of(vec![(module.to_string(), source)], classified)
}

fn verdict_of<'a>(report: &'a census::Report, name: &str) -> &'a census::Verdict {
    report
        .verdicts
        .get(name)
        .unwrap_or_else(|| panic!("every reducer needs a verdict; none for {name}"))
}

fn assert_verdict(report: &census::Report, name: &str, want: census::Verdict) {
    assert_eq!(verdict_of(report, name), &want, "verdict for {name}");
}

/// Assert `name` is ungated with exactly `writes` and `gate_stmt`, and hand back
/// its first write-reaching statement index for the caller to pin.
fn assert_ungated(
    report: &census::Report,
    name: &str,
    writes: &[&str],
    gate_stmt: Option<usize>,
) -> usize {
    match verdict_of(report, name) {
        census::Verdict::Ungated {
            writes: got,
            first_write_stmt,
            gate_stmt: got_gate,
            via: _,
        } => {
            let want: BTreeSet<String> = writes.iter().map(|w| (*w).to_string()).collect();
            assert_eq!(got, &want, "ungated write set for {name}");
            assert_eq!(*got_gate, gate_stmt, "recorded gate statement for {name}");
            *first_write_stmt
        }
        other => panic!("{name} must be ungated, got {other:?}"),
    }
}

fn assert_via_non_empty(report: &census::Report, name: &str) {
    match verdict_of(report, name) {
        census::Verdict::Ungated { via, .. } => {
            assert!(
                !via.is_empty(),
                "the helper chain for {name} must be reported"
            );
        }
        other => panic!("{name} must be ungated, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Fixture builders — EVERY production-looking marker is spelled exactly once
// here, split across `concat!` pieces. Never inline one of these literals.
// ---------------------------------------------------------------------------

const CTX_DB: &str = concat!("ctx", ".db.");
const GUARDS_PATH: &str = concat!("crate::guards", "::");
const ACCOUNTS_PATH: &str = concat!("crate::accounts", "::");
const PENDING_PRED: &str = concat!("is_pending_", "deletion");
const REDUCER_CTX: &str = "ctx: &ReducerContext";
const OK_TAIL: &str = "Ok(())";

/// The qualified reducer-attribute head. Spelled ONCE here, split so it is never
/// contiguous in this file; the real-crate test counts reducers with this needle.
const REDUCER_ATTR_HEAD: &str = concat!("#[spacetimedb", "::reducer");

fn fixture_reducer_attr(arg: &str) -> String {
    if arg.is_empty() {
        format!("{REDUCER_ATTR_HEAD}]")
    } else {
        format!("{REDUCER_ATTR_HEAD}({arg})]")
    }
}

/// The bare spelling the engine must also accept.
fn fixture_reducer_attr_bare() -> String {
    String::from(concat!("#[re", "ducer]"))
}

fn fixture_table_attr(accessor: &str, extra: &str) -> String {
    let head = concat!("#[spacetimedb", "::table(", "accessor", " = ");
    if extra.is_empty() {
        format!("{head}{accessor})]")
    } else {
        format!("{head}{accessor}, {extra})]")
    }
}

fn fixture_sched_arg(reducer: &str) -> String {
    format!("{}{reducer})", concat!("schedul", "ed("))
}

fn fixture_table_item(accessor: &str, extra: &str, type_name: &str) -> String {
    format!(
        "{}\npub struct {type_name} {{\n    pub id: u64,\n}}\n\n",
        fixture_table_attr(accessor, extra)
    )
}

fn fixture_handle(accessor: &str) -> String {
    format!("{CTX_DB}{accessor}()")
}

fn fixture_method(receiver: &str, name: &str, args: &str) -> String {
    format!("{receiver}.{name}({args})")
}

fn fixture_write_stmt(accessor: &str, verb: &str) -> String {
    format!(
        "{};",
        fixture_method(&fixture_handle(accessor), verb, "row")
    )
}

/// The same write spelled across TWO source lines: a statement-index engine sees
/// one statement, a line-offset engine sees two and misreports every later index.
fn fixture_write_stmt_wrapped(accessor: &str, verb: &str) -> String {
    format!("{}\n        .{verb}(row);", fixture_handle(accessor))
}

/// One call to a gate-named wrapper, under an arbitrary path `prefix` and with an
/// arbitrary `suffix` — only the fully-qualified `?;` spelling is a gate.
fn fixture_gate_call(prefix: &str, wrapper: &str, suffix: &str) -> String {
    format!("{prefix}{wrapper}(ctx, tag){suffix}")
}

fn fixture_gate_stmt(wrapper: &str) -> String {
    fixture_gate_call(GUARDS_PATH, wrapper, "?;")
}

fn fixture_discarded_gate() -> String {
    format!(
        "let _ = {}",
        fixture_gate_call(GUARDS_PATH, "require_not_deleting", ";")
    )
}

/// Gate shape (b): `prefix` is the qualifying path, an empty string for the bare
/// spelling inside the accounts module, or a negation for the non-gate shape.
fn fixture_pending_if(prefix: &str, body: &str) -> String {
    format!("if {prefix}{PENDING_PRED}(ctx, me) {{ {body} }}")
}

/// The scheduler-identity guard every scheduled reducer must open with (ADR-0258
/// D5, the ea and g7 needles): without it a player can call the reducer directly
/// and the Scheduled exemption would be a free ride past the para 4.7 gate.
fn fixture_scheduler_guard() -> String {
    format!(
        "if ctx.sender() != ctx.{}() {{ return Err(e); }}",
        concat!("database_", "identity")
    )
}

fn fixture_reducer(attr: &str, name: &str, extra_params: &str, body: &[String]) -> String {
    let mut out = String::from(attr);
    out.push('\n');
    out.push_str(&format!(
        "pub fn {name}({REDUCER_CTX}{extra_params}) -> Result<(), String> {{\n"
    ));
    for stmt in body {
        out.push_str("    ");
        out.push_str(stmt);
        out.push('\n');
    }
    out.push_str("}\n\n");
    out
}

fn fixture_helper_fn(name: &str, body: &[String]) -> String {
    let mut out = format!("pub(crate) fn {name}({REDUCER_CTX}) {{\n");
    for stmt in body {
        out.push_str("    ");
        out.push_str(stmt);
        out.push('\n');
    }
    out.push_str("}\n\n");
    out
}

const SYNTH_UNGATED: &str = "synth_ungated_writer";

/// THE mandated tooth's payload: one table and one reducer that writes it with
/// no gate anywhere in the body.
fn fixture_synthetic_ungated_module() -> String {
    let mut src = fixture_table_item("monster", "", "SynthMonster");
    src.push_str(&fixture_reducer(
        &fixture_reducer_attr(""),
        SYNTH_UNGATED,
        "",
        &[
            fixture_write_stmt("monster", "insert"),
            String::from(OK_TAIL),
        ],
    ));
    src
}

// ---------------------------------------------------------------------------
// The gating tests
// ---------------------------------------------------------------------------

#[test]
fn rb45_synthetic_ungated_reducer_is_flagged() {
    let synthetic = fixture_synthetic_ungated_module();

    let alone = census_one("synth", synthetic.clone(), &["monster"]);
    let first_write = assert_ungated(&alone, SYNTH_UNGATED, &["monster"], None);
    assert_eq!(
        first_write, 0,
        "the unguarded insert is statement 0 of the body"
    );

    let classified = census::classified_tables();
    let owners = game_core::STATE_TRANSITION_OWNERS;

    let mut injected_sources = census::real_sources().expect("real_sources must read the crate");
    injected_sources.push((String::from("synth"), synthetic));
    let injected = census::census(&injected_sources, &classified, owners)
        .expect("the real corpus plus one synthetic module must census cleanly");
    let failure = roster_mismatch(&injected, DELIBERATE_EXEMPTIONS)
        .expect_err("an injected ungated writer must fail the roster comparison");
    assert!(
        failure.contains(SYNTH_UNGATED),
        "the roster failure must name the offending reducer, got: {failure}"
    );

    let real_sources = census::real_sources().expect("real_sources must read the crate");
    let real = census::census(&real_sources, &classified, owners)
        .expect("the real corpus must census cleanly");
    if let Err(msg) = roster_mismatch(&real, DELIBERATE_EXEMPTIONS) {
        panic!("{msg}");
    }
}

#[test]
fn rb45_gate_after_the_first_write_is_ungated() {
    let attr = fixture_reducer_attr("");
    let mut src = fixture_table_item("monster", "", "SynthMonster");
    src.push_str(&fixture_reducer(
        &attr,
        "late_gate",
        "",
        &[
            fixture_write_stmt_wrapped("monster", "insert"),
            fixture_gate_stmt("require_not_deleting"),
            String::from(OK_TAIL),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "late_pending_gate",
        "",
        &[
            fixture_write_stmt("monster", "insert"),
            String::from("let me = ctx.sender();"),
            fixture_pending_if(ACCOUNTS_PATH, "return Err(e);"),
            String::from(OK_TAIL),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "nested_write_before_gate",
        "",
        &[
            format!("if flag {{ {} }}", fixture_write_stmt("monster", "insert")),
            fixture_gate_stmt("require_not_deleting"),
            String::from(OK_TAIL),
        ],
    ));

    let report = census_one("synth", src, &["monster"]);
    let first_write = assert_ungated(&report, "late_gate", &["monster"], Some(1));
    assert_eq!(
        first_write, 0,
        "the write is statement 0 and the gate is statement 1"
    );
    let first_write = assert_ungated(&report, "late_pending_gate", &["monster"], Some(2));
    assert_eq!(
        first_write, 0,
        "gate shape (b) at statement 2 is still after the write"
    );
    let first_write = assert_ungated(&report, "nested_write_before_gate", &["monster"], Some(1));
    assert_eq!(
        first_write, 0,
        "a write nested inside statement 0 makes statement 0 the first write-reaching one"
    );
}

#[test]
fn rb45_conditional_nested_negated_or_discarded_gate_is_not_a_gate() {
    let gate = fixture_gate_stmt("require_not_deleting");
    let write = fixture_write_stmt("monster", "insert");
    let attr = fixture_reducer_attr("");
    let mut src = fixture_table_item("monster", "", "SynthMonster");

    src.push_str(&fixture_reducer(
        &attr,
        "gate_under_a_condition",
        "",
        &[format!("if flag {{ {gate} }}"), write.clone()],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_inside_a_block",
        "",
        &[format!("{{ {gate} }}"), write.clone()],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_under_a_negation",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if(&format!("!{ACCOUNTS_PATH}"), "return Err(e);"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_with_a_discarded_verdict",
        "",
        &[fixture_discarded_gate(), write.clone()],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_hidden_in_a_helper",
        "",
        &[String::from("helper_that_gates(ctx)?;"), write.clone()],
    ));
    src.push_str(&fixture_helper_fn("helper_that_gates", &[gate]));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_without_a_return",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if(ACCOUNTS_PATH, "log_something();"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_without_the_question_mark",
        "",
        &[
            fixture_gate_call(GUARDS_PATH, "require_not_deleting", ";"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_with_an_ok_suffix",
        "",
        &[
            fixture_gate_call(GUARDS_PATH, "require_not_deleting", ".ok();"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "gate_without_full_qualification",
        "",
        &[
            fixture_gate_call("guards::", "require_not_deleting", "?;"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "bare_gate_name",
        "",
        &[
            fixture_gate_call("", "require_not_deleting", "?;"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "bare_predicate_outside_accounts",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if("", "return Err(e);"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "return_not_last_in_then_branch",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if(
                ACCOUNTS_PATH,
                "if other { return Err(e); } log_something();",
            ),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "predicate_in_compound_condition",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if(&format!("flag && {ACCOUNTS_PATH}"), "return Err(e);"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "negated_predicate_in_compound_condition",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if(&format!("flag && !{ACCOUNTS_PATH}"), "return Err(e);"),
            write.clone(),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "predicate_gate_returning_ok",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if(ACCOUNTS_PATH, &format!("return {OK_TAIL};")),
            write,
        ],
    ));

    let report = census_one("synth", src, &["monster"]);
    for name in [
        "gate_under_a_condition",
        "gate_inside_a_block",
        "gate_under_a_negation",
        "gate_with_a_discarded_verdict",
        "gate_hidden_in_a_helper",
        "gate_without_a_return",
        "gate_without_the_question_mark",
        "gate_with_an_ok_suffix",
        "gate_without_full_qualification",
        "bare_gate_name",
        "bare_predicate_outside_accounts",
        "return_not_last_in_then_branch",
        "predicate_in_compound_condition",
        "negated_predicate_in_compound_condition",
        "predicate_gate_returning_ok",
    ] {
        assert_ungated(&report, name, &["monster"], None);
    }
}

#[test]
fn rb45_table_handle_alias_write_is_a_write() {
    let attr = fixture_reducer_attr("");
    let mut src = fixture_table_item("battle", "", "SynthBattle");
    src.push_str(&fixture_table_item("character", "", "SynthCharacter"));

    src.push_str(&fixture_reducer(
        &attr,
        "writes_through_a_handle_alias",
        "",
        &[
            format!("let battles = {};", fixture_handle("battle")),
            format!(
                "{};",
                fixture_method(&fixture_method("battles", "battle_id", ""), "update", "row")
            ),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "writes_through_an_index_alias",
        "",
        &[
            format!(
                "let h = {};",
                fixture_method(&fixture_handle("battle"), "battle_id", "")
            ),
            format!("{};", fixture_method("h", "delete", "1")),
        ],
    ));
    let found_row = fixture_method(
        &fixture_method(
            &fixture_method(&fixture_handle("character"), "entity_id", ""),
            "find",
            "1",
        ),
        "unwrap",
        "",
    );
    src.push_str(&fixture_reducer(
        &attr,
        "clears_a_field_of_a_found_row",
        "",
        &[
            format!("let row = {found_row};"),
            format!("{};", fixture_method("row.move_queue", "clear", "")),
        ],
    ));

    let report = census_one("synth", src, &["battle", "character"]);
    let first = assert_ungated(&report, "writes_through_a_handle_alias", &["battle"], None);
    assert_eq!(
        first, 1,
        "the alias binding is statement 0; the write is statement 1"
    );
    let first = assert_ungated(&report, "writes_through_an_index_alias", &["battle"], None);
    assert_eq!(
        first, 1,
        "the alias binding is statement 0; the write is statement 1"
    );
    assert_verdict(
        &report,
        "clears_a_field_of_a_found_row",
        census::Verdict::NoClassifiedWrites,
    );
}

#[test]
fn rb45_helper_delegated_write_is_a_write() {
    let attr = fixture_reducer_attr("");
    let write = fixture_write_stmt("player_wallet", "insert");

    let mut synth = fixture_table_item("player_wallet", "", "SynthWallet");
    synth.push_str(&fixture_reducer(
        &attr,
        "spends_through_a_same_module_helper",
        "",
        &[String::from("pay(ctx);"), String::from(OK_TAIL)],
    ));
    synth.push_str(&fixture_helper_fn("pay", std::slice::from_ref(&write)));
    synth.push_str(&fixture_reducer(
        &attr,
        "spends_through_two_hops",
        "",
        &[
            String::from("crate::economy::grant(ctx);"),
            String::from(OK_TAIL),
        ],
    ));
    synth.push_str(&fixture_reducer(
        &attr,
        "spends_through_a_cycle",
        "",
        &[String::from("a(ctx);"), String::from(OK_TAIL)],
    ));
    synth.push_str(&fixture_helper_fn("a", &[String::from("b(ctx);")]));
    synth.push_str(&fixture_helper_fn(
        "b",
        &[
            String::from("a(ctx);"),
            fixture_write_stmt("player_wallet", "delete"),
        ],
    ));

    let mut economy = fixture_helper_fn("grant", &[String::from("inner(ctx);")]);
    economy.push_str(&fixture_helper_fn("inner", &[write]));

    let report = census_of(
        vec![
            (String::from("synth"), synth),
            (String::from("economy"), economy),
        ],
        &["player_wallet"],
    );
    for name in [
        "spends_through_a_same_module_helper",
        "spends_through_two_hops",
        "spends_through_a_cycle",
    ] {
        let first = assert_ungated(&report, name, &["player_wallet"], None);
        assert_eq!(first, 0, "the delegating call is statement 0 for {name}");
        assert_via_non_empty(&report, name);
    }
}

#[test]
fn rb45_owner_lifecycle_and_scheduled_are_exempt_with_precedence() {
    let owners = game_core::STATE_TRANSITION_OWNERS;
    assert!(
        owners.len() >= 2,
        "this fixture needs two distinct owner names"
    );
    let plain_owner = owners[0];
    let scheduled_owner = owners[owners.len() - 1];
    let attr = fixture_reducer_attr("");
    let write = fixture_write_stmt("monster", "insert");

    let mut src = fixture_table_item("monster", "", "SynthMonster");
    src.push_str(&fixture_table_item(
        "tick_schedule",
        &fixture_sched_arg("tick"),
        "TickSchedule",
    ));
    src.push_str(&fixture_table_item(
        "owner_schedule",
        &fixture_sched_arg(scheduled_owner),
        "OwnerSchedule",
    ));

    let one_write = std::slice::from_ref(&write);
    src.push_str(&fixture_reducer(&attr, plain_owner, "", one_write));
    src.push_str(&fixture_reducer(
        &fixture_reducer_attr("client_connected"),
        "whatever_name",
        "",
        one_write,
    ));
    // The scheduled reducer opens with the scheduler-identity guard: the Scheduled
    // exemption rests on "a player can never be the caller", so it is only earned
    // by a reducer that actually refuses a player caller.
    src.push_str(&fixture_reducer(
        &attr,
        "tick",
        ", _s: TickSchedule",
        &[fixture_scheduler_guard(), write.clone()],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "not_scheduled",
        ", _s: TickSchedule",
        one_write,
    ));
    // Deliberately UNGUARDED, and deliberately an OWNER: the guard requirement
    // exists to earn the SCHEDULED exemption, so it must be scoped to reducers
    // that actually claim it. An owner wins by precedence and is not refused for
    // lacking a guard — pair this with the refused "scheduled reducer without the
    // scheduler guard" row, whose reducer is neither an owner nor guarded.
    src.push_str(&fixture_reducer(&attr, scheduled_owner, "", one_write));

    let report = census_one("synth", src, &["monster"]);
    assert_verdict(&report, plain_owner, census::Verdict::Owner);
    assert_verdict(&report, "whatever_name", census::Verdict::Lifecycle);
    assert_verdict(&report, "tick", census::Verdict::Scheduled);
    assert_ungated(&report, "not_scheduled", &["monster"], None);
    assert_verdict(&report, scheduled_owner, census::Verdict::Owner);
}

#[test]
fn rb45_not_owned_and_foreign_writes_are_not_classified() {
    let attr = fixture_reducer_attr("");
    let mut src = fixture_table_item("monster", "", "SynthMonster");
    src.push_str(&fixture_table_item("config", "", "SynthConfig"));
    src.push_str(&fixture_table_item("player_wallet", "", "SynthWallet"));

    src.push_str(&fixture_reducer(
        &attr,
        "writes_a_not_owned_table",
        "",
        &[
            fixture_write_stmt("config", "insert"),
            String::from(OK_TAIL),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "writes_outside_the_classified_argument",
        "",
        &[
            fixture_write_stmt("player_wallet", "insert"),
            String::from(OK_TAIL),
        ],
    ));
    src.push_str(&fixture_reducer(
        &fixture_reducer_attr_bare(),
        "writes_a_hash_map",
        "",
        &[
            String::from("let mut counts = HashMap::new();"),
            format!("{};", fixture_method("counts", "insert", "key, value")),
        ],
    ));
    src.push_str(&fixture_reducer(
        &attr,
        "clears_a_vec",
        "",
        &[
            String::from("let mut seen = Vec::new();"),
            format!("{};", fixture_method("seen", "clear", "")),
        ],
    ));

    let report = census_one("synth", src, &["monster"]);
    for name in [
        "writes_a_not_owned_table",
        "writes_outside_the_classified_argument",
        "writes_a_hash_map",
        "clears_a_vec",
    ] {
        assert_verdict(&report, name, census::Verdict::NoClassifiedWrites);
    }
}

#[test]
fn rb45_both_gate_shapes_and_every_write_verb_are_recognised() {
    let frozen: BTreeSet<&str> = [
        "insert",
        "try_insert",
        "update",
        "delete",
        "clear",
        "insert_or_update",
        "try_insert_or_update",
    ]
    .into_iter()
    .collect();
    let declared: BTreeSet<&str> = census::WRITE_VERBS.iter().copied().collect();
    assert_eq!(
        declared, frozen,
        "the write-verb roster is frozen by ADR-0258 D3"
    );

    let wrappers = [
        "require_not_deleting",
        "require_subject_not_deleting",
        "require_commitment_predates_deletion",
    ];
    let attr = fixture_reducer_attr("");
    let write = fixture_write_stmt("monster", "insert");
    let mut src = fixture_table_item("monster", "", "SynthMonster");

    for wrapper in wrappers {
        src.push_str(&fixture_reducer(
            &attr,
            &format!("gated_by_{wrapper}"),
            "",
            &[fixture_gate_stmt(wrapper), write.clone()],
        ));
    }
    src.push_str(&fixture_reducer(
        &attr,
        "gated_by_the_pending_predicate",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if(ACCOUNTS_PATH, "return Err(e);"),
            write.clone(),
        ],
    ));
    for &verb in census::WRITE_VERBS {
        src.push_str(&fixture_reducer(
            &attr,
            &format!("ungated_by_{verb}"),
            "",
            &[fixture_write_stmt("monster", verb)],
        ));
    }

    let report = census_one("synth", src, &["monster"]);
    for wrapper in wrappers {
        assert_verdict(
            &report,
            &format!("gated_by_{wrapper}"),
            census::Verdict::Gated {
                gate_stmt: 0,
                first_write_stmt: 1,
            },
        );
    }
    assert_verdict(
        &report,
        "gated_by_the_pending_predicate",
        census::Verdict::Gated {
            gate_stmt: 1,
            first_write_stmt: 2,
        },
    );
    for &verb in census::WRITE_VERBS {
        assert_ungated(&report, &format!("ungated_by_{verb}"), &["monster"], None);
    }

    let mut accounts_src = fixture_table_item("monster", "", "SynthMonster");
    accounts_src.push_str(&fixture_reducer(
        &attr,
        "gated_by_the_bare_predicate",
        "",
        &[
            String::from("let me = ctx.sender();"),
            fixture_pending_if("", "return Err(e);"),
            write,
        ],
    ));
    let accounts_report = census_one("accounts", accounts_src, &["monster"]);
    assert_verdict(
        &accounts_report,
        "gated_by_the_bare_predicate",
        census::Verdict::Gated {
            gate_stmt: 1,
            first_write_stmt: 2,
        },
    );
}

/// One refused shape: the module it lives in, its source, and a keyword the
/// engine's `what` must name it by (compared case-insensitively). The keyword is
/// part of the contract — a hard error that cannot say WHAT it refused is not
/// actionable.
struct RefusedShape {
    label: &'static str,
    module: &'static str,
    source: String,
    keyword: &'static str,
}

fn refused_shapes() -> Vec<RefusedShape> {
    let attr = fixture_reducer_attr("");
    let handle_type = concat!("Table", "Handle");
    let indexed_delete = |receiver: &str| {
        format!(
            "{};",
            fixture_method(&fixture_method(receiver, "monster_id", ""), "delete", "id")
        )
    };

    let mut fn_pointer = fixture_helper_fn("helper", &[]);
    fn_pointer.push_str(&fixture_reducer(
        &attr,
        "binds_a_fn_pointer",
        "",
        &[
            String::from("let f = crate::synth::helper;"),
            String::from("let g = helper;"),
            String::from(OK_TAIL),
        ],
    ));

    let tuple_handle = fixture_reducer(
        &attr,
        "tuple_let_handle",
        "",
        &[
            format!(
                "let (wallets, monsters) = ({}, {});",
                fixture_handle("player_wallet"),
                fixture_handle("monster")
            ),
            indexed_delete("monsters"),
            String::from(OK_TAIL),
        ],
    );

    let deferred_handle = fixture_reducer(
        &attr,
        "deferred_handle_binding",
        "",
        &[
            String::from("let h;"),
            format!("h = {};", fixture_handle("monster")),
            format!("{};", fixture_method("h", "insert", "row")),
            String::from(OK_TAIL),
        ],
    );

    let audit_write = format!("{};", fixture_method("h", "delete", "id"));
    let mut handle_argument = format!(
        "pub(crate) fn audit<T: {}>(h: &T, id: u64) {{\n    {audit_write}\n}}\n\n",
        concat!("spacetimedb::Tab", "le<Row = Monster>")
    );
    handle_argument.push_str(&fixture_reducer(
        &attr,
        "passes_a_handle_as_an_argument",
        "",
        &[
            format!("audit(&{}, 1);", fixture_handle("monster")),
            String::from(OK_TAIL),
        ],
    ));

    let handle_param = format!(
        "pub(crate) fn purge(h: &Monster{}, id: u64) {{\n    {}\n}}\n",
        handle_type,
        indexed_delete("h")
    );

    let mut fn_reference = fixture_helper_fn("ref_target", &[]);
    fn_reference.push_str(&fixture_reducer(
        &attr,
        "binds_a_fn_reference",
        "",
        &[
            String::from("let r = &ref_target;"),
            String::from("r(ctx);"),
            String::from(OK_TAIL),
        ],
    ));

    let mut fn_cast = fixture_helper_fn("cast_target", &[]);
    fn_cast.push_str(&fixture_reducer(
        &attr,
        "casts_a_fn_pointer",
        "",
        &[
            String::from("let c = cast_target as fn(&ReducerContext);"),
            String::from("c(ctx);"),
            String::from(OK_TAIL),
        ],
    ));

    let qself_ufcs = fixture_reducer(
        &attr,
        "writes_by_qself_ufcs",
        "",
        &[
            format!(
                "<Monster{}>::insert(&{}, row);",
                handle_type,
                fixture_handle("monster")
            ),
            String::from(OK_TAIL),
        ],
    );

    let block_rename = fixture_reducer(
        &attr,
        "renames_inside_a_block",
        "",
        &[
            String::from("use crate::economy as e;"),
            String::from("e::grant(ctx);"),
            String::from(OK_TAIL),
        ],
    );

    // A scheduled reducer that is NOT an owner, writes a classified table, and
    // never refuses a player caller. Scope the refusal to exactly that shape: an
    // owner needs no guard (precedence, pinned in the exemption test) and neither
    // does a scheduled reducer that reaches no classified write at all — two real
    // reapers are in that state today.
    let mut unguarded_scheduled = fixture_table_item(
        "tick_schedule",
        &fixture_sched_arg("scheduled_writer"),
        "TickSchedule",
    );
    unguarded_scheduled.push_str(&fixture_reducer(
        &attr,
        "scheduled_writer",
        ", _s: TickSchedule",
        &[
            fixture_write_stmt("monster", "insert"),
            String::from(OK_TAIL),
        ],
    ));

    vec![
        RefusedShape {
            label: "an item-position macro invocation",
            module: "synth",
            source: String::from("synth_macro! { }\n"),
            keyword: "macro",
        },
        RefusedShape {
            label: "a crate-local macro definition",
            module: "synth",
            source: String::from(concat!("macro_", "rules! synth { () => {} }\n")),
            keyword: "macro",
        },
        RefusedShape {
            label: "a nested mod inside a scanned module",
            module: "synth",
            source: String::from("mod inner;\n"),
            keyword: "mod",
        },
        RefusedShape {
            label: "an inline nested mod inside a scanned module",
            module: "synth",
            source: String::from("mod inline_inner {}\n"),
            keyword: "mod",
        },
        RefusedShape {
            label: "a crate-root mod under an inverted cfg",
            module: "crate",
            source: String::from(concat!("#[cf", "g(not(test))]\nmod hidden;\n")),
            keyword: "cfg",
        },
        RefusedShape {
            label: "a crate-root mod carrying only a path attribute",
            module: "crate",
            source: String::from(concat!("#[pa", "th = \"hidden.rs\"]\nmod hidden_path;\n")),
            keyword: "mod",
        },
        RefusedShape {
            label: "an import rename",
            module: "synth",
            source: String::from("use crate::schema::monster as m;\n"),
            keyword: "use as",
        },
        RefusedShape {
            label: "a fn-pointer let binding of a crate fn",
            module: "synth",
            source: fn_pointer,
            keyword: "pointer",
        },
        RefusedShape {
            label: "an impl-block fn that takes a reducer context",
            module: "synth",
            source: format!(
                "{}SynthThing {{\n    pub fn run({REDUCER_CTX}) {{}}\n}}\n",
                concat!("imp", "l ")
            ),
            keyword: "impl",
        },
        RefusedShape {
            label: "a helper returning a table handle",
            module: "synth",
            source: format!(
                "pub(crate) fn handle_of({REDUCER_CTX}) -> {} {{\n    lookup(ctx)\n}}\n",
                concat!("Table", "Handle")
            ),
            keyword: "handle",
        },
        RefusedShape {
            label: "a UFCS write spelling",
            module: "synth",
            source: fixture_reducer(
                &attr,
                "writes_by_ufcs",
                "",
                &[
                    format!("{}delete(&h, row);", concat!("Table", "::")),
                    String::from(OK_TAIL),
                ],
            ),
            keyword: "ufcs",
        },
        RefusedShape {
            label: "a procedure item",
            module: "synth",
            source: fixture_reducer(
                concat!("#[proce", "dure]"),
                "a_procedure",
                "",
                &[String::from(OK_TAIL)],
            ),
            keyword: "procedure",
        },
        RefusedShape {
            label: "a gate-named fn defined outside the guards module",
            module: "synth",
            source: format!(
                "pub(crate) fn require_not_deleting({REDUCER_CTX}, tag: &str) -> Result<(), \
                 String> {{\n    {OK_TAIL}\n}}\n"
            ),
            keyword: "shadow",
        },
        RefusedShape {
            label: "a tuple let binding of two table handles",
            module: "synth",
            source: tuple_handle,
            keyword: "handle",
        },
        RefusedShape {
            label: "a deferred-init handle binding",
            module: "synth",
            source: deferred_handle,
            keyword: "handle",
        },
        RefusedShape {
            label: "a handle passed as a call argument to a generic helper",
            module: "synth",
            source: handle_argument,
            keyword: "handle",
        },
        RefusedShape {
            label: "a helper with a handle-typed parameter",
            module: "synth",
            source: handle_param,
            keyword: "handle",
        },
        RefusedShape {
            label: "a fn-pointer binding taken by reference",
            module: "synth",
            source: fn_reference,
            keyword: "pointer",
        },
        RefusedShape {
            label: "a fn-pointer binding made by cast",
            module: "synth",
            source: fn_cast,
            keyword: "pointer",
        },
        RefusedShape {
            label: "a qualified-self UFCS write spelling",
            module: "synth",
            source: qself_ufcs,
            keyword: "ufcs",
        },
        RefusedShape {
            label: "a type alias naming the reducer context",
            module: "synth",
            source: String::from("pub type Rc<'a> = &'a ReducerContext;\n"),
            keyword: "alias",
        },
        RefusedShape {
            label: "a type alias naming a table handle",
            module: "synth",
            source: format!("pub type H = Monster{handle_type};\n"),
            keyword: "alias",
        },
        RefusedShape {
            label: "a module rename inside a fn body",
            module: "synth",
            source: block_rename,
            keyword: "use as",
        },
        RefusedShape {
            label: "an extern crate rename",
            module: "synth",
            source: String::from("extern crate serde as s;\n"),
            keyword: "use as",
        },
        RefusedShape {
            label: "a crate-root inline mod carrying no attribute",
            module: "crate",
            source: String::from("mod crate_inner { pub fn f() {} }\n"),
            keyword: "mod",
        },
        RefusedShape {
            label: "a scheduled reducer without the scheduler guard",
            module: "synth",
            source: unguarded_scheduled,
            keyword: "scheduler guard",
        },
    ]
}

/// Shapes the engine must NOT refuse, each as a whole corpus: over-reaching here
/// reds the real crate, which spells every one of these in `lib.rs` today.
fn accepted_shapes() -> Vec<(&'static str, Vec<(String, String)>)> {
    let cfg_test = concat!("#[cf", "g(test)]");
    let path_attr = concat!("#[pa", "th = \"synth_tests.rs\"]");
    let allow_attr = concat!("#[all", "ow(unused_imports)]");
    let doc_attr = concat!("#[d", "oc = \"the battle domain\"]");
    let one = |module: &str, source: String| vec![(String::from(module), source)];
    let encounter_fn =
        format!("pub(crate) fn table_of({REDUCER_CTX}) -> EncounterTable {{\n    q()\n}}\n");
    vec![
        (
            "a test-only mod at the crate root",
            one("crate", format!("{cfg_test}\nmod synth_tests;\n")),
        ),
        (
            "a test-only path mod at the crate root, the rb-77 wiring form",
            one(
                "crate",
                format!("{cfg_test}\n{path_attr}\nmod synth_tests;\n"),
            ),
        ),
        (
            "a test-only path mod that also carries an allow attribute",
            one(
                "crate",
                format!("{cfg_test}\n{path_attr}\n{allow_attr}\nmod synth_tests;\n"),
            ),
        ),
        (
            "a test-only path mod inside a scanned module",
            one(
                "synth",
                format!("{cfg_test}\n{path_attr}\nmod synth_tests;\n"),
            ),
        ),
        (
            "an inline test-only mod inside a scanned module",
            one("synth", format!("{cfg_test}\nmod tests {{}}\n")),
        ),
        (
            "a doc-commented production mod at the crate root",
            vec![
                (String::from("crate"), format!("{doc_attr}\nmod battle;\n")),
                (String::from("battle"), String::new()),
            ],
        ),
        (
            "an underscore import of a trait, which binds no alias",
            one(
                "synth",
                String::from(concat!("use spacetimedb::Tab", "le as _;\n")),
            ),
        ),
        (
            "a helper returning an encounter table",
            one("synth", encounter_fn),
        ),
    ]
}

#[test]
fn rb45_unsupported_shapes_are_hard_errors() {
    let owners = game_core::STATE_TRANSITION_OWNERS;
    let classified = classified_of(&["monster"]);

    let rows = refused_shapes();
    assert_eq!(
        rows.len(),
        26,
        "every refused shape in ADR-0258 D2 needs a row"
    );
    let distinct: BTreeSet<String> = rows
        .iter()
        .map(|row| {
            let sources = vec![(String::from(row.module), row.source.clone())];
            match census::census(&sources, &classified, owners) {
                Err(census::CensusError::UnsupportedShape { module, what }) => {
                    assert_eq!(module, row.module, "module reported for {}", row.label);
                    assert!(
                        what.to_lowercase().contains(row.keyword),
                        "the refusal for {} must name it with the keyword {}, got: {what}",
                        row.label,
                        row.keyword
                    );
                    what
                }
                other => {
                    panic!(
                        "{} must be refused as an unsupported shape, got {other:?}",
                        row.label
                    )
                }
            }
        })
        .collect();
    assert_eq!(
        distinct.len(),
        rows.len(),
        "each refused shape needs its OWN message; one catch-all cannot serve them all"
    );

    let broken = vec![(String::from("synth"), String::from("pub fn ( {"))];
    assert!(
        matches!(
            census::census(&broken, &classified, owners),
            Err(census::CensusError::Parse { .. })
        ),
        "unparseable source must be a parse error, never an empty census"
    );

    let twin = fixture_reducer(
        &fixture_reducer_attr(""),
        "twin",
        "",
        &[String::from(OK_TAIL)],
    );
    let duplicated = vec![
        (String::from("synth"), twin.clone()),
        (String::from("economy"), twin),
    ];
    assert!(
        matches!(
            census::census(&duplicated, &classified, owners),
            Err(census::CensusError::DuplicateReducer { .. })
        ),
        "one reducer name may carry only one verdict"
    );

    let accepted = accepted_shapes();
    assert_eq!(
        accepted.len(),
        8,
        "the accepted shapes keep the refusals from over-reaching"
    );
    for (label, sources) in accepted {
        census::census(&sources, &classified, owners)
            .unwrap_or_else(|e| panic!("{label} must be accepted, got {e:?}"));
    }
}

#[test]
fn rb45_real_crate_matches_the_rosters() {
    let derived: BTreeSet<&str> = crate::schema::DATA_LIFECYCLE_MANIFEST
        .iter()
        .filter(|entry| !matches!(entry.policy, crate::schema::DeletionPolicy::NotOwned))
        .map(|entry| entry.table)
        .collect();
    assert!(
        derived.len() >= CLASSIFIED_TABLE_FLOOR,
        "the manifest classifies {} tables, below the rb-45 floor",
        derived.len()
    );
    let classified = census::classified_tables();
    assert_eq!(
        classified, derived,
        "the classified set IS the manifest minus NotOwned"
    );
    for table in ["monster", "battle", "pvp_deadline_schedule"] {
        assert!(classified.contains(table), "{table} is manifest-classified");
    }
    assert!(
        !classified.contains("config"),
        "a not-owned table is out of scope"
    );

    let owners = game_core::STATE_TRANSITION_OWNERS;
    let sources = census::real_sources().expect("real_sources must read the crate");
    let report =
        census::census(&sources, &classified, owners).expect("the real corpus must census cleanly");

    let want_n: usize = sources
        .iter()
        .map(|(_, source)| {
            source
                .lines()
                .filter(|line| line.trim_start().starts_with(REDUCER_ATTR_HEAD))
                .count()
        })
        .sum();
    assert!(
        want_n >= REDUCER_FLOOR,
        "the corpus carries {want_n} reducer attributes, below the rb-45 floor"
    );
    assert_eq!(
        report.verdicts.len(),
        want_n,
        "every reducer attribute in the corpus gets exactly one verdict"
    );

    if let Err(msg) = roster_mismatch(&report, DELIBERATE_EXEMPTIONS) {
        panic!("{msg}");
    }

    let lifecycle: BTreeSet<&str> = EXPECTED_LIFECYCLE.iter().copied().collect();
    assert_eq!(
        report.names_with(|v| matches!(v, census::Verdict::Lifecycle)),
        lifecycle,
        "the lifecycle exemption set is pinned exactly"
    );

    let scheduled: BTreeSet<&str> = EXPECTED_SCHEDULED.iter().copied().collect();
    assert_eq!(
        report.names_with(|v| matches!(v, census::Verdict::Scheduled)),
        scheduled,
        "the scheduled exemption set is pinned exactly"
    );

    let owner_set: BTreeSet<&str> = owners.iter().copied().collect();
    assert_eq!(
        report.names_with(|v| matches!(v, census::Verdict::Owner)),
        owner_set,
        "every owner is a real reducer and nothing else is exempt as one"
    );

    let gated: BTreeSet<&str> = EXPECTED_GATED.iter().copied().collect();
    assert_eq!(
        report.names_with(|v| matches!(v, census::Verdict::Gated { .. })),
        gated,
        "the gated set is pinned exactly, so losing a gate fails CI too"
    );

    let no_writes: BTreeSet<&str> = EXPECTED_NO_WRITES.iter().copied().collect();
    assert_eq!(
        report.names_with(|v| matches!(v, census::Verdict::NoClassifiedWrites)),
        no_writes,
        "only these reducers reach no classified write at all"
    );

    assert_eq!(
        report.modules.first().map(String::as_str),
        Some("crate"),
        "lib.rs is the first corpus entry"
    );
    let modules: Vec<&str> = report.modules.iter().map(String::as_str).collect();
    assert_eq!(
        modules,
        EXPECTED_MODULES.to_vec(),
        "the corpus is lib.rs plus its bare mods"
    );

    for name in ["grant_bait", "start_wild_battle"] {
        assert!(
            matches!(verdict_of(&report, name), census::Verdict::Gated { .. }),
            "{name} is gated today and is scanned even though its cfg hides it"
        );
    }

    for &(name, _basis) in DELIBERATE_EXEMPTIONS {
        assert!(
            report.verdicts.contains_key(name),
            "roster row {name} names a reducer that no longer exists"
        );
    }
}
