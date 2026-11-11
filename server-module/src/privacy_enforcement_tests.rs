//! The [DEL-06] crate-wide deletion-gate census.
//!
//! EARS under gate. WHEN a reducer writes any manifest-classified table
//! without the gate call or `STATE_TRANSITION_OWNERS` membership THE SYSTEM
//! SHALL fail CI. WHEN a reducer writes any manifest-classified
//! table outside `STATE_TRANSITION_OWNERS` THE SYSTEM SHALL require a preceding
//! deletion-guard call — a `require_*` wrapper over the rejection predicate,
//! spelled as ADR-0248 D1 pins it — mechanically enforced.
//!
//! OWNERSHIP SPLIT. The `rb45_*` tests and the rosters below are GATING: they are
//! revised from ADR-0258 and the slice plan, NEVER edited to fit an engine. The
//! `census` module is the implementation half; the rest of the file is its contract.

use std::collections::BTreeSet;

// ---------------------------------------------------------------------------
// The census engine (implementation half)
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
    // a hard error, never an approximation.

    const ROOT: &str = "crate";
    const GUARD_MODULE: &str = "guards";
    const ACCOUNT_MODULE: &str = "accounts";
    const SELF_SEGMENT: &str = "self";
    const REQUIRE_NOT_DELETING: &str = "require_not_deleting";
    const REQUIRE_SUBJECT: &str = "require_subject_not_deleting";
    const REQUIRE_COMMITMENT: &str = "require_commitment_predates_deletion";
    const PENDING_PREDICATE: &str = "is_pending_deletion";
    const REJECT_PREDICATE: &str = "should_reject_for_deletion";
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
    const HANDLE_SUFFIX: &str = "TableHandle";
    const TABLE_TRAIT: &str = "Table";
    const CTX_TYPE: &str = "ReducerContext";
    const SENDER_METHOD: &str = "sender";
    const HOST_IDENTITY_METHOD: &str = "database_identity";
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
// Roster 1 — the declared exemptions
//
// Every reducer the census reports as UNGATED must appear here with a basis, and
// every row here must still be ungated: the comparison is exact in BOTH
// directions, never a count and never a floor. Paying the debt down is a
// conscious edit of this roster, and so is widening it.
//
// ---------------------------------------------------------------------------

const DELIBERATE_EXEMPTIONS: &[(&str, &str)] = &[
    // (i) acts on an already-open commitment, which PRV1-10 and ADR-0227 D5 keep
    // completable while a deletion is pending. Every one of these except
    // cancel_trade and cancel_trade_session (which only delete) reaches two
    // INSERT-IF-ABSENT helpers on the way out -- economy::grant_currency
    // (player_wallet) and evolution::check_and_evolve (pending_evolution_notice).
    // That is accepted under PRV1-10: during the grace window nothing has been
    // erased yet, so the update arm runs, and any row a helper does mint is swept
    // by the cascade at terminal time. The post-terminal case -- a battle still
    // Ongoing when step 6c reaches it -- is closed mechanically:
    // battle::anonymize_battles forces every still-Ongoing row terminal against
    // the erased side (a wild row is auto-fled) before tombstoning it,
    // so no erased identity is left a live battle to settle.
    //
    // bt-17 (BT17.1): the five 1v1 battle rows (submit_attack, swap_active, flee,
    // use_battle_item, submit_pvp_action) are gone with the reducers themselves (deleted):
    // a fn that does not exist has no verdict, so its row would be stale.
    (
        "cancel_trade",
        "unwinds an already-open trade offer (PRV1-10, ADR-0227 D5) by deleting the offer row \
         and its reaper schedule row; it inserts and updates nothing, so it mints no row a \
         deleting account could keep",
    ),
    (
        "cancel_trade_session",
        "unwinds an already-open trade session (PRV1-10, ADR-0227 D5) by deleting the session \
         row, its snapshot rows and its reaper schedule row; it inserts and updates nothing, \
         so it mints no row a deleting account could keep",
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
    // (ii) a decline arm that unwinds a commitment BEFORE a stamp-aware accept gate
    // (ADR-0237). No reducer has this shape, so the class is EMPTY:
    // `respond_trade`'s only statement returns the retired-path error (it reads
    // and writes nothing), and `confirm_trade_session` has no decline arm and runs
    // its stamp-aware deletion gate before any write. A reducer of this shape
    // needs a row here with its basis.
    //
    // (iii) operator-only surface, unreachable by a player caller.
    (
        "sync_content",
        "operator-only behind the module-owner identity guard; no player caller exists",
    ),
    // (iv) the class stays EMPTY. A reducer that creates or mutates the caller's
    // assets without a gate fails this census until a deliberate roster row WITH
    // A BASIS is added -- never a silent new row.
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
// Roster 2 — the structural facts of the REAL crate
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
    "tactics",
    "tactics_settle",
    "taming",
    "trading",
    "trading_session",
];

const EXPECTED_LIFECYCLE: &[&str] = &["init", "on_connect", "on_disconnect"];

const EXPECTED_SCHEDULED: &[&str] = &[
    "battle_challenge_reaper",
    "battle_gc",
    "export_bundle_reaper",
    "guest_claim_reaper",
    "movement_tick",
    "mr_heartbeat",
    "playtest_reaper",
    "pvp_deadline_reaper",
    "tactical_advance",
    "tactical_deadline_fire",
    "trade_offer_reaper",
    "trade_session_reaper",
];

/// Every reducer that carries a depth-0 gate before its first write today. Pinned
/// as a SET in both directions: losing a gate is as much a regression as a new
/// ungated writer, and it is the half the exemption roster cannot see.
///
/// bt-17 (BT17.1): `start_battle`, `attempt_recruit` (client-callable 1v1 reducers, deleted)
/// and `start_wild_battle` (the dev-only 1v1 start, deleted) leave the set.
const EXPECTED_GATED: &[&str] = &[
    "accept_challenge",
    "advance_dialogue",
    "buy",
    "cancel_queue",
    "care",
    "challenge_pvp",
    "clear_queue",
    "complete_guest_claim",
    "confirm_trade_session",
    "consume_crystalized_essence",
    "deploy_units",
    "dismiss_dialogue",
    "enqueue_move",
    "essence_train",
    "evolve",
    "forfeit",
    "grant_bait",
    "heal_party",
    "join_game",
    "open_trade_session",
    "request_data_export",
    "sell",
    "set_move",
    "set_nickname",
    "set_party_slot",
    "set_profile_name",
    "set_trade_offer",
    "submit_queue",
    "talk",
    "train",
];

/// Reducers that reach no classified write at all: the guest-claim start, and the
/// three retired legacy offer reducers, whose only statement is their fixed error.
const EXPECTED_NO_WRITES: &[&str] = &[
    "confirm_trade",
    "propose_trade",
    "respond_trade",
    "start_guest_claim",
];

/// Vacuity floor for the manifest-derived classified set (24 tables):
/// the set itself is derived in the test from `DATA_LIFECYCLE_MANIFEST`, so this
/// only refuses a manifest that shrank to nothing.
const CLASSIFIED_TABLE_FLOOR: usize = 24;

/// Reducer floor for the real corpus: the 58 reducer attributes it carries
/// (the five trade-session reducers included), so the per-reducer verdict pin
/// cannot be satisfied by an engine that finds almost none of them.
const REDUCER_FLOOR: usize = 58;

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

const CTX_DB: &str = "ctx.db.";
const REDUCER_CTX: &str = "ctx: &ReducerContext";
const OK_TAIL: &str = "Ok(())";

/// The qualified reducer-attribute head. Spelled ONCE here; the real-crate test
/// counts reducers with this needle.
const REDUCER_ATTR_HEAD: &str = "#[spacetimedb::reducer";

fn fixture_reducer_attr(arg: &str) -> String {
    if arg.is_empty() {
        format!("{REDUCER_ATTR_HEAD}]")
    } else {
        format!("{REDUCER_ATTR_HEAD}({arg})]")
    }
}

fn fixture_table_attr(accessor: &str, extra: &str) -> String {
    let head = "#[spacetimedb::table(accessor = ";
    if extra.is_empty() {
        format!("{head}{accessor})]")
    } else {
        format!("{head}{accessor}, {extra})]")
    }
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

/// rb-45 roster census over the real crate. bt-16 (BT16.1): the two dev-gated tactical starts
/// (`dev_start_tactical_pvp`, `dev_start_tactical_wild`) are deleted, so the pinned gated SET no
/// longer names them — while either reducer still exists the both-direction set comparison fails.
///
/// kills: a dev tactical start reducer left in tactics.rs (cfg-gated or not).
#[test]
fn real_crate_matches_the_reducer_rosters_with_no_dev_tactical_start_bt16_1() {
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

    // bt-17 (BT17.1): the `start_wild_battle` arm leaves with the deleted dev-only 1v1 start
    // (a one-element loop would trip clippy's single_element_loop, so the one name is direct).
    assert!(
        matches!(
            verdict_of(&report, "grant_bait"),
            census::Verdict::Gated { .. }
        ),
        "grant_bait is gated today and is scanned even though its cfg hides it"
    );

    for &(name, _basis) in DELIBERATE_EXEMPTIONS {
        assert!(
            report.verdicts.contains_key(name),
            "roster row {name} names a reducer that no longer exists"
        );
    }
}

/// bt-17 (BT17.1): the tables the 1v1 engine wrote and that stay in the schema, retired from use
/// ("no new rows written"): the 1v1 action log, the 1v1 wild roster and the 60 s secret-pick
/// deadline schedule.
const RETIRED_1V1_TABLES: &[&str] = &["battle_action", "battle_wild", "pvp_deadline_schedule"];

/// One synthetic reducer per retired table, each writing it with no gate: the anti-vacuity half
/// of the bt-17 census (the accessor names really are what the census sees).
fn fixture_synthetic_retired_writers() -> String {
    let mut src = String::new();
    for (i, table) in RETIRED_1V1_TABLES.iter().enumerate() {
        src.push_str(&fixture_table_item(table, "", &format!("SynthRetired{i}")));
        src.push_str(&fixture_reducer(
            &fixture_reducer_attr(""),
            &format!("synth_bt17_writes_{table}"),
            "",
            &[fixture_write_stmt(table, "insert"), String::from(OK_TAIL)],
        ));
    }
    src
}

/// The client-callable reducers that legitimately reach `battle_wild` after bt-17, and only by
/// DELETING the rows of a finished 1v1-anchored battle: each tactical reducer that can end a
/// battle runs `tactics::finish` → `tactics_settle::settle` → `battle::sweep_prior_terminals`
/// (the legacy funnel's prior-terminal sweep, run on every `Close` kind), which clears the old
/// anchor's `battle_wild` roster. The census counts every write verb (insert AND delete), so a
/// delete-only sweep is a "reach" — pinned here as an exact set, so a NEW reducer reaching
/// `battle_wild` (an insert path above all) still fails.
const BT17_BATTLE_WILD_SWEEPERS: &[&str] =
    &["cancel_queue", "deploy_units", "forfeit", "submit_queue"];

/// The seven 1v1 reducers bt-17 deletes, plus the deleted dev-only `start_wild_battle`.
const BT17_RETIRED_1V1_REDUCERS: &[&str] = &[
    "start_battle",
    "submit_attack",
    "swap_active",
    "flee",
    "use_battle_item",
    "attempt_recruit",
    "submit_pvp_action",
    "start_wild_battle",
];

/// BT17.1 "retired from use (no new rows written)", as a census over the real crate, run once PER
/// retired table (the classified set narrowed to that one table, NO owner exemption), so every
/// reducer that reaches a write verb on it (gated or not) is listed for that table:
///   (a) `pvp_deadline_schedule` — reached by NO reducer (only `submit_pvp_action` armed it);
///   (b) `battle_action` — reached by EXACTLY the same four (`pvp::settle_pvp_battle`'s stale-action
///       delete under the settle funnel; measured on the purged tree — only `submit_pvp_action` ever
///       INSERTED one);
///   (c) `battle_wild` — reached by EXACTLY [`BT17_BATTLE_WILD_SWEEPERS`] (the tactical terminal
///       sweep's deletes; the 1v1 starts and `write_back_battle_results` callers are gone);
///   (d) none of [`BT17_RETIRED_1V1_REDUCERS`] appears in any table's set.
/// Lifecycle and scheduled reducers keep their own verdicts and are out of scope (the
/// `pvp_deadline_reaper` stays scheduled: its scheduled-ness is fixed at first publish, and it only
/// consumes rows nothing arms).
///
/// Correction (tester round 2, from the spec): round 1 asserted that NO reducer reaches any of the
/// three tables, but BT17.1 says "no NEW rows written", and the census cannot tell an insert from
/// a delete — the four tactical reducers above reach `battle_wild` only through the sweep's delete,
/// which is not a new row. The bite is kept: the exact-set pin on (c) still fails a new writer, and
/// (a), (b) and (d) still fail every 1v1 path.
///
/// RED BEFORE bt-17: `submit_pvp_action` (a client-callable reducer until bt-17, now deleted)
/// reached all three tables (`battle_action`, `pvp_deadline_schedule`, and `battle_wild` through
/// `write_back_battle_results`); `submit_attack`, `swap_active`, `flee` and `attempt_recruit`
/// reached `battle_wild` through the same write-back; `start_wild_battle` inserted `battle_wild`.
///
/// kills: a 1v1 reducer left a reducer (its attribute kept — it then reaches a retired table and the
/// exact-set pins fail); any reducer OUTSIDE the four reaching a retired table; any client-callable
/// reducer reaching `pvp_deadline_schedule` (lifecycle and scheduled reducers keep their own verdicts). NOT killed (the census sees a reach, not a verb): an insert
/// added INSIDE one of the four, or a de-attributed body re-wired into one of them — those are the
/// reviewer's and the continuation's (which deletes the bodies).
#[test]
fn no_reducer_writes_a_retired_1v1_table_bt17_1() {
    let no_owners: &[&str] = &[];
    let writers = |report: &census::Report| -> BTreeSet<String> {
        report
            .names_with(|v| {
                matches!(
                    v,
                    census::Verdict::Gated { .. }
                        | census::Verdict::Ungated { .. }
                        | census::Verdict::Owner
                )
            })
            .into_iter()
            .map(String::from)
            .collect()
    };

    // Anti-vacuity: the same per-table pipeline flags that table's synthetic writer (and, the
    // census being per table, NOT the other two tables' writers).
    let mut injected_sources = census::real_sources().expect("real_sources must read the crate");
    injected_sources.push((String::from("synth"), fixture_synthetic_retired_writers()));
    for table in RETIRED_1V1_TABLES {
        let only: BTreeSet<&str> = [*table].into_iter().collect();
        let injected = census::census(&injected_sources, &only, no_owners)
            .expect("the real corpus plus the synthetic writers must census cleanly");
        let flagged = writers(&injected);
        for other in RETIRED_1V1_TABLES {
            let name = format!("synth_bt17_writes_{other}");
            assert_eq!(
                flagged.contains(&name),
                other == table,
                "the {table} census must flag exactly its own synthetic writer ({name}); \
                 flagged: {flagged:?}"
            );
        }
    }

    let sources = census::real_sources().expect("real_sources must read the crate");
    let per_table = |table: &str| -> (BTreeSet<String>, Vec<String>) {
        let only: BTreeSet<&str> = [table].into_iter().collect();
        let report = census::census(&sources, &only, no_owners)
            .expect("the real corpus must census cleanly");
        let set = writers(&report);
        let described = set
            .iter()
            .map(|name| format!("{name}: {}", describe_verdict(&report, name)))
            .collect();
        (set, described)
    };

    let (deadline, deadline_desc) = per_table("pvp_deadline_schedule");
    assert!(
        deadline.is_empty(),
        "(a) no reducer may reach pvp_deadline_schedule (BT17.1: the 1v1 secret-pick deadline is \
         armed by nothing); reached by: {deadline_desc:#?}"
    );

    let sweepers: BTreeSet<String> = BT17_BATTLE_WILD_SWEEPERS
        .iter()
        .map(|s| String::from(*s))
        .collect();

    // Measured on the purged tree (orchestrator correction, disclosed; the tester pre-authorised
    // "pin that set the same way as (c)" if a settle path reached this table too): the tactical
    // settle funnel reaches `pvp::settle_pvp_battle`, whose stale-action sweep deletes the finished
    // battle's `battle_action` rows, so the same four reducers reach it — a delete, never a new row.
    let (action, action_desc) = per_table("battle_action");
    assert_eq!(
        action, sweepers,
        "(b) battle_action is reached by EXACTLY the tactical reducers whose terminal path runs \
         tactics::finish -> tactics_settle::settle -> pvp::settle_pvp_battle (its stale-action delete, \
         not a new row — the 1v1 action log gains no row, BT17.1); reached by: {action_desc:#?}"
    );

    let (wild, wild_desc) = per_table("battle_wild");
    assert_eq!(
        wild, sweepers,
        "(c) battle_wild is reached by EXACTLY the tactical reducers whose terminal path runs \
         tactics::finish -> tactics_settle::settle -> battle::sweep_prior_terminals (a delete of \
         the finished anchor's roster, not a new row); reached by: {wild_desc:#?}"
    );

    for name in BT17_RETIRED_1V1_REDUCERS {
        for (table, set) in [
            ("pvp_deadline_schedule", &deadline),
            ("battle_action", &action),
            ("battle_wild", &wild),
        ] {
            assert!(
                !set.contains(*name),
                "(d) the retired 1v1 reducer {name} still reaches {table}: it must no longer be a \
                 reducer (BT17.1)"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Trade-session privacy, read from the GENERATED module definition
// (the artifact the host consumes) and through the shipped view entry point.
// ---------------------------------------------------------------------------

/// The trade-session tables and their one read path.
const TS2_SESSION_TABLES: [&str; 3] = [
    "trade_session",
    "trade_session_snapshot",
    "trade_session_reaper_schedule",
];
const TS2_SESSION_VIEW: &str = "my_trade_session";

/// The row a view serves, from its generated return type (`Vec<T>` or the
/// `some` arm of an `Option<T>`): the typespace ref of `T` when it is one, and
/// `T`'s column names in order.
fn ts2_view_row(
    ts: &spacetimedb::sats::Typespace,
    ret: &spacetimedb::sats::AlgebraicType,
    view: &str,
) -> (Option<spacetimedb::sats::AlgebraicTypeRef>, Vec<String>) {
    use spacetimedb::sats::AlgebraicType;
    let resolve = |ty: &AlgebraicType| -> AlgebraicType {
        match ty {
            AlgebraicType::Ref(r) => ts[*r].clone(),
            other => other.clone(),
        }
    };
    let elem: AlgebraicType = match resolve(ret) {
        AlgebraicType::Array(a) => {
            let e: &AlgebraicType = &a.elem_ty;
            e.clone()
        }
        AlgebraicType::Sum(s) => {
            let Some(some) = s
                .variants
                .iter()
                .find(|v| v.name.as_deref() == Some("some"))
            else {
                panic!("[ts2/view-return-shape] `{view}` returns a sum with no `some` arm")
            };
            some.algebraic_type.clone()
        }
        other => panic!(
            "[ts2/view-return-shape] `{view}` returns {other:?}: neither Vec<T> nor Option<T>"
        ),
    };
    let row_ref = match &elem {
        AlgebraicType::Ref(r) => Some(*r),
        _ => None,
    };
    let AlgebraicType::Product(p) = resolve(&elem) else {
        panic!("[ts2/view-return-shape] `{view}`'s row type is not a product")
    };
    let columns = p
        .elements
        .iter()
        .map(|e| e.name.as_deref().unwrap_or("").to_string())
        .collect();
    (row_ref, columns)
}

/// In the generated module definition the three trade-session
/// tables are PRIVATE, and the only view over session data is
/// `my_trade_session`: public, caller-scoped, parameterless, serving exactly
/// the `trade_session` row. No view is named for, or serves the row of, the
/// snapshot table or the schedule table — whether by the table's own row type
/// or by a look-alike row carrying its key columns.
///
/// Kills: `public` on `trade_session` (every client would receive every
/// session) or on `trade_session_snapshot` (every offered monster's hidden
/// genes); a view over the snapshot or schedule table; a second view over
/// session rows; `my_trade_session` taking a parameter (a caller-chosen
/// participant is a leak) or anonymous (it cannot know its caller); the view
/// re-typed to serve another row.
#[test]
fn ts2_privacy_session_tables_are_private() {
    use spacetimedb::spacetimedb_lib::db::raw_def::v9::TableAccess;
    let fx = crate::native_host_tests::fixture();
    let def = fx.module_def();
    let tables = def.tables().unwrap_or_else(|| {
        panic!("[ts2/describe-tables] the generated module def carries no Tables section")
    });
    let ts = def.typespace().unwrap_or_else(|| {
        panic!("[ts2/describe-typespace] the generated module def carries no typespace")
    });
    let mut row_refs = Vec::new();
    for name in TS2_SESSION_TABLES {
        let Some(t) = tables.iter().find(|t| &*t.source_name == name) else {
            panic!("[ts2/table-missing] `{name}` is not a table of the generated module def")
        };
        assert_eq!(
            t.table_access,
            TableAccess::Private,
            "[ts2/table-private] `{name}` must be PRIVATE: sessions are read only through \
             `{TS2_SESSION_VIEW}` by their two participants, and snapshots and schedules by no \
             client at all"
        );
        row_refs.push((name, t.product_type_ref));
    }
    let session_ref = row_refs[0].1;

    let views = def.views().unwrap_or_else(|| {
        panic!("[ts2/describe-views] the generated module def carries no Views section")
    });
    let mut over_sessions: Vec<String> = Vec::new();
    for v in views {
        let name = v.source_name.to_string();
        for banned in ["snapshot", "schedule"] {
            assert!(
                !name.contains(banned),
                "[ts2/no-child-view] `{name}` names `{banned}`: the session snapshot and \
                 schedule tables have no view"
            );
        }
        let (row_ref, columns) = ts2_view_row(ts, &v.return_type, &name);
        for (table, table_ref) in &row_refs[1..] {
            assert_ne!(
                row_ref,
                Some(*table_ref),
                "[ts2/no-child-view] `{name}` serves `{table}` rows"
            );
        }
        let has = |col: &str| columns.iter().any(|c| c == col);
        assert!(
            !has("snapshot_id"),
            "[ts2/no-child-view] `{name}` serves a snapshot-shaped row: {columns:?}"
        );
        assert!(
            !(has("scheduled_at") && has("session_id")),
            "[ts2/no-child-view] `{name}` serves a session-schedule-shaped row: {columns:?}"
        );
        if row_ref == Some(session_ref) || has("session_id") {
            over_sessions.push(name);
        }
    }
    assert_eq!(
        over_sessions,
        [TS2_SESSION_VIEW],
        "[ts2/one-session-view] the only view over trade-session data"
    );

    let Some(v) = views.iter().find(|v| &*v.source_name == TS2_SESSION_VIEW) else {
        panic!("[ts2/view-missing] `{TS2_SESSION_VIEW}`")
    };
    assert!(
        v.is_public,
        "[ts2/view-public] `{TS2_SESSION_VIEW}` is public"
    );
    assert!(
        !v.is_anonymous,
        "[ts2/view-caller-scoped] `{TS2_SESSION_VIEW}` must know its caller (ViewContext)"
    );
    assert!(
        v.params.elements.is_empty(),
        "[ts2/view-no-params] `{TS2_SESSION_VIEW}` takes parameters — a caller-chosen \
         participant is a leak"
    );
    let (row_ref, columns) = ts2_view_row(ts, &v.return_type, TS2_SESSION_VIEW);
    assert_eq!(
        row_ref,
        Some(session_ref),
        "[ts2/view-row] `{TS2_SESSION_VIEW}` serves exactly the `trade_session` row"
    );
    assert_eq!(
        columns,
        [
            "session_id",
            "opener",
            "partner",
            "opener_offer",
            "partner_offer",
            "opener_confirmed",
            "partner_confirmed",
            "revision",
            "created_at_ms",
        ],
        "[ts2/view-row] `{TS2_SESSION_VIEW}`'s row columns, in order"
    );
}

/// Through the SHIPPED view entry point, `my_trade_session` returns
/// to each caller exactly the sessions it opened or was opened with, each
/// once, full row values, and nothing to a stranger. Sessions: 8001 A→B,
/// 8002 C→A, 8003 C→D (each row's offers, revision and stamp differ).
///
/// Kills: an empty body; one arm only (the opener arm drops 8002
/// for A and every session for B and D; the partner arm drops 8001 for A and
/// every session for C); an arm keyed on the wrong column; a view serving
/// every session (a full-table scan of a private table — the host refuses
/// it, and a stranger would see all three); the two arms chained with a
/// filter that drops a caller's own rows.
#[test]
fn ts2_privacy_my_trade_session_shows_only_the_two_participants() {
    use crate::schema::TradeSession;
    use spacetimedb::sats::bsatn;
    use spacetimedb::Identity;

    let fx = crate::native_host_tests::fixture();
    let view_id = {
        let def = fx.module_def();
        let views = def.views().unwrap_or_else(|| {
            panic!("[ts2/describe-views] the generated module def carries no Views section")
        });
        let Some(v) = views.iter().find(|v| &*v.source_name == TS2_SESSION_VIEW) else {
            panic!(
                "[ts2/view-missing] `{TS2_SESSION_VIEW}` is not a view of the generated module \
                 def, so the runtime cannot serve it"
            )
        };
        usize::try_from(v.index).expect("a view index fits a usize")
    };

    let sessions = fx.table::<TradeSession>("trade_session", "opener", |r| r.opener);
    let _ = fx.table::<TradeSession>("trade_session", "partner", |r| r.partner);
    let id = |b: u8| Identity::from_byte_array([b; 32]);
    let (a, b, c, d, e) = (id(0xE1), id(0xE2), id(0xE3), id(0xE4), id(0xE5));
    let row = |session_id: u64, opener: Identity, partner: Identity| {
        let opener_offer = game_core::trading::TradeSessionOffer {
            currency: session_id,
            ..Default::default()
        };
        let partner_offer = game_core::trading::TradeSessionOffer {
            monster_ids: vec![session_id * 10],
            ..Default::default()
        };
        TradeSession {
            session_id,
            opener,
            partner,
            opener_offer,
            partner_offer,
            opener_confirmed: session_id.is_multiple_of(2),
            partner_confirmed: false,
            revision: session_id - 8000,
            created_at_ms: 1_700_000_000_000 + session_id as i64,
        }
    };
    let s1 = row(8001, a, b);
    let s2 = row(8002, c, a);
    let s3 = row(8003, c, d);
    for s in [&s1, &s2, &s3] {
        sessions.seed(s);
    }

    let encs = |rows: &[TradeSession]| -> Vec<Vec<u8>> {
        let mut out: Vec<Vec<u8>> = rows
            .iter()
            .map(|r| bsatn::to_vec(r).expect("a row always BSATN-encodes"))
            .collect();
        out.sort();
        out
    };
    let cases: [(&str, Identity, Vec<TradeSession>); 5] = [
        (
            "A (opener of 8001, partner of 8002)",
            a,
            vec![s1.clone(), s2.clone()],
        ),
        ("B (partner of 8001)", b, vec![s1.clone()]),
        (
            "C (opener of 8002 and 8003)",
            c,
            vec![s2.clone(), s3.clone()],
        ),
        ("D (partner of 8003)", d, vec![s3.clone()]),
        ("E (a stranger)", e, vec![]),
    ];
    for (label, who, want) in cases {
        let got: Vec<TradeSession> = fx.call_view::<TradeSession>(view_id, who);
        assert_eq!(
            got.len(),
            want.len(),
            "[ts2/view-participants] {label}: each of its sessions exactly once, nobody else's"
        );
        assert_eq!(
            encs(&got),
            encs(&want),
            "[ts2/view-participants] {label}: exactly its own sessions, full row values"
        );
    }
}
